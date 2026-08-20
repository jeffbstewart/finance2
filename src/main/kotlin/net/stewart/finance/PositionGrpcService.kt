package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import java.time.DateTimeException
import java.time.LocalDate
import net.stewart.armeria.auth.currentAuthUser
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.api.provenanceOf
import net.stewart.finance.api.toFormatted
import net.stewart.finance.api.toFormattedDate
import net.stewart.finance.api.toLocalDate
import net.stewart.finance.api.toProto
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.AccountRow
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRecord
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SaleRecord
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.EntrySource
import net.stewart.finance.domain.LotId
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SaleId
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.UserId
import net.stewart.finance.proto.AccountChoice
import net.stewart.finance.proto.AddPurchaseRequest
import net.stewart.finance.proto.AddPurchaseResponse
import net.stewart.finance.proto.DeleteHoldingRequest
import net.stewart.finance.proto.DeleteHoldingResponse
import net.stewart.finance.proto.DeletePurchaseRequest
import net.stewart.finance.proto.DeletePurchaseResponse
import net.stewart.finance.proto.DeleteSaleRequest
import net.stewart.finance.proto.DeleteSaleResponse
import net.stewart.finance.proto.GetLotDetailsRequest
import net.stewart.finance.proto.GetLotDetailsResponse
import net.stewart.finance.proto.GetPurchaseFormInfoRequest
import net.stewart.finance.proto.GetPurchaseFormInfoResponse
import net.stewart.finance.proto.GetTaxReportRequest
import net.stewart.finance.proto.GetTaxReportResponse
import net.stewart.finance.proto.ListPositionsRequest
import net.stewart.finance.proto.ListPositionsResponse
import net.stewart.finance.proto.LotRow
import net.stewart.finance.proto.PositionRow
import net.stewart.finance.proto.PositionServiceGrpcKt
import net.stewart.finance.proto.RecordSaleRequest
import net.stewart.finance.proto.RecordSaleResponse
import net.stewart.finance.proto.SaleRow
import net.stewart.finance.proto.SecurityChoice
import net.stewart.finance.proto.SetHoldingRequest
import net.stewart.finance.proto.SetHoldingResponse
import net.stewart.finance.proto.Sparkline
import net.stewart.finance.proto.TaxReportRow
import net.stewart.finance.proto.UpdatePurchaseRequest
import net.stewart.finance.proto.UpdatePurchaseResponse
import net.stewart.finance.rules.CLOSED_TOLERANCE
import net.stewart.finance.rules.CpiSeries
import net.stewart.finance.rules.Lot
import net.stewart.finance.rules.Sale
import net.stewart.finance.rules.SaleAllocation
import net.stewart.finance.rules.heldLongTerm
import net.stewart.finance.rules.lotState
import net.stewart.finance.rules.position
import net.stewart.finance.rules.saleGains
import net.stewart.finance.rules.validateSaleAllocations

private const val SPARKLINE_MONTHS = 6L

/**
 * PositionService (spec §7 "Positions & trades", §9.5–§9.9, §9.16):
 * lots and sales for taxable accounts through the Phase 2 lot engine,
 * position-level holdings for tax-deferred accounts (build-scope §1),
 * and the tax report. Valuation prices come from private_prices for
 * MANUAL-locus securities; a position on an unpriced security fails
 * the request (spec §5.2) — MARKET-locus pricing arrives with the
 * price-source module.
 */
