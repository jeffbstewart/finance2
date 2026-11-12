package net.stewart.finance.rules

import java.time.LocalDate
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.LotId
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SaleId
import net.stewart.finance.domain.SecurityId

// Trading plans (docs/design/trading-plan.md): a human-composed list
// of buys, sells, transfers, and external adds/draws, and the pure
// projection of what the portfolio looks like after them. Nothing here
// executes anything, mutates anything, or proposes anything.

enum class StepKind { BUY, SELL, TRANSFER, ADD_EXTERNAL, DRAW_EXTERNAL }

/**
 * One step as the human entered it. For BUY/SELL exactly one of
 * [shares] and [amount] is given and the other is derived at the
 * plan price; [amount] is in the account's currency. TRANSFER moves
 * cash from [accountId] to [toAccountId]; ADD/DRAW move cash between
 * [accountId] and the outside world.
 */
data class PlanStep(
    val position: Int,
    val kind: StepKind,
    val accountId: AccountId,
    val toAccountId: AccountId? = null,
    val securityId: SecurityId? = null,
    val shares: Quantity? = null,
    val amount: Money? = null,
    val note: String = "",
) {
    init {
        when (kind) {
            StepKind.BUY, StepKind.SELL -> {
                require(securityId != null) { "step $position: $kind needs a security" }
                require((shares != null) != (amount != null)) { "step $position: give shares or an amount, not both" }
                shares?.let { require(it.signum() > 0) { "step $position: shares must be positive" } }
            }
            StepKind.TRANSFER -> {
                require(toAccountId != null && toAccountId != accountId) { "step $position: transfer needs a different destination account" }
                require(amount != null) { "step $position: transfer needs an amount" }
            }
            StepKind.ADD_EXTERNAL, StepKind.DRAW_EXTERNAL -> {
                require(amount != null) { "step $position: $kind needs an amount" }
            }
        }
        amount?.let { require(it.signum() > 0) { "step $position: amount must be positive" } }
    }
}

/** An account as the projection needs it. */
data class PlanAccount(
    val id: AccountId,
    val name: String,
    val currency: CurrencyUnit,
    val taxDeferred: Boolean,
    val sweep: Money,
)

/** A security as the projection needs it: price and class weights. */
data class PlanSecurity(
    val id: SecurityId,
    val ticker: String,
    val currency: CurrencyUnit,
    val price: Money,
    /** Class name -> weight; empty = unclassified. */
    val weights: Map<String, Fraction>,
    val boughtInDollars: Boolean,
)

/**
 * One account's holding of one security before the plan: lots for a
 * taxable account (with the sales already recorded against them), a
 * bare quantity for a tax-deferred one.
 */
data class PlanHolding(
    val accountId: AccountId,
    val securityId: SecurityId,
    val quantity: Quantity,
    val lots: List<Lot> = emptyList(),
    val sales: List<Sale> = emptyList(),
)

/** The step as scored: derived figures, the price used, problems. */
data class ScoredStep(
    val step: PlanStep,
    val shares: Quantity?,
    val amount: Money,
    val planPrice: Money?,
    /** Estimated realized gain at plan price, taxable SELL only. */
    val estShortTermGain: Money?,
    val estLongTermGain: Money?,
    val problems: List<String>,
)

data class AccountProjection(
    val account: PlanAccount,
    val sweepBefore: Money,
    val sweepAfter: Money,
    val valueBefore: Money,
    val valueAfter: Money,
)

data class ClassProjection(
    val className: String,
    val before: Money,
    val beforeFraction: Fraction,
    val after: Money,
    val afterFraction: Fraction,
    /** Null when the human has no target for the class. */
    val targetFraction: Fraction?,
    /** after - target x projectedTotal; null without a target. */
    val delta: Money?,
)

data class Projection(
    val steps: List<ScoredStep>,
    val accounts: List<AccountProjection>,
    val classes: List<ClassProjection>,
    val currentTotal: Money,
    val projectedTotal: Money,
    val externalIn: Money,
    val externalOut: Money,
    /** False when any step would overdraw a sweep. */
    val executable: Boolean,
)

/**
 * Scores a plan. Everything is in the reporting currency except
 * per-account sweeps, which stay in the account's currency; [convert]
 * is the dated FX conversion the views already use.
 *
 * Invariants (pinned by TradingPlanTest): with no steps Before equals
 * After; buys and sells move value between cash and positions without
 * changing the total; ADD/DRAW change the total by exactly their
 * amount, converted.
 */
