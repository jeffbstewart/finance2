package net.stewart.finance.api

import com.google.protobuf.InvalidProtocolBufferException
import io.grpc.Status
import io.grpc.StatusException
import java.time.LocalDate
import net.stewart.bankferry.proto.Account as PlaidAccount
import net.stewart.bankferry.proto.Holding
import net.stewart.bankferry.proto.InvestmentsSnapshot
import net.stewart.bankferry.proto.SecurityRef
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.AccountRow
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.PlaidAccountLinkRepository
import net.stewart.finance.db.PlaidSecurityLinkRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.db.SnapshotRecord
import net.stewart.finance.db.SnapshotRepository
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.EntrySource
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.SnapshotId
import net.stewart.finance.domain.SnapshotStatus
import net.stewart.finance.proto.ImportReport
import net.stewart.finance.proto.ReportLine
import net.stewart.finance.proto.ReportSeverity
import net.stewart.finance.rules.Lot
import net.stewart.finance.rules.Sale
import net.stewart.finance.rules.SaleAllocation
import net.stewart.finance.rules.lotState

/** One report warning tied to the account it concerns. */
data class AttributedWarning(
    val snapshotId: SnapshotId,
    val asOf: LocalDate,
    val account: AccountRow,
    val message: String,
)

/** Provenance recorded on private prices written by the importer. */
const val PLAID_PRICE_SOURCE = "plaid"

/** How a snapshot security resolved to a finance2 security. */
enum class SecurityMatch { BY_TICKER, BY_LINK, UNMATCHED }

/** One distinct non-cash security a snapshot holds, with its match. */
data class SnapshotSecurity(
    val ref: SecurityRef,
    val accountCount: Int,
    val match: SecurityMatch,
    val security: SecurityRow?,
)

/** The one snapshot schema this reader understands. */
const val SUPPORTED_SNAPSHOT_SCHEMA = 1

/**
 * The bankferry snapshot importer (pipeline design sec. E, amended
 * 2026-08-20). Upload archives verbatim after validation; processing
 * is separate and freely repeatable - build-scope sec. 1 semantics:
 * tax-deferred holdings and sweeps are written with plaid provenance,
 * taxable accounts are compared and reported, never mutated. Unknown
 * tickers are flagged for the human to add by hand (sec. 6.3 - no
 * auto-creation), then re-process. Securities Plaid reports without a
 * ticker (401(k) trust funds) match only through a human-made link;
 * matched MANUAL-locus securities get the institution price recorded
 * as a private price, since nothing else will ever price them.
 */
