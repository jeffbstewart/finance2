package net.stewart.finance.api

import com.google.protobuf.InvalidProtocolBufferException
import io.grpc.Status
import io.grpc.StatusException
import java.time.LocalDate
import net.stewart.bankferry.proto.Account as PlaidAccount
import net.stewart.bankferry.proto.InvestmentsSnapshot
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.AccountRow
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.PlaidAccountLinkRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.SnapshotRecord
import net.stewart.finance.db.SnapshotRepository
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.EntrySource
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SnapshotId
import net.stewart.finance.domain.SnapshotStatus
import net.stewart.finance.proto.ImportReport
import net.stewart.finance.proto.ReportLine
import net.stewart.finance.proto.ReportSeverity
import net.stewart.finance.rules.Lot
import net.stewart.finance.rules.Sale
import net.stewart.finance.rules.SaleAllocation
import net.stewart.finance.rules.lotState

/** The one snapshot schema this reader understands. */
const val SUPPORTED_SNAPSHOT_SCHEMA = 1

/**
 * The bankferry snapshot importer (pipeline design §E, amended
 * 2026-08-20). Upload archives verbatim after validation; processing
 * is separate and freely repeatable — build-scope §1 semantics:
 * tax-deferred holdings and sweeps are written with plaid provenance,
 * taxable accounts are compared and reported, never mutated. Unknown
 * tickers are flagged for the human to add by hand (§6.3 — no
 * auto-creation), then re-process.
 */
