package net.stewart.finance.api

import java.math.BigDecimal
import java.math.MathContext
import java.time.LocalDate
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.AssetClassRepository
import net.stewart.finance.db.ClassificationRepository
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.PlanStepRecord
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.TargetAllocationRepository
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.rules.CLOSED_TOLERANCE
import net.stewart.finance.rules.Lot
import net.stewart.finance.rules.PlanAccount
import net.stewart.finance.rules.PlanHolding
import net.stewart.finance.rules.PlanSecurity
import net.stewart.finance.rules.PlanStep
import net.stewart.finance.rules.Projection
import net.stewart.finance.rules.Sale
import net.stewart.finance.rules.SaleAllocation
import net.stewart.finance.rules.StepKind
import net.stewart.finance.rules.heldLongTerm
import net.stewart.finance.rules.lotState
import net.stewart.finance.rules.projectPlan
import net.stewart.finance.rules.saleGains

/** Everything projectPlan needs, read once per score. */
data class PlanInputs(
    val accounts: List<PlanAccount>,
    val securities: List<PlanSecurity>,
    val holdings: List<PlanHolding>,
    val classes: List<String>,
    val targets: Map<String, Fraction>,
    val today: LocalDate,
)

/** A sell candidate with its computed consequences (design amendment). */
data class SellCandidate(
    val account: PlanAccount,
    val security: PlanSecurity,
    val classWeight: Fraction,
    val held: Quantity,
    /** Reporting currency. */
    val valueInClass: Money,
    /** Taxable accounts only; security currency. */
    val estShortTermGain: Money?,
    val estLongTermGain: Money?,
    /** (st + lt) / value in class; null when tax-deferred or unpriced. */
    val gainPerDollar: BigDecimal?,
    /** The earliest date an open lot becomes long-term within 45 days. */
    val nextLongTermDate: LocalDate?,
)

data class BuyCandidate(
    val account: PlanAccount,
    val security: PlanSecurity,
    val classWeight: Fraction,
)

enum class SellOrder { TAX_COST, LARGEST_FIRST, BY_ACCOUNT, NONE }

/**
 * Reads the portfolio into the shape the trading-plan rules take,
 * scores plans, and lists candidates. Prices are the latest the app
 * holds (MARKET securities refresh first, as the Positions page does);
 * an unpriced security carries a zero price and the rules flag it.
 */
