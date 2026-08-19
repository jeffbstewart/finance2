package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import java.time.LocalDate
import net.stewart.armeria.auth.currentAuthUser
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.api.toFormatted
import net.stewart.finance.api.toFormattedPercent
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.AssetClassRepository
import net.stewart.finance.db.ClassificationRepository
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.db.TargetAllocationRepository
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.AssetClassId
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.SecurityType
import net.stewart.finance.domain.UserId
import net.stewart.finance.proto.AllocationServiceGrpcKt
import net.stewart.finance.proto.CandidateFund
import net.stewart.finance.proto.ClassAllocation
import net.stewart.finance.proto.ClassContributor
import net.stewart.finance.proto.GetAllocationRequest
import net.stewart.finance.proto.GetAllocationResponse
import net.stewart.finance.proto.RebalanceClass
import net.stewart.finance.proto.ScoreRebalanceRequest
import net.stewart.finance.proto.ScoreRebalanceResponse
import net.stewart.finance.proto.SetTargetAllocationRequest
import net.stewart.finance.proto.SetTargetAllocationResponse
import net.stewart.finance.proto.TradeSide as TradeSideProto
import net.stewart.finance.rules.AllocationReport
import net.stewart.finance.rules.CLOSED_TOLERANCE
import net.stewart.finance.rules.ClassifiedPosition
import net.stewart.finance.rules.PlannedTrade
import net.stewart.finance.rules.PlannerSecurity
import net.stewart.finance.rules.PurchaseModality
import net.stewart.finance.rules.TradeSide
import net.stewart.finance.rules.currentAllocation
import net.stewart.finance.rules.drift
import net.stewart.finance.rules.position
import net.stewart.finance.rules.scoreRebalance
import net.stewart.finance.rules.Lot as RulesLot
import net.stewart.finance.rules.Sale as RulesSale
import net.stewart.finance.rules.SaleAllocation as RulesSaleAllocation

/** Sum-to-one tolerance for target fractions (spec §5.9). */
private val TARGET_SUM_TOLERANCE = Fraction.of("0.0001")

/**
 * AllocationService (spec §5.4–§5.5, §9.13–§9.15): the allocation
 * dashboard, target editing, and the buy-side rebalance scorer over
 * the rules engines. All dollar figures are in the reporting currency
 * (build-scope §5); ScoreRebalance persists nothing.
 */