class SnapshotImportService(
    private val snapshots: SnapshotRepository,
    private val links: PlaidAccountLinkRepository,
    private val accounts: AccountRepository,
    private val securities: SecurityRepository,
    private val holdings: HoldingRepository,
    private val lots: LotRepository,
    private val sales: SaleRepository,
    private val securityLinks: PlaidSecurityLinkRepository,
    private val privatePrices: PrivatePriceRepository,
) {

    /** Validates and archives; mutates nothing else. */
    fun upload(portfolioId: PortfolioId, filename: String, content: ByteArray): SnapshotRecord {
        if (content.isEmpty()) throw invalid("the uploaded file is empty")
        val snapshot = parse(content)
        if (snapshot.schemaVersion != SUPPORTED_SNAPSHOT_SCHEMA) {
            throw invalid(
                "snapshot schema v${snapshot.schemaVersion}; this server reads " +
                    "v$SUPPORTED_SNAPSHOT_SCHEMA - update whichever side is behind"
            )
        }
        val asOf = try {
            LocalDate.of(snapshot.asOf.year, snapshot.asOf.month, snapshot.asOf.day)
        } catch (e: Exception) {
            throw invalid("snapshot as_of is not a valid date")
        }
        val id = snapshots.create(
            portfolioId,
            filename.trim().ifEmpty { "snapshot.pb" }.take(255),
            content,
            snapshot.schemaVersion,
            asOf,
        )
        return checkNotNull(snapshots.find(id, portfolioId))
    }

    /**
     * Runs (or re-runs) processing against the archived bytes and
     * records the outcome - PROCESSED with the report, or FAILED with
     * the error.
     */
    fun process(portfolioId: PortfolioId, id: SnapshotId): SnapshotRecord {
        val record = snapshots.find(id, portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no snapshot ${id.value}"))
        val content = checkNotNull(snapshots.content(id, portfolioId))
        val report = try {
            runProcessing(portfolioId, parse(content), record.asOf)
        } catch (e: Exception) {
            val failure = ImportReport.newBuilder()
                .addLines(line(ReportSeverity.WARNING, "processing failed: ${e.message}"))
                .build()
            snapshots.recordProcessing(id, SnapshotStatus.FAILED, failure.toByteArray())
            return checkNotNull(snapshots.find(id, portfolioId))
        }
        snapshots.recordProcessing(id, SnapshotStatus.PROCESSED, report.toByteArray())
        return checkNotNull(snapshots.find(id, portfolioId))
    }

    /** The accounts a snapshot carries, with their link state. */
    fun snapshotAccounts(
        portfolioId: PortfolioId,
        id: SnapshotId,
    ): List<Triple<String, PlaidAccount, AccountRow?>> {
        val content = snapshots.content(id, portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no snapshot ${id.value}"))
        val linkMap = links.all()
        val result = mutableListOf<Triple<String, PlaidAccount, AccountRow?>>()
        for (item in parse(content).itemsList) {
            for (account in item.accountsList) {
                val linked = linkMap[account.accountRef]?.let { accounts.find(it, portfolioId) }
                result += Triple(item.institutionEntry, account, linked)
            }
        }
        return result
    }

    /** The distinct non-cash securities a snapshot holds, with how each matches. */
    fun snapshotSecurities(portfolioId: PortfolioId, id: SnapshotId): List<SnapshotSecurity> {
        val content = snapshots.content(id, portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no snapshot ${id.value}"))
        val index = securityIndex(portfolioId)
        val seen = linkedMapOf<String, Pair<SecurityRef, MutableSet<String>>>()
        for (item in parse(content).itemsList) {
            for (account in item.accountsList) {
                for (holding in account.holdingsList) {
                    if (holding.security.isCashEquivalent) continue
                    val key = holding.security.plaidSecurityId.ifEmpty { "name:${holding.security.name}" }
                    seen.getOrPut(key) { holding.security to mutableSetOf() }.second += account.accountRef
                }
            }
        }
        return seen.values.map { (ref, accounts) ->
            val (match, security) = index.resolve(ref)
            SnapshotSecurity(ref, accounts.size, match, security)
        }
    }

    /**
     * The warnings the most recent processing run left against real
     * accounts - what the broker and account views show so the human
     * is prompted to fix lots, add securities, or delete holdings.
     * Lines with no account (unlinked Plaid accounts, a failed run)
     * belong only on the Imports page. Accounts deleted since the run
     * are dropped. Empty until something has been processed.
     */
    fun latestWarnings(portfolioId: PortfolioId): List<AttributedWarning> {
        val record = snapshots.latestProcessed(portfolioId) ?: return emptyList()
        val report = ImportReport.parseFrom(record.report ?: return emptyList())
        val accountCache = mutableMapOf<AccountId, AccountRow?>()
        return report.linesList
            .filter { it.severity == ReportSeverity.WARNING && it.accountId != 0L }
            .mapNotNull { line ->
                val id = AccountId(line.accountId)
                val account = accountCache.getOrPut(id) { accounts.find(id, portfolioId) }
                    ?: return@mapNotNull null
                AttributedWarning(record.id, record.asOf, account, line.message)
            }
    }

    private fun runProcessing(
        portfolioId: PortfolioId,
        snapshot: InvestmentsSnapshot,
        asOf: LocalDate,
    ): ImportReport {
        val builder = ImportReport.newBuilder()
        val linkMap = links.all()
        val index = securityIndex(portfolioId)
        var holdingsUpdated = 0
        var sweepsUpdated = 0
        var pricesRecorded = 0

        for (item in snapshot.itemsList) {
            for (plaidAccount in item.accountsList) {
                val label = "${item.institutionEntry} \"${plaidAccount.name}\"" +
                    (plaidAccount.mask.takeIf { it.isNotEmpty() }?.let { " ...$it" } ?: "")
                val linkedId = linkMap[plaidAccount.accountRef]
                if (linkedId == null) {
                    builder.addLines(
                        line(ReportSeverity.WARNING, "$label is not linked to an account - link it and re-process")
                    )
                    continue
                }
                val account = accounts.find(linkedId, portfolioId)
                if (account == null) {
                    builder.addLines(
                        line(ReportSeverity.WARNING, "$label links to a deleted account - re-link it")
                    )
                    continue
                }
                if (account.taxDeferred) {
                    val counts = importTaxDeferred(builder, label, plaidAccount, account, index, asOf, portfolioId)
                    holdingsUpdated += counts.first
                    sweepsUpdated += counts.second
                } else {
                    compareTaxable(builder, label, plaidAccount, account, index, portfolioId)
                }
                pricesRecorded += recordInstitutionPrices(builder, label, plaidAccount, account, index, asOf)
            }
        }
        return builder
            .setHoldingsUpdated(holdingsUpdated)
            .setSweepsUpdated(sweepsUpdated)
            .setPricesRecorded(pricesRecorded)
            .build()
    }

    /** Build-scope sec. 1: position-level quantities + sweep, plaid provenance. */
    private fun importTaxDeferred(
        report: ImportReport.Builder,
        label: String,
        plaidAccount: PlaidAccount,
        account: AccountRow,
        index: SecurityIndex,
        asOf: LocalDate,
        portfolioId: PortfolioId,
    ): Pair<Int, Int> {
        fun warn(message: String) = report.addLines(line(ReportSeverity.WARNING, message, account.id))
        fun info(message: String) = report.addLines(line(ReportSeverity.INFO, message, account.id))
        var holdingsUpdated = 0
        var sweepsUpdated = 0
        val seenSecurities = mutableSetOf<SecurityId>()

        for (holding in plaidAccount.holdingsList) {
            if (holding.security.isCashEquivalent) continue
            val security = index.resolve(holding.security).second
            if (security == null) {
                warn(unmatched(label, holding))
                continue
            }
            if (security.currency != account.currency) {
                warn("$label: ${security.ticker} is ${security.currency} but the account is ${account.currency} - skipped")
                continue
            }
            val quantity = try {
                Quantity.of(holding.quantity.value)
            } catch (e: Exception) {
                warn("$label: ${security.ticker} quantity \"${holding.quantity.value}\" is not a valid share count")
                continue
            }
            holdings.upsert(account.id, security.id, quantity, EntrySource.PLAID, asOf)
            seenSecurities += security.id
            holdingsUpdated++
        }

        // Holdings the institution no longer reports stay put - flag
        // them so the human decides (delete by hand if truly gone).
        for (existing in holdings.list(portfolioId, account.id)) {
            val security = securities.find(existing.securityId, portfolioId) ?: continue
            if (security.id !in seenSecurities) {
                warn("$label: ${security.ticker} is held here but absent from the snapshot - delete the holding by hand if it was sold")
            }
        }

        val cash = sweepOf(plaidAccount, account, ::info, ::warn)
        if (cash != null) {
            accounts.updateSweep(account.id, cash, EntrySource.PLAID, asOf)
            sweepsUpdated++
            info("$label: sweep set to ${cash.display()}")
        }
        info("$label: $holdingsUpdated holding(s) updated")
        return holdingsUpdated to sweepsUpdated
    }

    /**
     * The account's cash, as far as the snapshot can be trusted.
     * bankferry fills cash_balance from Plaid's *available* balance,
     * which a 401(k) reports as the whole account - so it is believed
     * only when it is less than the account value (or nothing but cash
     * is held). Otherwise: the cash-equivalent holdings, else the
     * account value less every valued holding, else nothing.
     */
    private fun sweepOf(
        plaidAccount: PlaidAccount,
        account: AccountRow,
        info: (String) -> Unit,
        warn: (String) -> Unit,
    ): Money? {
        val currency = account.currency
        val reported = moneyOf(plaidAccount.cashBalance, currency)
        val total = moneyOf(plaidAccount.institutionValue, currency)
        var cashEquivalents: Money? = null
        var nonCashValue = Money.zero(currency)
        var nonCashHeld = false
        var everyNonCashValued = true
        for (holding in plaidAccount.holdingsList) {
            val value = moneyOf(holding.institutionValue, currency)
            if (holding.security.isCashEquivalent) {
                if (value != null) cashEquivalents = (cashEquivalents ?: Money.zero(currency)) + value
            } else {
                nonCashHeld = true
                if (value == null) everyNonCashValued = false else nonCashValue += value
            }
        }
        val reportedIsCash = reported != null && (!nonCashHeld || total == null || reported < total)
        return when {
            reportedIsCash -> reported
            cashEquivalents != null -> cashEquivalents
            total != null && nonCashHeld && everyNonCashValued && (total - nonCashValue).signum() >= 0 -> {
                info(
                    "cash balance ${reported?.display() ?: "(absent)"} is not cash (it is the whole account); " +
                        "sweep derived as account value ${total.display()} less holdings"
                )
                total - nonCashValue
            }
            else -> {
                if (reported != null) {
                    warn("cash balance ${reported.display()} is the whole account, not cash - sweep left unchanged; set it by hand")
                }
                null
            }
        }
    }

    /**
     * Records the institution price of every matched MANUAL-locus
     * security as a private price on the institution's price date
     * (else the snapshot date), with plaid provenance - trust funds
     * have no market feed, so this is the only price they will get.
     * One line per account, not per holding. Applies to taxable
     * accounts too: prices belong to the security, not the account.
     */
    private fun recordInstitutionPrices(
        report: ImportReport.Builder,
        label: String,
        plaidAccount: PlaidAccount,
        account: AccountRow,
        index: SecurityIndex,
        asOf: LocalDate,
    ): Int {
        var recorded = 0
        for (holding in plaidAccount.holdingsList) {
            if (holding.security.isCashEquivalent) continue
            val security = index.resolve(holding.security).second ?: continue
            if (security.pricingLocus != PricingLocus.MANUAL) continue
            val price = moneyOf(holding.institutionPrice, security.currency) ?: continue
            val date = if (holding.hasPriceAsOf()) {
                try {
                    LocalDate.of(holding.priceAsOf.year, holding.priceAsOf.month, holding.priceAsOf.day)
                } catch (e: Exception) {
                    asOf
                }
            } else {
                asOf
            }
            privatePrices.upsert(security.id, date, price, PLAID_PRICE_SOURCE)
            recorded++
        }
        if (recorded > 0) {
            report.addLines(line(ReportSeverity.INFO, "$label: $recorded institution price(s) recorded", account.id))
        }
        return recorded
    }

    private fun unmatched(label: String, holding: Holding): String {
        val ref = holding.security
        return if (ref.ticker.isBlank()) {
            "$label: \"${ref.name}\" has no ticker - link it to a finance2 security on the Import screen " +
                "and re-process; held ${holding.quantity.value}"
        } else {
            "$label: ticker ${ref.ticker.trim().uppercase()} is not a known security - add it by hand " +
                "(or link it on the Import screen) and re-process"
        }
    }

    /** Ticker first; else the human's link. */
    private inner class SecurityIndex(rows: List<SecurityRow>, private val links: Map<String, SecurityId>) {
        private val byTicker = rows.filter { it.ticker.isNotBlank() }.associateBy { it.ticker.uppercase() }
        private val byId = rows.associateBy { it.id }

        fun resolve(ref: SecurityRef): Pair<SecurityMatch, SecurityRow?> {
            val ticker = ref.ticker.trim().uppercase()
            if (ticker.isNotEmpty()) byTicker[ticker]?.let { return SecurityMatch.BY_TICKER to it }
            if (ref.plaidSecurityId.isNotEmpty()) {
                links[ref.plaidSecurityId]?.let { id -> byId[id]?.let { return SecurityMatch.BY_LINK to it } }
            }
            return SecurityMatch.UNMATCHED to null
        }
    }

    private fun securityIndex(portfolioId: PortfolioId) =
        SecurityIndex(securities.list(portfolioId, includeHidden = true), securityLinks.all())

    /** Taxable accounts: compare institution quantities against the
     *  hand-maintained lots; never mutate (build-scope sec. 1, sec. 11 v1 ruling). */
    private fun compareTaxable(
        report: ImportReport.Builder,
        label: String,
        plaidAccount: PlaidAccount,
        account: AccountRow,
        index: SecurityIndex,
        portfolioId: PortfolioId,
    ) {
        fun warn(message: String) = report.addLines(line(ReportSeverity.WARNING, message, account.id))
        fun info(message: String) = report.addLines(line(ReportSeverity.INFO, message, account.id))
        var matches = 0
        for (holding in plaidAccount.holdingsList) {
            if (holding.security.isCashEquivalent) continue
            val security = index.resolve(holding.security).second
            if (security == null) {
                warn(unmatched(label, holding))
                continue
            }
            val ticker = security.ticker
            val institutionQuantity = try {
                Quantity.of(holding.quantity.value)
            } catch (e: Exception) {
                warn("$label: $ticker quantity \"${holding.quantity.value}\" is not a valid share count")
                continue
            }
            val lotRecords = lots.list(portfolioId, account.id, security.id)
            val saleRules = sales.list(portfolioId, account.id, security.id).map { sale ->
                Sale(
                    sale.id, sale.saleDate, sale.pricePerShare, sale.saleCosts,
                    sale.allocations.map { (lotId, shares) -> SaleAllocation(lotId, shares) },
                )
            }
            val stillHeld = lotRecords.fold(Quantity.ZERO) { acc, lot ->
                acc + lotState(
                    Lot(lot.id, lot.dateBought, lot.quantity, lot.pricePerShare, lot.purchaseCosts),
                    saleRules,
                ).stillHeld
            }
            if (stillHeld == institutionQuantity) {
                matches++
            } else {
                warn(
                    "$label: $ticker - institution reports ${holding.quantity.value} shares, " +
                    "lots hold ${stillHeld.amount.stripTrailingZeros().toPlainString()} " +
                    "(taxable accounts are never changed by imports; reconcile the lots by hand)"
                )
            }
        }
        info("$label: taxable - compared only; $matches position(s) match")
    }

    private fun parse(content: ByteArray): InvestmentsSnapshot = try {
        InvestmentsSnapshot.parseFrom(content)
    } catch (e: InvalidProtocolBufferException) {
        throw invalid("the file is not a bankferry investments snapshot")
    }

    private fun moneyOf(money: net.stewart.bankferry.proto.Money, currency: CurrencyUnit): Money? {
        val raw = money.amount.value
        if (raw.isBlank()) return null
        if (money.currencyCode.isNotBlank() && money.currencyCode != currency.code) return null
        return try {
            Money.of(raw, currency)
        } catch (e: Exception) {
            null
        }
    }

    /** [account] is the finance2 account the line concerns, when any;
     *  it is what lets the broker and account views show the line. */
    private fun line(severity: ReportSeverity, message: String, account: AccountId? = null): ReportLine {
        val builder = ReportLine.newBuilder().setSeverity(severity).setMessage(message)
        account?.let { builder.setAccountId(it.value) }
        return builder.build()
    }

    private fun invalid(message: String) =
        StatusException(Status.INVALID_ARGUMENT.withDescription(message))
}