class TradingPlanAssembler(
    private val accounts: AccountRepository,
    private val securities: SecurityRepository,
    private val lots: LotRepository,
    private val sales: SaleRepository,
    private val holdings: HoldingRepository,
    private val classifications: ClassificationRepository,
    private val assetClasses: AssetClassRepository,
    private val targets: TargetAllocationRepository,
    private val pricing: PricingService,
    private val reporting: ReportingCurrency,
) {

    fun inputs(portfolioId: PortfolioId, today: LocalDate): PlanInputs {
        val accountRows = accounts.list(portfolioId, brokerId = null, includeHidden = false)
        val securityRows = securities.list(portfolioId, includeHidden = true)
        val prices = pricing.latestBySecurity(portfolioId, securityRows)
        val weights = classifications.assetClassWeightsBySecurity(portfolioId)
        val planSecurities = securityRows.map { row ->
            PlanSecurity(
                id = row.id, ticker = row.ticker, currency = row.currency,
                price = prices[row.id] ?: Money.zero(row.currency),
                weights = weights[row.id].orEmpty(),
                boughtInDollars = row.securityType.boughtInDollars,
            )
        }
        val planAccounts = accountRows.map { PlanAccount(it.id, it.name, it.currency, it.taxDeferred, it.sweep) }

        // Lots (taxable) and holdings (tax-deferred), per (account, security).
        val lotsByKey = lots.list(portfolioId, null).groupBy { it.accountId to it.securityId }
        val salesByKey = sales.list(portfolioId, null).groupBy { it.accountId to it.securityId }
        val planHoldings = mutableListOf<PlanHolding>()
        for ((key, lotRecords) in lotsByKey) {
            val ruleLots = lotRecords.map { Lot(it.id, it.dateBought, it.quantity, it.pricePerShare, it.purchaseCosts) }
            val ruleSales = salesByKey[key].orEmpty().map { s ->
                Sale(s.id, s.saleDate, s.pricePerShare, s.saleCosts, s.allocations.map { (lotId, shares) -> SaleAllocation(lotId, shares) })
            }
            val open = ruleLots.fold(Quantity.ZERO) { acc, lot -> acc + lotState(lot, ruleSales).openShares() }
            if (open <= CLOSED_TOLERANCE) continue
            planHoldings += PlanHolding(key.first, key.second, open, ruleLots, ruleSales)
        }
        for (holding in holdings.list(portfolioId)) {
            if (holding.quantity.signum() <= 0) continue
            planHoldings += PlanHolding(holding.accountId, holding.securityId, holding.quantity)
        }
        return PlanInputs(
            accounts = planAccounts,
            securities = planSecurities,
            holdings = planHoldings,
            classes = assetClasses.names().toList(),
            targets = targets.get(portfolioId),
            today = today,
        )
    }

    fun project(inputs: PlanInputs, steps: List<PlanStep>): Projection = projectPlan(
        steps, inputs.accounts, inputs.securities, inputs.holdings, inputs.classes, inputs.targets,
        reporting.currency, { reporting.toReporting(it, inputs.today) }, inputs.today,
    )

    /** Stored step records as rule steps; malformed rows surface as rule errors. */
    fun toRuleSteps(records: List<PlanStepRecord>, accountCurrency: (AccountId) -> net.stewart.finance.domain.CurrencyUnit): List<PlanStep> =
        records.map { r ->
            PlanStep(
                position = r.position,
                kind = StepKind.valueOf(r.kind),
                accountId = r.accountId,
                toAccountId = r.toAccountId,
                securityId = r.securityId,
                shares = r.shares?.let { Quantity.of(it) },
                amount = r.amount?.let { Money.of(it, accountCurrency(r.accountId)) },
                note = r.note,
            )
        }

    /**
     * Every position contributing to [className], with the consequence
     * of selling it in full at the plan price, in the requested order.
     * The app orders facts; it does not recommend (design amendment).
     */
    fun sellCandidates(inputs: PlanInputs, className: String, order: SellOrder): List<SellCandidate> {
        val accountsById = inputs.accounts.associateBy { it.id }
        val securitiesById = inputs.securities.associateBy { it.id }
        val candidates = inputs.holdings.mapNotNull { holding ->
            val account = accountsById[holding.accountId] ?: return@mapNotNull null
            val security = securitiesById[holding.securityId] ?: return@mapNotNull null
            val weight = security.weights[className] ?: return@mapNotNull null
            if (weight.signum() <= 0) return@mapNotNull null
            val value = reporting.toReporting(security.price * holding.quantity, inputs.today)
            val valueInClass = value * weight
            var st: Money? = null
            var lt: Money? = null
            var nextLongTerm: LocalDate? = null
            if (!account.taxDeferred && holding.lots.isNotEmpty() && security.price.signum() > 0) {
                val allocations = holding.lots.sortedBy { it.dateBought }.mapNotNull { lot ->
                    val open = lotState(lot, holding.sales).openShares()
                    if (open.signum() > 0) SaleAllocation(lot.id, open) else null
                }
                if (allocations.isNotEmpty()) {
                    val hypothetical = Sale(net.stewart.finance.domain.SaleId(Long.MAX_VALUE), inputs.today, security.price, Money.zero(security.currency), allocations)
                    val gains = saleGains(holding.lots, holding.sales + hypothetical).filter { it.saleId == hypothetical.id }
                    val zero = Money.zero(security.currency)
                    st = gains.filter { !it.longTerm }.fold(zero) { a, g -> a + g.gain }
                    lt = gains.filter { it.longTerm }.fold(zero) { a, g -> a + g.gain }
                }
                nextLongTerm = holding.lots
                    .filter { lotState(it, holding.sales).openShares().signum() > 0 && !heldLongTerm(it.dateBought, inputs.today) }
                    .map { it.dateBought.plusYears(1).plusDays(1) }
                    .filter { !it.isAfter(inputs.today.plusDays(45)) }
                    .minOrNull()
            }
            val gainPerDollar = if (st != null && lt != null && value.signum() > 0) {
                val totalGain = reporting.toReporting(st + lt, inputs.today)
                totalGain.amount.divide(value.amount, MathContext.DECIMAL64)
            } else null
            SellCandidate(account, security, weight, holding.quantity, valueInClass, st, lt, gainPerDollar, nextLongTerm)
        }
        return when (order) {
            SellOrder.TAX_COST -> candidates.sortedWith(
                compareBy<SellCandidate> { if (it.account.taxDeferred) 0 else 1 }
                    // Among taxable: losses first (most negative per dollar), then LT gains
                    // (smallest per dollar), then ST-heavy. Per-dollar total gain does that
                    // ordering in one key; ties by larger position.
                    .thenBy { it.gainPerDollar ?: BigDecimal.ZERO }
                    .thenByDescending { it.valueInClass.amount }
            )
            SellOrder.LARGEST_FIRST -> candidates.sortedByDescending { it.valueInClass.amount }
            SellOrder.BY_ACCOUNT -> candidates.sortedWith(compareBy({ it.account.name }, { it.security.ticker }))
            SellOrder.NONE -> candidates.sortedWith(compareBy({ it.security.ticker }, { it.account.name }))
        }
    }

    /** Securities carrying weight in [className], in accounts with cash,
     *  by available cash grouped by account (ruling: not by tax status). */
    fun buyCandidates(inputs: PlanInputs, className: String): List<BuyCandidate> {
        val weighted = inputs.securities.filter { (it.weights[className]?.signum() ?: 0) > 0 }
        return inputs.accounts
            .filter { it.sweep.signum() > 0 }
            .sortedByDescending { reporting.toReporting(it.sweep, inputs.today).amount }
            .flatMap { account ->
                weighted.filter { it.currency == account.currency }
                    .sortedBy { it.ticker }
                    .map { BuyCandidate(account, it, it.weights.getValue(className)) }
            }
    }
}