class PositionGrpcService(
    private val portfolios: PortfolioRepository,
    private val accounts: AccountRepository,
    private val securities: SecurityRepository,
    private val lots: LotRepository,
    private val sales: SaleRepository,
    private val holdings: HoldingRepository,
    private val privatePrices: PrivatePriceRepository,
    private val reporting: ReportingCurrency,
    /** The persisted CPI series, or null while unseeded (degraded mode). */
    private val cpiSeries: () -> CpiSeries? = { null },
) : PositionServiceGrpcKt.PositionServiceCoroutineImplBase() {

    override suspend fun listPositions(request: ListPositionsRequest): ListPositionsResponse {
        val portfolioId = portfolio()
        val today = LocalDate.now()
        val accountFilter = if (request.accountId > 0) AccountId(request.accountId) else null
        val securityById = securities.list(portfolioId, includeHidden = true).associateBy { it.id }
        val prices = privatePrices.latestBySecurity(portfolioId)
        val sparklines = privatePrices.recentBySecurity(portfolioId, today.minusMonths(SPARKLINE_MONTHS))

        val lotsBySecurity = lots.list(portfolioId, accountFilter).groupBy { it.securityId }
        val salesBySecurity = sales.list(portfolioId, accountFilter).groupBy { it.securityId }
        val holdingsBySecurity = holdings.list(portfolioId, accountFilter).groupBy { it.securityId }

        val builder = ListPositionsResponse.newBuilder()
        var totalBasis = reporting.zero()
        var totalValue = reporting.zero()
        var totalStGain = reporting.zero()
        var totalLtGain = reporting.zero()

        for (securityId in (lotsBySecurity.keys + holdingsBySecurity.keys)) {
            val security = securityById.getValue(securityId)
            val price = priceFor(security, prices)
            val zero = Money.zero(security.currency)

            val lotPosition = lotsBySecurity[securityId]?.let { lotRecords ->
                position(
                    lotRecords.map { it.toRules() },
                    salesBySecurity[securityId].orEmpty().map { it.toRules() },
                    price,
                    today,
                )
            }
            val holdingRecords = holdingsBySecurity[securityId].orEmpty()
            val holdingShares = holdingRecords.fold(Quantity.ZERO) { acc, h -> acc + h.quantity }

            val shares = (lotPosition?.shares ?: Quantity.ZERO) + holdingShares
            if (shares.abs() <= CLOSED_TOLERANCE) continue
            val basis = lotPosition?.basis ?: zero
            val value = (lotPosition?.currentValue ?: zero) + price * holdingShares
            val stGain = lotPosition?.shortTermGain ?: zero
            val ltGain = lotPosition?.longTermGain ?: zero

            val row = PositionRow.newBuilder()
                .setSecurityId(securityId.value)
                .setTicker(security.ticker)
                .setSparkline(
                    Sparkline.newBuilder().addAllAdjustedCloses(
                        sparklines[securityId].orEmpty().map { it.toProto().amount }
                    )
                )
                .setShares(shares.toFormatted())
                .setBasis(basis.toFormatted())
                .setCurrentValue(value.toFormatted())
                .setShortTermGain(stGain.toFormatted())
                .setLongTermGain(ltGain.toFormatted())
            holdingRecords.maxByOrNull { it.asOf ?: LocalDate.MIN }?.let {
                row.setProvenance(provenanceOf(it.source, it.asOf))
            }
            builder.addPositions(row)

            totalBasis += reporting.toReporting(basis, today)
            totalValue += reporting.toReporting(value, today)
            totalStGain += reporting.toReporting(stGain, today)
            totalLtGain += reporting.toReporting(ltGain, today)
        }
        return builder
            .setTotalBasis(totalBasis.toFormatted())
            .setTotalValue(totalValue.toFormatted())
            .setTotalShortTermGain(totalStGain.toFormatted())
            .setTotalLongTermGain(totalLtGain.toFormatted())
            .build()
    }

    override suspend fun getLotDetails(request: GetLotDetailsRequest): GetLotDetailsResponse {
        val portfolioId = portfolio()
        val today = LocalDate.now()
        // Constant-dollar cost columns (spec §5.7, §9.11): purchase-date
        // dollars re-expressed as of today, in one direction only.
        // Current prices/values stay as-is; gains compare against the
        // adjusted basis.
        val cpi = if (!request.inflationAdjusted) null else cpiSeries() ?: throw StatusException(
            Status.FAILED_PRECONDITION.withDescription("CPI data is not loaded yet")
        )
        val security = findSecurity(request.securityId, portfolioId)
        val accountFilter = if (request.accountId > 0) AccountId(request.accountId) else null
        val lotRecords = lots.list(portfolioId, accountFilter, security.id)
        val saleRecords = sales.list(portfolioId, accountFilter, security.id)
        val rulesSales = saleRecords.map { it.toRules() }
        val price = priceFor(security, privatePrices.latestBySecurity(portfolioId))

        val builder = GetLotDetailsResponse.newBuilder().setInflationAdjusted(request.inflationAdjusted)
        for (record in lotRecords) {
            val state = lotState(record.toRules(), rulesSales)
            if (state.closed) continue
            val adjust: (Money) -> Money = if (cpi == null) ({ it }) else ({ m ->
                try {
                    cpi.convert(m, record.dateBought, today)
                } catch (e: IllegalArgumentException) {
                    throw StatusException(
                        Status.FAILED_PRECONDITION.withDescription(e.message ?: "CPI coverage error")
                    )
                }
            })
            val open = state.openShares()
            val value = price * open
            val basis = adjust(state.basis)
            val gain = value - basis
            val longTerm = heldLongTerm(record.dateBought, today)
            builder.addLots(
                LotRow.newBuilder()
                    .setLotId(record.id.value)
                    .setBought(record.dateBought.toFormattedDate())
                    .setShares(record.quantity.toFormatted())
                    .setBuyPricePerShare(adjust(record.pricePerShare).toFormatted())
                    .setCurrentPricePerShare(price.toFormatted())
                    .setCommission(adjust(record.purchaseCosts).toFormatted())
                    .setSharesStillHeld(open.toFormatted())
                    .setBasis(basis.toFormatted())
                    .setCurrentValue(value.toFormatted())
                    .setShortTermGain((if (longTerm) Money.zero(security.currency) else gain).toFormatted())
                    .setLongTermGain((if (longTerm) gain else Money.zero(security.currency)).toFormatted())
                    .setAccountId(record.accountId.value)
                    .setAccountName(record.accountName)
            )
        }
        // The sale history for the ticker (spec §9.7 — the legacy UI
        // never rendered it).
        val gains = saleGains(lotRecords.map { it.toRules() }, rulesSales).groupBy { it.saleId }
        for (record in saleRecords) {
            val saleGainRows = gains[record.id].orEmpty()
            val zero = Money.zero(security.currency)
            builder.addSales(
                SaleRow.newBuilder()
                    .setSaleId(record.id.value)
                    .setSold(record.saleDate.toFormattedDate())
                    .setShares(record.allocations.fold(Quantity.ZERO) { a, (_, q) -> a + q }.toFormatted())
                    .setPricePerShare(record.pricePerShare.toFormatted())
                    .setSaleCosts(record.saleCosts.toFormatted())
                    .setShortTermGain(
                        saleGainRows.filterNot { it.longTerm }.fold(zero) { a, g -> a + g.gain }.toFormatted()
                    )
                    .setLongTermGain(
                        saleGainRows.filter { it.longTerm }.fold(zero) { a, g -> a + g.gain }.toFormatted()
                    )
            )
        }
        return builder.build()
    }

    override suspend fun addPurchase(request: AddPurchaseRequest): AddPurchaseResponse {
        val portfolioId = portfolio()
        val account = taxableAccount(request.accountId, portfolioId)
        val security = findSecurity(request.securityId, portfolioId)
        requireMatchingCurrency(account, security)
        val bought = parseDate(request.bought, "purchase date")
        val shares = parseQuantity(request.shares.value, "shares").also {
            if (it.signum() <= 0) throw invalid("shares must be positive")
        }
        val price = parseMoney(request.pricePerShare.value, account.currency, "price per share")
        val commission = parseMoney(request.commission.value.ifEmpty { "0" }, account.currency, "commission")
        if (price.signum() < 0 || commission.signum() < 0) throw invalid("amounts must not be negative")
        val id = lots.create(account.id, security.id, bought, shares, price, commission)
        return AddPurchaseResponse.newBuilder().setLotId(id.value).build()
    }

    override suspend fun updatePurchase(request: UpdatePurchaseRequest): UpdatePurchaseResponse {
        val portfolioId = portfolio()
        val record = lots.find(lotId(request.lotId), portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no lot ${request.lotId}"))
        val account = checkNotNull(accounts.find(record.accountId, portfolioId))
        val bought = parseDate(request.bought, "purchase date")
        val shares = parseQuantity(request.shares.value, "shares").also {
            if (it.signum() <= 0) throw invalid("shares must be positive")
        }
        val price = parseMoney(request.pricePerShare.value, account.currency, "price per share")
        val commission = parseMoney(request.commission.value.ifEmpty { "0" }, account.currency, "commission")
        if (price.signum() < 0 || commission.signum() < 0) throw invalid("amounts must not be negative")
        // Guard rail (§5.9): shrinking a lot below what its sales
        // already consumed would corrupt them.
        val sold = sales.list(portfolioId, record.accountId, record.securityId)
            .flatMap { it.allocations }
            .filter { it.first == record.id }
            .fold(Quantity.ZERO) { acc, (_, q) -> acc + q }
        if (shares < sold) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "sales already consumed $sold shares of this lot; it cannot shrink below that"
                )
            )
        }
        lots.update(record.id, bought, shares, price, commission)
        return UpdatePurchaseResponse.getDefaultInstance()
    }

    override suspend fun deletePurchase(request: DeletePurchaseRequest): DeletePurchaseResponse {
        val record = lots.find(lotId(request.lotId), portfolio())
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no lot ${request.lotId}"))
        // Guard rail (§5.9): a lot with sales cannot vanish from under them.
        if (lots.hasSales(record.id)) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription("the lot has recorded sales; delete those first")
            )
        }
        lots.delete(record.id)
        return DeletePurchaseResponse.getDefaultInstance()
    }

    override suspend fun recordSale(request: RecordSaleRequest): RecordSaleResponse {
        val portfolioId = portfolio()
        val account = taxableAccount(request.accountId, portfolioId)
        val security = findSecurity(request.securityId, portfolioId)
        val sold = parseDate(request.sold, "sale date")
        val totalShares = parseQuantity(request.shares.value, "shares").also {
            if (it.signum() <= 0) throw invalid("shares must be positive")
        }
        val price = parseMoney(request.pricePerShare.value, account.currency, "price per share")
        val costs = parseMoney(request.saleCosts.value.ifEmpty { "0" }, account.currency, "sale costs")
        if (price.signum() < 0 || costs.signum() < 0) throw invalid("amounts must not be negative")
        val allocations = request.allocationsList.map {
            SaleAllocation(lotId(it.lotId), parseQuantity(it.shares.value, "lot shares"))
        }
        val lotRecords = lots.list(portfolioId, account.id, security.id)
        val existingSales = sales.list(portfolioId, account.id, security.id).map { it.toRules() }
        val states = lotRecords.map { lotState(it.toRules(), existingSales) }
        allocations.forEach { allocation ->
            lotRecords.firstOrNull { it.id == allocation.lotId }?.let {
                if (sold < it.dateBought) throw invalid("lot ${it.id.value} was bought after the sale date")
            }
        }
        try {
            // Server-side validation the legacy skipped (defect 7).
            validateSaleAllocations(states, allocations, totalShares)
        } catch (e: IllegalArgumentException) {
            throw invalid(e.message ?: "invalid sale allocations")
        }
        val id = sales.create(
            account.id, security.id, sold, price, costs,
            allocations.map { it.lotId to it.shares },
        )
        return RecordSaleResponse.newBuilder().setSaleId(id.value).build()
    }

    override suspend fun deleteSale(request: DeleteSaleRequest): DeleteSaleResponse {
        if (request.saleId <= 0) throw invalid("sale id is required")
        val record = sales.find(SaleId(request.saleId), portfolio())
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no sale ${request.saleId}"))
        sales.delete(record.id)
        return DeleteSaleResponse.getDefaultInstance()
    }

    override suspend fun setHolding(request: SetHoldingRequest): SetHoldingResponse {
        val portfolioId = portfolio()
        val account = accountOf(request.accountId, portfolioId)
        // Position-level entry is the tax-deferred path (build-scope §1);
        // taxable accounts keep their lot ledger.
        if (!account.taxDeferred) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "holdings apply to tax-deferred accounts; record purchases for taxable ones"
                )
            )
        }
        val security = findSecurity(request.securityId, portfolioId)
        requireMatchingCurrency(account, security)
        val quantity = parseQuantity(request.quantity.value, "quantity")
        if (quantity.signum() <= 0) throw invalid("quantity must be positive; delete the holding to remove it")
        holdings.upsert(account.id, security.id, quantity, EntrySource.MANUAL, LocalDate.now())
        return SetHoldingResponse.getDefaultInstance()
    }

    override suspend fun deleteHolding(request: DeleteHoldingRequest): DeleteHoldingResponse {
        val portfolioId = portfolio()
        val account = accountOf(request.accountId, portfolioId)
        val security = findSecurity(request.securityId, portfolioId)
        if (!holdings.delete(account.id, security.id)) {
            throw StatusException(Status.NOT_FOUND.withDescription("no holding for that account and security"))
        }
        return DeleteHoldingResponse.getDefaultInstance()
    }

    override suspend fun getTaxReport(request: GetTaxReportRequest): GetTaxReportResponse {
        val portfolioId = portfolio()
        val from = parseDate(request.from, "from")
        val to = parseDate(request.to, "to")
        if (from > to) throw invalid("from must not be after to")
        val inRange = sales.listForTaxReport(portfolioId, from, to)
        val securityById = securities.list(portfolioId, includeHidden = true).associateBy { it.id }
        val builder = GetTaxReportResponse.newBuilder()
        var totalSt = reporting.zero()
        var totalLt = reporting.zero()
        var excluded = 0

        // Pro-rated purchase costs depend on every sale that ever
        // consumed a lot, so gains compute over each security's full
        // lot/sale history and then filter to the range.
        for ((securityId, saleGroup) in inRange.groupBy { it.securityId }) {
            val security = securityById.getValue(securityId)
            if (security.currency != reporting.currency) {
                // Non-USD sales await the FX tax-treatment ruling
                // (build-scope §5 open question).
                excluded += saleGroup.size
                continue
            }
            val allLots = lots.list(portfolioId, securityId = securityId)
            val allSales = sales.list(portfolioId, securityId = securityId)
            val saleById = saleGroup.associateBy { it.id }
            val gains = saleGains(allLots.map { it.toRules() }, allSales.map { it.toRules() })
                .filter { it.saleId in saleById }
            for (gain in gains) {
                val sale = saleById.getValue(gain.saleId)
                val st = if (gain.longTerm) Money.zero(security.currency) else gain.gain
                val lt = if (gain.longTerm) gain.gain else Money.zero(security.currency)
                builder.addRows(
                    TaxReportRow.newBuilder()
                        .setBrokerName(sale.brokerName)
                        .setAccountName(sale.accountName)
                        .setTicker(security.ticker)
                        .setBought(gain.dateBought.toFormattedDate())
                        .setSold(gain.saleDate.toFormattedDate())
                        .setPurchasePricePerShare(gain.buyPricePerShare.toFormatted())
                        .setSalePricePerShare(gain.salePricePerShare.toFormatted())
                        .setPurchaseCosts(gain.proRatedPurchaseCosts.toFormatted())
                        .setSaleCosts(gain.apportionedSaleCosts.toFormatted())
                        .setShortTermGain(st.toFormatted())
                        .setLongTermGain(lt.toFormatted())
                )
                totalSt += st
                totalLt += lt
            }
        }
        if (excluded > 0) {
            builder.addNotes(
                "$excluded sale(s) in non-USD accounts are excluded pending the FX tax-treatment ruling"
            )
        }
        return builder
            .setTotalShortTermGain(totalSt.toFormatted())
            .setTotalLongTermGain(totalLt.toFormatted())
            .setTotalGain((totalSt + totalLt).toFormatted())
            .build()
    }

    override suspend fun getPurchaseFormInfo(request: GetPurchaseFormInfoRequest): GetPurchaseFormInfoResponse {
        val portfolioId = portfolio()
        val builder = GetPurchaseFormInfoResponse.newBuilder()
        for (account in accounts.list(portfolioId, brokerId = null, includeHidden = false)) {
            builder.addAccounts(
                AccountChoice.newBuilder()
                    .setAccountId(account.id.value)
                    .setBrokerName(account.brokerName)
                    .setName(account.name)
                    .setCurrencyCode(account.currency.code)
                    .setTaxDeferred(account.taxDeferred)
                    .setSweeps(account.sweep.toFormatted())
            )
        }
        for (security in securities.list(portfolioId, includeHidden = false)) {
            builder.addSecurities(
                SecurityChoice.newBuilder()
                    .setSecurityId(security.id.value)
                    .setTicker(security.ticker)
                    .setDescription(security.description)
                    .setCurrencyCode(security.currency.code)
                    .setSecurityType(security.securityType.toProto())
            )
        }
        return builder.build()
    }

    private fun LotRecord.toRules() = Lot(id, dateBought, quantity, pricePerShare, purchaseCosts)

    private fun SaleRecord.toRules() = Sale(
        id, saleDate, pricePerShare, saleCosts,
        allocations.map { (lotId, shares) -> SaleAllocation(lotId, shares) },
    )

    /** Spec §5.2: a position on an unpriced security fails the request. */
    private fun priceFor(security: SecurityRow, prices: Map<SecurityId, Money>): Money =
        prices[security.id] ?: throw StatusException(
            Status.FAILED_PRECONDITION.withDescription(
                if (security.pricingLocus == PricingLocus.MANUAL) {
                    "${security.ticker} has no price entries yet — add one to value the position"
                } else {
                    "${security.ticker} is market-priced; the price source arrives with Phase 4/5"
                }
            )
        )

    private fun requireMatchingCurrency(account: AccountRow, security: SecurityRow) {
        // Account-owned currency (build-scope §5), enforced at write time.
        if (account.currency != security.currency) {
            throw invalid(
                "${security.ticker} is denominated in ${security.currency}; " +
                    "account \"${account.name}\" holds ${account.currency}"
            )
        }
    }

    private fun taxableAccount(raw: Long, portfolioId: PortfolioId): AccountRow {
        val account = accountOf(raw, portfolioId)
        // Lots are the taxable record; tax-deferred accounts track
        // position-level holdings instead (build-scope §1).
        if (account.taxDeferred) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "\"${account.name}\" is tax-deferred; use SetHolding instead of lot entries"
                )
            )
        }
        return account
    }

    private fun accountOf(raw: Long, portfolioId: PortfolioId): AccountRow {
        if (raw <= 0) throw invalid("account id is required")
        return accounts.find(AccountId(raw), portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no account $raw"))
    }

    private fun findSecurity(raw: Long, portfolioId: PortfolioId): SecurityRow {
        if (raw <= 0) throw invalid("security id is required")
        return securities.find(SecurityId(raw), portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no security $raw"))
    }

    private fun lotId(raw: Long): LotId =
        if (raw > 0) LotId(raw) else throw invalid("lot id is required")

    private fun parseDate(proto: net.stewart.finance.proto.Date, field: String): LocalDate = try {
        proto.toLocalDate()
    } catch (e: DateTimeException) {
        throw invalid("$field is not a valid date")
    }

    private fun parseQuantity(raw: String, field: String): Quantity = try {
        Quantity.of(raw)
    } catch (e: Exception) {
        throw invalid("$field is not a valid quantity: \"$raw\"")
    }

    private fun parseMoney(raw: String, currency: CurrencyUnit, field: String): Money = try {
        Money.of(raw, currency)
    } catch (e: Exception) {
        throw invalid("$field is not a valid amount: \"$raw\"")
    }

    private fun portfolio(): PortfolioId =
        portfolios.portfolioFor(UserId(currentAuthUser().id))

    private fun invalid(message: String) =
        StatusException(Status.INVALID_ARGUMENT.withDescription(message))
}
