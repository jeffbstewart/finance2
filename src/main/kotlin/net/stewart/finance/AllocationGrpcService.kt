package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import java.time.LocalDate
import net.stewart.armeria.auth.currentAuthUser
import net.stewart.finance.api.PricingService
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.api.toFormatted
import net.stewart.finance.api.toFormattedPercent
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.AssetClassRepository
import net.stewart.finance.db.ClassificationRepository
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.db.TargetAllocationRepository
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.SecurityType
import net.stewart.finance.domain.UserId
import net.stewart.finance.proto.AllocationServiceGrpcKt
import net.stewart.finance.proto.ClassAllocation
import net.stewart.finance.proto.ClassContributor
import net.stewart.finance.proto.GetAllocationRequest
import net.stewart.finance.proto.GetAllocationResponse
import net.stewart.finance.proto.SetTargetAllocationRequest
import net.stewart.finance.proto.SetTargetAllocationResponse
import net.stewart.finance.rules.AllocationReport
import net.stewart.finance.rules.CLOSED_TOLERANCE
import net.stewart.finance.rules.ClassifiedPosition
import net.stewart.finance.rules.currentAllocation
import net.stewart.finance.rules.drift
import net.stewart.finance.rules.position
import net.stewart.finance.rules.Lot as RulesLot
import net.stewart.finance.rules.Sale as RulesSale
import net.stewart.finance.rules.SaleAllocation as RulesSaleAllocation

/** Sum-to-one tolerance for target fractions (spec sec. 5.9). */
private val TARGET_SUM_TOLERANCE = Fraction.of("0.0001")

/**
 * AllocationService (spec sec. 5.4, sec. 9.13-sec. 9.15): the allocation
 * dashboard and target editing over the rules engines. All dollar
 * figures are in the reporting currency (build-scope sec. 5). Planning
 * trades against the target is TradingPlanService's job.
 */
class AllocationGrpcService(
    private val portfolios: PortfolioRepository,
    private val accounts: AccountRepository,
    private val securities: SecurityRepository,
    private val lots: LotRepository,
    private val sales: SaleRepository,
    private val holdings: HoldingRepository,
    private val pricing: PricingService,
    private val classifications: ClassificationRepository,
    private val assetClasses: AssetClassRepository,
    private val targets: TargetAllocationRepository,
    private val reporting: ReportingCurrency,
) : AllocationServiceGrpcKt.AllocationServiceCoroutineImplBase() {

    override suspend fun getAllocation(request: GetAllocationRequest): GetAllocationResponse {
        val portfolioId = portfolio()
        val today = LocalDate.now()
        val valued = valuedPositions(portfolioId, today)
        val report = buildReport(portfolioId, assetClasses.names().toList(), valued, today)
        val targetByName = targets.get(portfolioId)
        val sharesBySecurity = valued.associate { it.security.id to it.shares }

        val entries = if (targetByName.isEmpty()) null else drift(report, targetByName)
        val builder = GetAllocationResponse.newBuilder()
            .setPortfolioTotal(report.total.toFormatted())
            .setTargetSet(targetByName.isNotEmpty())
        for ((index, bucket) in report.buckets.withIndex()) {
            val entry = entries?.get(index)
            val classBuilder = ClassAllocation.newBuilder()
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
        val known = assetClasses.names()
        val entries = linkedMapOf<String, Fraction>()
        for (entry in request.entriesList) {
            val name = entry.assetClass.trim()
            if (name !in known) {
                throw invalid("unknown asset class \"$name\" - known: ${known.joinToString()}")
            }
            if (name in entries) throw invalid("duplicate entry for $name")
            val fraction = try {
                Fraction.of(entry.fraction.value)
            } catch (e: Exception) {
                throw invalid("fraction for $name is not valid: \"${entry.fraction.value}\"")
            }
            if (fraction.signum() < 0) throw invalid("fractions must not be negative")
            entries[name] = fraction
        }
        // Guard rail (spec sec. 5.9): the fractions must sum to 1 (+/-0.0001).
        val sum = entries.values.fold(Fraction.ZERO) { acc, f -> acc + f }
        if ((sum - Fraction.ONE).abs() > TARGET_SUM_TOLERANCE) {
            throw invalid("target fractions sum to $sum; they must sum to 1 (+/-0.0001)")
        }
        targets.replace(portfolioId, entries)
        return SetTargetAllocationResponse.getDefaultInstance()
    }

    /** Per-security shares and reporting-currency value, lots + holdings merged. */
    private data class ValuedPosition(
        val security: SecurityRow,
        val shares: Quantity,
        val valueUsd: Money,
    )

    private fun valuedPositions(portfolioId: PortfolioId, today: LocalDate): List<ValuedPosition> {
        val securityById = securities.list(portfolioId, includeHidden = true).associateBy { it.id }
        val prices = pricing.latestBySecurity(portfolioId, securityById.values)
        val lotsBySecurity = lots.list(portfolioId).groupBy { it.securityId }
        val salesBySecurity = sales.list(portfolioId).groupBy { it.securityId }
        val holdingsBySecurity = holdings.list(portfolioId).groupBy { it.securityId }
        val result = mutableListOf<ValuedPosition>()
        for (securityId in (lotsBySecurity.keys + holdingsBySecurity.keys)) {
            val security = securityById.getValue(securityId)
            val price = prices[securityId] ?: throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    if (security.pricingLocus == PricingLocus.MANUAL) {
                        "${security.ticker} has no price entries yet - add one to value the position"
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
        // the synthetic Sweeps position (spec sec. 5.4).
        val sweeps = accounts.list(portfolioId, brokerId = null, includeHidden = false)
            .fold(reporting.zero()) { acc, account -> acc + reporting.toReporting(account.sweep, today) }
        return currentAllocation(classNames, positions, sweeps)
    }

    private fun portfolio(): PortfolioId =
        portfolios.portfolioFor(UserId(currentAuthUser().id))

    private fun invalid(message: String) =
        StatusException(Status.INVALID_ARGUMENT.withDescription(message))
}