class AllocationGrpcService(
    private val portfolios: PortfolioRepository,
    private val accounts: AccountRepository,
    private val securities: SecurityRepository,
    private val lots: LotRepository,
    private val sales: SaleRepository,
    private val holdings: HoldingRepository,
    private val privatePrices: PrivatePriceRepository,
    private val classifications: ClassificationRepository,
    private val assetClasses: AssetClassRepository,
    private val targets: TargetAllocationRepository,
    private val reporting: ReportingCurrency,
) : AllocationServiceGrpcKt.AllocationServiceCoroutineImplBase() {

    override suspend fun getAllocation(request: GetAllocationRequest): GetAllocationResponse {
        val portfolioId = portfolio()
        val today = LocalDate.now()
        val classes = assetClasses.list()
        val idByName = classes.associate { it.name to it.id }
        val valued = valuedPositions(portfolioId, today)
        val report = buildReport(portfolioId, classes.map { it.name }, valued, today)
        val targetByName = targetFractionsByName(portfolioId)
        val sharesBySecurity = valued.associate { it.security.id to it.shares }

        val entries = if (targetByName.isEmpty()) null else drift(report, targetByName)
        val builder = GetAllocationResponse.newBuilder()
            .setPortfolioTotal(report.total.toFormatted())
            .setTargetSet(targetByName.isNotEmpty())
        for ((index, bucket) in report.buckets.withIndex()) {
            val entry = entries?.get(index)
            val classBuilder = ClassAllocation.newBuilder()
                .setAssetClassId(idByName.getValue(bucket.className).value)
                .setName(bucket.className)
                .setCurrent(bucket.value.toFormatted())
                .setCurrentFraction(bucket.fraction.toFormattedPercent())
                .setTarget((entry?.target ?: reporting.zero()).toFormatted())
                .setTargetFraction((entry?.targetFraction ?: Fraction.ZERO).toFormattedPercent())
                .setDelta((entry?.delta ?: reporting.zero()).toFormatted())
            for (contribution in bucket.contributions) {
                classBuilder.addContributors(
                    ClassContributor.newBuilder()
                        .setSecurityId(contribution.securityId?.value ?: 0)
                        .setTicker(contribution.ticker)
                        .setShares(
                            (contribution.securityId?.let { sharesBySecurity[it] } ?: Quantity.ZERO)
                                .toFormatted()
                        )
                        .setClassWeight(contribution.weight.toFormattedPercent())
                        .setContribution(contribution.amount.toFormatted())
                )
            }
            builder.addClasses(classBuilder)
        }
        return builder.build()
    }

    override suspend fun setTargetAllocation(request: SetTargetAllocationRequest): SetTargetAllocationResponse {
        val portfolioId = portfolio()
        if (request.entriesCount == 0) throw invalid("at least one target entry is required")
        val known = assetClasses.list().associateBy { it.id }
        val entries = linkedMapOf<AssetClassId, Fraction>()
        for (entry in request.entriesList) {
            if (entry.assetClassId <= 0) throw invalid("asset class id is required")
            val classId = AssetClassId(entry.assetClassId)
            if (classId !in known) throw invalid("unknown asset class ${entry.assetClassId}")
            if (classId in entries) throw invalid("duplicate entry for ${known.getValue(classId).name}")
            val fraction = try {
                Fraction.of(entry.fraction.value)
            } catch (e: Exception) {
                throw invalid("fraction for ${known.getValue(classId).name} is not valid: \"${entry.fraction.value}\"")
            }
            if (fraction.signum() < 0) throw invalid("fractions must not be negative")
            entries[classId] = fraction
        }
        // Guard rail (spec §5.9): the fractions must sum to 1 (±0.0001).
        val sum = entries.values.fold(Fraction.ZERO) { acc, f -> acc + f }
        if ((sum - Fraction.ONE).abs() > TARGET_SUM_TOLERANCE) {
            throw invalid("target fractions sum to $sum; they must sum to 1 (±0.0001)")
        }
        targets.replace(portfolioId, entries)
        return SetTargetAllocationResponse.getDefaultInstance()
    }

    override suspend fun scoreRebalance(request: ScoreRebalanceRequest): ScoreRebalanceResponse {
        val portfolioId = portfolio()
        val today = LocalDate.now()
        if (request.accountId <= 0) throw invalid("destination account id is required")
        val destination = accounts.find(AccountId(request.accountId), portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no account ${request.accountId}"))
        val targetByName = targetFractionsByName(portfolioId)
        if (targetByName.isEmpty()) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription("set a target allocation before planning a rebalance")
            )
        }
        val classes = assetClasses.list()
        val idByName = classes.associate { it.name to it.id }
        val valued = valuedPositions(portfolioId, today)
        val report = buildReport(portfolioId, classes.map { it.name }, valued, today)

        // The planner's candidate pool: priced, classified securities,
        // with prices converted to the reporting currency.
        val weightsBySecurity = classifications.assetClassWeightsBySecurity(portfolioId)
        val prices = privatePrices.latestBySecurity(portfolioId)
        val plannerSecurities = securities.list(portfolioId, includeHidden = false).mapNotNull { row ->
            val price = prices[row.id] ?: return@mapNotNull null
            val weights = weightsBySecurity[row.id] ?: return@mapNotNull null
            PlannerSecurity(
                securityId = row.id,
                ticker = row.ticker,
                price = reporting.toReporting(price, today),
                purchaseModality = if (row.securityType == SecurityType.MUTUAL_FUND) {
                    PurchaseModality.PURCHASE_DOLLAR_AMOUNTS
                } else {
                    PurchaseModality.PURCHASE_WHOLE_SHARES
                },
                weights = weights,
            )
        }

        val trades = request.tradesList.map { trade ->
            when (trade.side) {
                TradeSideProto.BUY -> Unit
                TradeSideProto.SELL -> throw StatusException(
                    Status.UNIMPLEMENTED.withDescription(
                        "sell-side planning is reserved but not implemented (build-scope §3)"
                    )
                )
                else -> throw invalid("trade side is required")
            }
            if (trade.securityId <= 0) throw invalid("trade security id is required")
            PlannedTrade(
                side = TradeSide.BUY,
                securityId = SecurityId(trade.securityId),
                shares = trade.shares.value.trim().ifEmpty { null }?.let { parseQuantity(it, "trade shares") },
                cost = trade.cost.value.trim().ifEmpty { null }?.let { parseReportingMoney(it, "trade cost") },
            )
        }
        val addedFunds = request.addedFunds.value.trim().ifEmpty { "0" }
            .let { parseReportingMoney(it, "added funds") }
        if (addedFunds.signum() < 0) throw invalid("added funds must not be negative")
        val availableSweeps = reporting.toReporting(destination.sweep, today)

        val plan = try {
            scoreRebalance(report, targetByName, plannerSecurities, trades, availableSweeps, addedFunds)
        } catch (e: IllegalArgumentException) {
            throw invalid(e.message ?: "invalid rebalance plan")
        }

        val builder = ScoreRebalanceResponse.newBuilder()
            .setCurrentTotal(plan.currentTotal.toFormatted())
            .setAddedFunds(plan.addedFunds.toFormatted())
            .setSpent(plan.spent.toFormatted())
            .setRemaining(plan.remaining.toFormatted())
        for (score in plan.classes) {
            val classBuilder = RebalanceClass.newBuilder()
                .setAssetClassId(idByName.getValue(score.className).value)
                .setName(score.className)
                .setBeforeFraction(score.beforeFraction.toFormattedPercent())
                .setAfterFraction(score.afterFraction.toFormattedPercent())
                .setTargetFraction(score.targetFraction.toFormattedPercent())
                .setResidual(score.residual.toFormatted())
                .setAtOrOverTarget(score.atOrOverTarget)
            for (candidate in score.candidates) {
                classBuilder.addCandidates(
                    CandidateFund.newBuilder()
                        .setSecurityId(candidate.securityId.value)
                        .setTicker(candidate.ticker)
                        .setClassWeight(candidate.classWeight.toFormattedPercent())
                        .setSuggestedShares(
                            net.stewart.finance.proto.Decimal.newBuilder()
                                .setValue(candidate.suggestedShares.toWire())
                        )
                        .setPricePerShare(candidate.pricePerShare.toFormatted())
                        .setCost(candidate.cost.toFormatted())
                )
            }
            builder.addClasses(classBuilder)
        }
        return builder.build()
    }

    /** Per-security shares and reporting-currency value, lots + holdings merged. */
    private data class ValuedPosition(
        val security: SecurityRow,
        val shares: Quantity,
        val valueUsd: Money,
    )

    private fun valuedPositions(portfolioId: PortfolioId, today: LocalDate): List<ValuedPosition> {
        val securityById = securities.list(portfolioId, includeHidden = true).associateBy { it.id }
        val prices = privatePrices.latestBySecurity(portfolioId)
        val lotsBySecurity = lots.list(portfolioId).groupBy { it.securityId }
        val salesBySecurity = sales.list(portfolioId).groupBy { it.securityId }
        val holdingsBySecurity = holdings.list(portfolioId).groupBy { it.securityId }
        val result = mutableListOf<ValuedPosition>()
        for (securityId in (lotsBySecurity.keys + holdingsBySecurity.keys)) {
            val security = securityById.getValue(securityId)
            val price = prices[securityId] ?: throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    if (security.pricingLocus == PricingLocus.MANUAL) {
                        "${security.ticker} has no price entries yet — add one to value the position"
                    } else {
                        "${security.ticker} is market-priced; the price source arrives with Phase 4/5"
                    }
                )
            )
            val lotPosition = lotsBySecurity[securityId]?.let { records ->
                position(
                    records.map { RulesLot(it.id, it.dateBought, it.quantity, it.pricePerShare, it.purchaseCosts) },
                    salesBySecurity[securityId].orEmpty().map { sale ->
                        RulesSale(
                            sale.id, sale.saleDate, sale.pricePerShare, sale.saleCosts,
                            sale.allocations.map { (lotId, q) -> RulesSaleAllocation(lotId, q) },
                        )
                    },
                    price,
                    today,
                )
            }
            val holdingShares = holdingsBySecurity[securityId].orEmpty()
                .fold(Quantity.ZERO) { acc, h -> acc + h.quantity }
            val shares = (lotPosition?.shares ?: Quantity.ZERO) + holdingShares
            if (shares.abs() <= CLOSED_TOLERANCE) continue
            val value = (lotPosition?.currentValue ?: Money.zero(security.currency)) + price * holdingShares
            result.add(ValuedPosition(security, shares, reporting.toReporting(value, today)))
        }
        return result
    }

    private fun buildReport(
        portfolioId: PortfolioId,
        classNames: List<String>,
        valued: List<ValuedPosition>,
        today: LocalDate,
    ): AllocationReport {
        val weightsBySecurity = classifications.assetClassWeightsBySecurity(portfolioId)
        val positions = valued.map {
            ClassifiedPosition(
                securityId = it.security.id,
                ticker = it.security.ticker,
                value = it.valueUsd,
                weights = weightsBySecurity[it.security.id].orEmpty(),
            )
        }
        // The sum of visible accounts' sweeps joins the Cash class as
        // the synthetic Sweeps position (spec §5.4).
        val sweeps = accounts.list(portfolioId, brokerId = null, includeHidden = false)
            .fold(reporting.zero()) { acc, account -> acc + reporting.toReporting(account.sweep, today) }
        return currentAllocation(classNames, positions, sweeps)
    }

    private fun targetFractionsByName(portfolioId: PortfolioId): Map<String, Fraction> {
        val nameById = assetClasses.list().associate { it.id to it.name }
        return targets.get(portfolioId).entries.associate { (id, fraction) ->
            nameById.getValue(id) to fraction
        }
    }

    private fun parseQuantity(raw: String, field: String): Quantity = try {
        Quantity.of(raw)
    } catch (e: Exception) {
        throw invalid("$field is not a valid quantity: \"$raw\"")
    }

    private fun parseReportingMoney(raw: String, field: String): Money = try {
        Money.of(raw, reporting.currency)
    } catch (e: Exception) {
        throw invalid("$field is not a valid amount: \"$raw\"")
    }

    private fun portfolio(): PortfolioId =
        portfolios.portfolioFor(UserId(currentAuthUser().id))

    private fun invalid(message: String) =
        StatusException(Status.INVALID_ARGUMENT.withDescription(message))
}