fun projectPlan(
    steps: List<PlanStep>,
    accounts: List<PlanAccount>,
    securities: List<PlanSecurity>,
    holdings: List<PlanHolding>,
    classes: List<String>,
    targets: Map<String, Fraction>,
    reporting: CurrencyUnit,
    convert: (Money) -> Money,
    today: LocalDate,
    cashClass: String = "Cash",
    otherClass: String = "Other",
): Projection {
    val accountsById = accounts.associateBy { it.id }
    val securitiesById = securities.associateBy { it.id }
    val zero = Money.zero(reporting)

    // Mutable working state: sweep per account, quantity per (account, security).
    val sweeps = accounts.associate { it.id to it.sweep }.toMutableMap()
    val quantities = holdings.associate { (it.accountId to it.securityId) to it.quantity }.toMutableMap()
    val holdingsByKey = holdings.associateBy { it.accountId to it.securityId }
    var externalIn = zero
    var externalOut = zero

    val before = allocationOf(accounts, securities, quantities, sweeps, classes, convert, cashClass, otherClass)
    val valueBefore = accountValues(accounts, securitiesById, quantities, sweeps, convert)
    val sweepBefore = sweeps.toMap()

    val scored = steps.sortedBy { it.position }.map { step ->
        val problems = mutableListOf<String>()
        val account = accountsById[step.accountId]
        if (account == null) {
            problems += "account ${step.accountId.value} is not in the portfolio"
            return@map ScoredStep(step, step.shares, step.amount ?: zero, null, null, null, problems)
        }
        when (step.kind) {
            StepKind.BUY, StepKind.SELL -> {
                val security = securitiesById[step.securityId!!]
                if (security == null) {
                    problems += "security ${step.securityId.value} is not in the portfolio"
                    return@map ScoredStep(step, step.shares, step.amount ?: zero, null, null, null, problems)
                }
                if (security.currency != account.currency) {
                    problems += "${security.ticker} is ${security.currency}; ${account.name} is ${account.currency}"
                }
                val price = security.price
                val shares: Quantity = step.shares ?: run {
                    if (price.signum() <= 0) {
                        problems += "${security.ticker} has no price"
                        Quantity.ZERO
                    } else {
                        // Dollars to shares at the plan price: fractional for a
                        // fund or trust bought in dollars, whole shares otherwise.
                        val raw = step.amount!!.amount.divide(price.amount, java.math.MathContext.DECIMAL64)
                        Quantity.of(if (security.boughtInDollars) raw else raw.setScale(0, java.math.RoundingMode.DOWN))
                    }
                }
                val amount = step.amount ?: (price * shares)
                var st: Money? = null
                var lt: Money? = null
                val key = account.id to security.id
                if (step.kind == StepKind.BUY) {
                    sweeps[account.id] = sweeps.getValue(account.id) - amount
                    quantities[key] = (quantities[key] ?: Quantity.ZERO) + shares
                } else {
                    val held = quantities[key] ?: Quantity.ZERO
                    if (shares > held) problems += "${account.name} holds ${held.amount.stripTrailingZeros().toPlainString()} ${security.ticker}, not ${shares.amount.stripTrailingZeros().toPlainString()}"
                    sweeps[account.id] = sweeps.getValue(account.id) + amount
                    quantities[key] = held - shares
                    if (!account.taxDeferred) {
                        val holding = holdingsByKey[key]
                        if (holding != null && holding.lots.isNotEmpty()) {
                            val (s, l) = estimateGain(holding, shares, price, today)
                            st = s; lt = l
                        }
                    }
                }
                if (sweeps.getValue(account.id).signum() < 0) {
                    problems += "${account.name} sweep would be ${sweeps.getValue(account.id).display()}"
                }
                ScoredStep(step, shares, amount, price, st, lt, problems)
            }
            StepKind.TRANSFER -> {
                val to = accountsById[step.toAccountId!!]
                val amount = step.amount!!
                if (to == null) {
                    problems += "account ${step.toAccountId.value} is not in the portfolio"
                } else {
                    if (to.currency != account.currency) problems += "transfer between ${account.currency} and ${to.currency} accounts is not supported"
                    sweeps[account.id] = sweeps.getValue(account.id) - amount
                    sweeps[to.id] = sweeps.getValue(to.id) + amount
                    if (sweeps.getValue(account.id).signum() < 0) problems += "${account.name} sweep would be ${sweeps.getValue(account.id).display()}"
                }
                ScoredStep(step, null, amount, null, null, null, problems)
            }
            StepKind.ADD_EXTERNAL -> {
                val amount = step.amount!!
                sweeps[account.id] = sweeps.getValue(account.id) + amount
                externalIn += convert(amount)
                ScoredStep(step, null, amount, null, null, null, problems)
            }
            StepKind.DRAW_EXTERNAL -> {
                val amount = step.amount!!
                sweeps[account.id] = sweeps.getValue(account.id) - amount
                externalOut += convert(amount)
                if (sweeps.getValue(account.id).signum() < 0) problems += "${account.name} sweep would be ${sweeps.getValue(account.id).display()}"
                ScoredStep(step, null, amount, null, null, null, problems)
            }
        }
    }

    val after = allocationOf(accounts, securities, quantities, sweeps, classes, convert, cashClass, otherClass)
    val valueAfter = accountValues(accounts, securitiesById, quantities, sweeps, convert)

    val classProjections = classes.map { name ->
        val b = before.buckets.first { it.className == name }
        val a = after.buckets.first { it.className == name }
        val target = targets[name]
        ClassProjection(
            className = name,
            before = b.value, beforeFraction = b.fraction,
            after = a.value, afterFraction = a.fraction,
            targetFraction = target,
            delta = target?.let { a.value - after.total * it },
        )
    }
    val accountProjections = accounts.map { account ->
        AccountProjection(
            account = account,
            sweepBefore = sweepBefore.getValue(account.id),
            sweepAfter = sweeps.getValue(account.id),
            valueBefore = valueBefore.getValue(account.id),
            valueAfter = valueAfter.getValue(account.id),
        )
    }
    return Projection(
        steps = scored,
        accounts = accountProjections,
        classes = classProjections,
        currentTotal = before.total,
        projectedTotal = after.total,
        externalIn = externalIn,
        externalOut = externalOut,
        executable = scored.all { it.problems.isEmpty() },
    )
}