class SnapshotImportService(
    private val snapshots: SnapshotRepository,
    private val links: PlaidAccountLinkRepository,
    private val accounts: AccountRepository,
    private val securities: SecurityRepository,
    private val holdings: HoldingRepository,
    private val lots: LotRepository,
    private val sales: SaleRepository,
) {

    /** Validates and archives; mutates nothing else. */
    fun upload(portfolioId: PortfolioId, filename: String, content: ByteArray): SnapshotRecord {
        if (content.isEmpty()) throw invalid("the uploaded file is empty")
        val snapshot = parse(content)
        if (snapshot.schemaVersion != SUPPORTED_SNAPSHOT_SCHEMA) {
            throw invalid(
                "snapshot schema v${snapshot.schemaVersion}; this server reads " +
                    "v$SUPPORTED_SNAPSHOT_SCHEMA — update whichever side is behind"
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
     * records the outcome — PROCESSED with the report, or FAILED with
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

    private fun runProcessing(
        portfolioId: PortfolioId,
        snapshot: InvestmentsSnapshot,
        asOf: LocalDate,
    ): ImportReport {
        val builder = ImportReport.newBuilder()
        val linkMap = links.all()
        val securitiesByTicker = securities.list(portfolioId, includeHidden = true)
            .filter { it.ticker.isNotBlank() }
            .associateBy { it.ticker.uppercase() }
        var holdingsUpdated = 0
        var sweepsUpdated = 0

        for (item in snapshot.itemsList) {
            for (plaidAccount in item.accountsList) {
                val label = "${item.institutionEntry} \"${plaidAccount.name}\"" +
                    (plaidAccount.mask.takeIf { it.isNotEmpty() }?.let { " …$it" } ?: "")
                val linkedId = linkMap[plaidAccount.accountRef]
                if (linkedId == null) {
                    builder.addLines(
                        line(ReportSeverity.WARNING, "$label is not linked to an account — link it and re-process")
                    )
                    continue
                }
                val account = accounts.find(linkedId, portfolioId)
                if (account == null) {
                    builder.addLines(
                        line(ReportSeverity.WARNING, "$label links to a deleted account — re-link it")
                    )
                    continue
                }
                if (account.taxDeferred) {
                    val counts = importTaxDeferred(
                        builder, label, plaidAccount, account, securitiesByTicker, asOf, portfolioId,
                    )
                    holdingsUpdated += counts.first
                    sweepsUpdated += counts.second
                } else {
                    compareTaxable(builder, label, plaidAccount, account, securitiesByTicker, portfolioId)
                }
            }
        }
        return builder
            .setHoldingsUpdated(holdingsUpdated)
            .setSweepsUpdated(sweepsUpdated)
            .build()
    }

    /** Build-scope §1: position-level quantities + sweep, plaid provenance. */
    private fun importTaxDeferred(
        report: ImportReport.Builder,
        label: String,
        plaidAccount: PlaidAccount,
        account: AccountRow,
        securitiesByTicker: Map<String, net.stewart.finance.db.SecurityRow>,
        asOf: LocalDate,
        portfolioId: PortfolioId,
    ): Pair<Int, Int> {
        var holdingsUpdated = 0
        var sweepsUpdated = 0
        var cashFromHoldings: Money? = null
        val seenTickers = mutableSetOf<String>()

        for (holding in plaidAccount.holdingsList) {
            if (holding.security.isCashEquivalent) {
                val value = moneyOf(holding.institutionValue, account.currency)
                if (value != null) {
                    cashFromHoldings = (cashFromHoldings ?: Money.zero(account.currency)) + value
                }
                continue
            }
            val ticker = holding.security.ticker.trim().uppercase()
            if (ticker.isEmpty()) {
                report.addLines(
                    line(
                        ReportSeverity.WARNING,
                        "$label: \"${holding.security.name}\" has no ticker — cannot match; held ${holding.quantity.value}"
                    )
                )
                continue
            }
            val security = securitiesByTicker[ticker]
            if (security == null) {
                report.addLines(
                    line(ReportSeverity.WARNING, "$label: ticker $ticker is not a known security — add it by hand and re-process")
                )
                continue
            }
            if (security.currency != account.currency) {
                report.addLines(
                    line(
                        ReportSeverity.WARNING,
                        "$label: $ticker is ${security.currency} but the account is ${account.currency} — skipped"
                    )
                )
                continue
            }
            val quantity = try {
                Quantity.of(holding.quantity.value)
            } catch (e: Exception) {
                report.addLines(
                    line(ReportSeverity.WARNING, "$label: $ticker quantity \"${holding.quantity.value}\" is not a valid share count")
                )
                continue
            }
            holdings.upsert(account.id, security.id, quantity, EntrySource.PLAID, asOf)
            seenTickers += ticker
            holdingsUpdated++
        }

        // Holdings the institution no longer reports stay put — flag
        // them so the human decides (delete by hand if truly gone).
        for (existing in holdings.list(portfolioId, account.id)) {
            val security = securities.find(existing.securityId, portfolioId) ?: continue
            if (security.ticker.uppercase() !in seenTickers) {
                report.addLines(
                    line(
                        ReportSeverity.WARNING,
                        "$label: ${security.ticker} is held here but absent from the snapshot — delete the holding by hand if it was sold"
                    )
                )
            }
        }

        val cash = moneyOf(plaidAccount.cashBalance, account.currency) ?: cashFromHoldings
        if (cash != null) {
            accounts.updateSweep(account.id, cash, EntrySource.PLAID, asOf)
            sweepsUpdated++
            report.addLines(line(ReportSeverity.INFO, "$label: sweep set to ${cash.display()}"))
        }
        report.addLines(line(ReportSeverity.INFO, "$label: $holdingsUpdated holding(s) updated"))
        return holdingsUpdated to sweepsUpdated
    }

    /** Taxable accounts: compare institution quantities against the
     *  hand-maintained lots; never mutate (build-scope §1, §11 v1 ruling). */
    private fun compareTaxable(
        report: ImportReport.Builder,
        label: String,
        plaidAccount: PlaidAccount,
        account: AccountRow,
        securitiesByTicker: Map<String, net.stewart.finance.db.SecurityRow>,
        portfolioId: PortfolioId,
    ) {
        var matches = 0
        for (holding in plaidAccount.holdingsList) {
            if (holding.security.isCashEquivalent) continue
            val ticker = holding.security.ticker.trim().uppercase()
            if (ticker.isEmpty()) continue
            val security = securitiesByTicker[ticker]
            if (security == null) {
                report.addLines(
                    line(ReportSeverity.WARNING, "$label: ticker $ticker is not a known security — add it by hand and re-process")
                )
                continue
            }
            val institutionQuantity = try {
                Quantity.of(holding.quantity.value)
            } catch (e: Exception) {
                report.addLines(
                    line(ReportSeverity.WARNING, "$label: $ticker quantity \"${holding.quantity.value}\" is not a valid share count")
                )
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
                report.addLines(
                    line(
                        ReportSeverity.WARNING,
                        "$label: $ticker — institution reports ${holding.quantity.value} shares, " +
                            "lots hold ${stillHeld.amount.stripTrailingZeros().toPlainString()} " +
                            "(taxable accounts are never changed by imports; reconcile the lots by hand)"
                    )
                )
            }
        }
        report.addLines(line(ReportSeverity.INFO, "$label: taxable — compared only; $matches position(s) match"))
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

    private fun line(severity: ReportSeverity, message: String): ReportLine =
        ReportLine.newBuilder().setSeverity(severity).setMessage(message).build()

    private fun invalid(message: String) =
        StatusException(Status.INVALID_ARGUMENT.withDescription(message))
}