private fun allocationOf(
    accounts: List<PlanAccount>,
    securities: List<PlanSecurity>,
    quantities: Map<Pair<AccountId, SecurityId>, Quantity>,
    sweeps: Map<AccountId, Money>,
    classes: List<String>,
    convert: (Money) -> Money,
    cashClass: String,
    otherClass: String,
): AllocationReport {
    val securitiesById = securities.associateBy { it.id }
    // One ClassifiedPosition per security across accounts, valued in the reporting currency.
    val bySecurity = quantities.entries
        .filter { it.value.signum() > 0 }
        .groupBy({ it.key.second }, { it.value })
        .mapNotNull { (securityId, qtys) ->
            val security = securitiesById[securityId] ?: return@mapNotNull null
            val total = qtys.fold(Quantity.ZERO) { a, q -> a + q }
            ClassifiedPosition(security.id, security.ticker, convert(security.price * total), security.weights)
        }
    val reporting = convert(accounts.first().sweep).currency
    val sweepTotal = accounts.fold(Money.zero(reporting)) { acc, a -> acc + convert(sweeps.getValue(a.id)) }
    return currentAllocation(classes, bySecurity, sweepTotal, cashClass, otherClass)
}

private fun accountValues(
    accounts: List<PlanAccount>,
    securitiesById: Map<SecurityId, PlanSecurity>,
    quantities: Map<Pair<AccountId, SecurityId>, Quantity>,
    sweeps: Map<AccountId, Money>,
    convert: (Money) -> Money,
): Map<AccountId, Money> = accounts.associate { account ->
    var value = convert(sweeps.getValue(account.id))
    for ((key, qty) in quantities) {
        if (key.first != account.id || qty.signum() <= 0) continue
        val security = securitiesById[key.second] ?: continue
        value += convert(security.price * qty)
    }
    account.id to value
}

/**
 * Estimated realized gain for selling [shares] of a taxable holding
 * at [price] today: FIFO over the open lots (the account's recorded
 * method is applied when the real sale is recorded), through the
 * existing sale rules so the estimate and the eventual sale agree.
 */
private fun estimateGain(holding: PlanHolding, shares: Quantity, price: Money, today: LocalDate): Pair<Money, Money> {
    val zero = Money.zero(price.currency)
    var remaining = shares
    val allocations = mutableListOf<SaleAllocation>()
    for (lot in holding.lots.sortedBy { it.dateBought }) {
        if (remaining.signum() <= 0) break
        val open = lotState(lot, holding.sales).openShares()
        if (open.signum() <= 0) continue
        val take = if (open < remaining) open else remaining
        allocations += SaleAllocation(lot.id, take)
        remaining -= take
    }
    if (allocations.isEmpty()) return zero to zero
    val hypothetical = Sale(SaleId(Long.MAX_VALUE), today, price, zero, allocations)
    val gains = saleGains(holding.lots, holding.sales + hypothetical).filter { it.saleId == hypothetical.id }
    val st = gains.filter { !it.longTerm }.fold(zero) { a, g -> a + g.gain }
    val lt = gains.filter { it.longTerm }.fold(zero) { a, g -> a + g.gain }
    return st to lt
}
