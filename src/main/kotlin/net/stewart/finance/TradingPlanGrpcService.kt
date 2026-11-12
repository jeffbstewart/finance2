package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import java.math.BigDecimal
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import net.stewart.armeria.auth.currentAuthUser
import net.stewart.finance.api.PlanInputs
import net.stewart.finance.api.SellOrder
import net.stewart.finance.api.TradingPlanAssembler
import net.stewart.finance.api.toFormatted
import net.stewart.finance.api.toFormattedDate
import net.stewart.finance.api.toFormattedPercent
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.PlanRecord
import net.stewart.finance.db.PlanStatus
import net.stewart.finance.db.PlanStepInput as PlanStepInputRecord
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.TradingPlanRepository
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PlanId
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.UserId
import net.stewart.finance.proto.AccountProjection as AccountProjectionProto
import net.stewart.finance.proto.BuyCandidate as BuyCandidateProto
import net.stewart.finance.proto.ClassProjection as ClassProjectionProto
import net.stewart.finance.proto.CreatePlanRequest
import net.stewart.finance.proto.CreatePlanResponse
import net.stewart.finance.proto.DeletePlanRequest
import net.stewart.finance.proto.DeletePlanResponse
import net.stewart.finance.proto.FormattedDecimal
import net.stewart.finance.proto.GetBuyCandidatesRequest
import net.stewart.finance.proto.GetBuyCandidatesResponse
import net.stewart.finance.proto.GetPlanRequest
import net.stewart.finance.proto.GetPlanResponse
import net.stewart.finance.proto.GetSellCandidatesRequest
import net.stewart.finance.proto.GetSellCandidatesResponse
import net.stewart.finance.proto.ListPlansRequest
import net.stewart.finance.proto.ListPlansResponse
import net.stewart.finance.proto.MarkPlanPrintedRequest
import net.stewart.finance.proto.MarkPlanPrintedResponse
import net.stewart.finance.proto.Plan
import net.stewart.finance.proto.PlanStatus as PlanStatusProto
import net.stewart.finance.proto.PlanStep as PlanStepProto
import net.stewart.finance.proto.PlanStepInput
import net.stewart.finance.proto.PlanSummary
import net.stewart.finance.proto.Projection as ProjectionProto
import net.stewart.finance.proto.RenamePlanRequest
import net.stewart.finance.proto.RenamePlanResponse
import net.stewart.finance.proto.SellCandidate as SellCandidateProto
import net.stewart.finance.proto.SellOrder as SellOrderProto
import net.stewart.finance.proto.SetPlanStatusRequest
import net.stewart.finance.proto.SetPlanStatusResponse
import net.stewart.finance.proto.SetPlanStepsRequest
import net.stewart.finance.proto.SetPlanStepsResponse
import net.stewart.finance.proto.StepKind as StepKindProto
import net.stewart.finance.proto.TradingPlanServiceGrpcKt
import net.stewart.finance.rules.PlanStep
import net.stewart.finance.rules.Projection
import net.stewart.finance.rules.StepKind

/**
 * TradingPlanService (docs/design/trading-plan.md). Plans are the
 * human's entries; every response re-scores against current prices.
 * This service never executes, never mutates positions or cash, and
 * never proposes a step; the candidate RPCs order computed
 * consequences of a decision the human already made.
 */
class TradingPlanGrpcService(
    private val portfolios: PortfolioRepository,
    private val accounts: AccountRepository,
    private val plans: TradingPlanRepository,
    private val assembler: TradingPlanAssembler,
) : TradingPlanServiceGrpcKt.TradingPlanServiceCoroutineImplBase() {

    override suspend fun listPlans(request: ListPlansRequest): ListPlansResponse {
        val builder = ListPlansResponse.newBuilder()
        for (record in plans.list(portfolio(), request.includeArchived)) builder.addPlans(record.toSummary())
        return builder.build()
    }

    override suspend fun getPlan(request: GetPlanRequest): GetPlanResponse {
        val portfolioId = portfolio()
        val record = findPlan(request.planId, portfolioId)
        return GetPlanResponse.newBuilder().setPlan(scored(record, portfolioId)).build()
    }

    override suspend fun createPlan(request: CreatePlanRequest): CreatePlanResponse {
        val portfolioId = portfolio()
        val id = plans.create(portfolioId, planName(request.name))
        val record = checkNotNull(plans.find(id, portfolioId))
        return CreatePlanResponse.newBuilder().setPlan(scored(record, portfolioId)).build()
    }

    override suspend fun renamePlan(request: RenamePlanRequest): RenamePlanResponse {
        val record = findPlan(request.planId, portfolio())
        plans.rename(record.id, planName(request.name))
        return RenamePlanResponse.getDefaultInstance()
    }

    override suspend fun setPlanSteps(request: SetPlanStepsRequest): SetPlanStepsResponse {
        val portfolioId = portfolio()
        val record = findPlan(request.planId, portfolioId)
        if (record.status == PlanStatus.ARCHIVED) throw failed("${record.name} is archived; reopen it to edit")
        val accountRows = accounts.list(portfolioId, brokerId = null, includeHidden = true).associateBy { it.id }
        val inputs = request.stepsList.mapIndexed { index, step -> validated(index + 1, step, accountRows, portfolioId) }
        // Validate through the rules before writing anything: a malformed
        // step is refused, not stored.
        val planInputs = assembler.inputs(portfolioId, LocalDate.now())
        try {
            assembler.project(planInputs, inputs.mapIndexed { i, s -> ruleStep(i + 1, s, accountRows.getValue(s.accountId).currency) })
        } catch (e: IllegalArgumentException) {
            throw invalid(e.message ?: "invalid plan step")
        }
        plans.replaceSteps(record.id, inputs)
        val updated = checkNotNull(plans.find(record.id, portfolioId))
        return SetPlanStepsResponse.newBuilder().setPlan(scored(updated, portfolioId, planInputs)).build()
    }

    override suspend fun markPlanPrinted(request: MarkPlanPrintedRequest): MarkPlanPrintedResponse {
        val portfolioId = portfolio()
        val record = findPlan(request.planId, portfolioId)
        plans.markPrinted(record.id)
        return MarkPlanPrintedResponse.newBuilder()
            .setSummary(checkNotNull(plans.find(record.id, portfolioId)).toSummary())
            .build()
    }

    override suspend fun setPlanStatus(request: SetPlanStatusRequest): SetPlanStatusResponse {
        val record = findPlan(request.planId, portfolio())
        val status = when (request.status) {
            PlanStatusProto.PLAN_OPEN -> PlanStatus.OPEN
            PlanStatusProto.PLAN_ARCHIVED -> PlanStatus.ARCHIVED
            else -> throw invalid("status must be OPEN or ARCHIVED")
        }
        plans.setStatus(record.id, status)
        return SetPlanStatusResponse.getDefaultInstance()
    }

    override suspend fun deletePlan(request: DeletePlanRequest): DeletePlanResponse {
        val record = findPlan(request.planId, portfolio())
        plans.delete(record.id)
        return DeletePlanResponse.getDefaultInstance()
    }

    override suspend fun getSellCandidates(request: GetSellCandidatesRequest): GetSellCandidatesResponse {
        val portfolioId = portfolio()
        val inputs = assembler.inputs(portfolioId, LocalDate.now())
        val className = className(request.className, inputs)
        val order = when (request.order) {
            SellOrderProto.SELL_ORDER_UNSPECIFIED, SellOrderProto.SELL_ORDER_TAX_COST -> SellOrder.TAX_COST
            SellOrderProto.SELL_ORDER_LARGEST_FIRST -> SellOrder.LARGEST_FIRST
            SellOrderProto.SELL_ORDER_BY_ACCOUNT -> SellOrder.BY_ACCOUNT
            SellOrderProto.SELL_ORDER_NONE -> SellOrder.NONE
            else -> throw invalid("unknown sell order")
        }
        val builder = GetSellCandidatesResponse.newBuilder().setOrderCaption(
            when (order) {
                SellOrder.TAX_COST -> "Ordered by tax consequence: tax-deferred accounts first, then taxable losses (largest per dollar), then smallest gains per dollar. Estimates at plan price; no tax rates assumed."
                SellOrder.LARGEST_FIRST -> "Ordered by value in $className, largest first."
                SellOrder.BY_ACCOUNT -> "Ordered by account, then ticker."
                SellOrder.NONE -> "Ordered by ticker, then account."
            }
        )
        for (c in assembler.sellCandidates(inputs, className, order)) {
            val proto = SellCandidateProto.newBuilder()
                .setAccountId(c.account.id.value)
                .setAccountName(c.account.name)
                .setTaxDeferred(c.account.taxDeferred)
                .setSecurityId(c.security.id.value)
                .setTicker(c.security.ticker)
                .setClassWeight(c.classWeight.toFormattedPercent())
                .setHeld(c.held.toFormatted())
                .setValueInClass(c.valueInClass.toFormatted())
                .setPlanPrice(c.security.price.toFormatted())
            c.estShortTermGain?.let { proto.setEstShortTermGain(it.toFormatted()) }
            c.estLongTermGain?.let { proto.setEstLongTermGain(it.toFormatted()) }
            c.gainPerDollar?.let { proto.setGainPerDollar(it.toFormattedRatio()) }
            c.nextLongTermDate?.let { proto.setNextLongTermDate(it.toFormattedDate()) }
            builder.addCandidates(proto)
        }
        return builder.build()
    }

    override suspend fun getBuyCandidates(request: GetBuyCandidatesRequest): GetBuyCandidatesResponse {
        val portfolioId = portfolio()
        val inputs = assembler.inputs(portfolioId, LocalDate.now())
        val className = className(request.className, inputs)
        val builder = GetBuyCandidatesResponse.newBuilder()
        for (c in assembler.buyCandidates(inputs, className)) {
            builder.addCandidates(
                BuyCandidateProto.newBuilder()
                    .setAccountId(c.account.id.value)
                    .setAccountName(c.account.name)
                    .setTaxDeferred(c.account.taxDeferred)
                    .setAvailableSweep(c.account.sweep.toFormatted())
                    .setSecurityId(c.security.id.value)
                    .setTicker(c.security.ticker)
                    .setClassWeight(c.classWeight.toFormattedPercent())
                    .setPlanPrice(c.security.price.toFormatted())
                    .setBoughtInDollars(c.security.boughtInDollars)
            )
        }
        return builder.build()
    }

    // ---- scoring and mapping ------------------------------------------

    private fun scored(record: PlanRecord, portfolioId: PortfolioId, inputs: PlanInputs? = null): Plan {
        val planInputs = inputs ?: assembler.inputs(portfolioId, LocalDate.now())
        val currencyOf = planInputs.accounts.associate { it.id to it.currency }
        val allAccounts = accounts.list(portfolioId, brokerId = null, includeHidden = true).associateBy { it.id }
        val steps = assembler.toRuleSteps(plans.steps(record.id)) { id ->
            currencyOf[id] ?: allAccounts[id]?.currency ?: CurrencyUnit.USD
        }
        val projection = try {
            assembler.project(planInputs, steps)
        } catch (e: IllegalArgumentException) {
            throw failed("${record.name} has a step the rules reject: ${e.message}")
        }
        return Plan.newBuilder()
            .setSummary(record.toSummary())
            .setProjection(projection.toProto(planInputs, allAccounts.mapValues { it.value.brokerName }, record))
            .build()
    }

    private fun Projection.toProto(
        inputs: PlanInputs,
        brokerNames: Map<AccountId, String>,
        record: PlanRecord,
    ): ProjectionProto {
        val accountName = inputs.accounts.associate { it.id to it.name }
        val tickers = inputs.securities.associate { it.id to it.ticker }
        val builder = ProjectionProto.newBuilder()
            .setCurrentTotal(currentTotal.toFormatted())
            .setProjectedTotal(projectedTotal.toFormatted())
            .setExternalIn(externalIn.toFormatted())
            .setExternalOut(externalOut.toFormatted())
            .setExecutable(executable)
            .setPricedAt(DateTimeFormatter.ISO_INSTANT.format(Instant.now()))
        val stepRecords = plans.steps(record.id).associateBy { it.position }
        for (s in steps) {
            val input = PlanStepInput.newBuilder()
                .setKind(s.step.kind.toProto())
                .setAccountId(s.step.accountId.value)
                .setNote(s.step.note)
            s.step.toAccountId?.let { input.setToAccountId(it.value) }
            s.step.securityId?.let { input.setSecurityId(it.value) }
            s.step.shares?.let { input.setShares(net.stewart.finance.proto.Decimal.newBuilder().setValue(it.toWire())) }
            s.step.amount?.let { input.setAmount(net.stewart.finance.proto.Decimal.newBuilder().setValue(it.toWire())) }
            val proto = PlanStepProto.newBuilder()
                .setStepId(stepRecords[s.step.position]?.id ?: 0L)
                .setPosition(s.step.position)
                .setInput(input)
                .setAccountName(accountName[s.step.accountId] ?: "")
                .setToAccountName(s.step.toAccountId?.let { accountName[it] } ?: "")
                .setTicker(s.step.securityId?.let { tickers[it] } ?: "")
                .setAmount(s.amount.toFormatted())
                .addAllProblems(s.problems)
            s.shares?.let { proto.setShares(it.toFormatted()) }
            s.planPrice?.let { proto.setPlanPrice(it.toFormatted()) }
            s.estShortTermGain?.let { proto.setEstShortTermGain(it.toFormatted()) }
            s.estLongTermGain?.let { proto.setEstLongTermGain(it.toFormatted()) }
            builder.addSteps(proto)
        }
        for (a in accounts) {
            builder.addAccounts(
                AccountProjectionProto.newBuilder()
                    .setAccountId(a.account.id.value)
                    .setBrokerName(brokerNames[a.account.id] ?: "")
                    .setName(a.account.name)
                    .setTaxDeferred(a.account.taxDeferred)
                    .setSweepBefore(a.sweepBefore.toFormatted())
                    .setSweepAfter(a.sweepAfter.toFormatted())
                    .setValueBefore(a.valueBefore.toFormatted())
                    .setValueAfter(a.valueAfter.toFormatted())
            )
        }
        for (c in classes) {
            val proto = ClassProjectionProto.newBuilder()
                .setName(c.className)
                .setBefore(c.before.toFormatted())
                .setBeforeFraction(c.beforeFraction.toFormattedPercent())
                .setAfter(c.after.toFormatted())
                .setAfterFraction(c.afterFraction.toFormattedPercent())
            c.targetFraction?.let { proto.setTargetFraction(it.toFormattedPercent()) }
            c.delta?.let { proto.setDelta(it.toFormatted()) }
            builder.addClasses(proto)
        }
        return builder.build()
    }

    private fun PlanRecord.toSummary(): PlanSummary {
        val builder = PlanSummary.newBuilder()
            .setPlanId(id.value)
            .setName(name)
            .setStatus(if (status == PlanStatus.OPEN) PlanStatusProto.PLAN_OPEN else PlanStatusProto.PLAN_ARCHIVED)
            .setCreatedAt(createdAt.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME))
            .setUpdatedAt(updatedAt.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME))
            .setStepCount(stepCount)
        lastPrintedAt?.let { builder.setLastPrintedAt(it.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)) }
        return builder.build()
    }

    private fun StepKind.toProto(): StepKindProto = when (this) {
        StepKind.BUY -> StepKindProto.STEP_BUY
        StepKind.SELL -> StepKindProto.STEP_SELL
        StepKind.TRANSFER -> StepKindProto.STEP_TRANSFER
        StepKind.ADD_EXTERNAL -> StepKindProto.STEP_ADD_EXTERNAL
        StepKind.DRAW_EXTERNAL -> StepKindProto.STEP_DRAW_EXTERNAL
    }

    private fun BigDecimal.toFormattedRatio(): FormattedDecimal = FormattedDecimal.newBuilder()
        .setExact(net.stewart.finance.proto.Decimal.newBuilder().setValue(stripTrailingZeros().toPlainString()))
        .setDisplay(String.format("%+.1f%%", this.multiply(BigDecimal(100))))
        .setSortKey(toDouble())
        .build()

    // ---- validation ------------------------------------------------------

    private fun validated(
        position: Int,
        step: PlanStepInput,
        accountRows: Map<AccountId, net.stewart.finance.db.AccountRow>,
        portfolioId: PortfolioId,
    ): PlanStepInputRecord {
        val kind = when (step.kind) {
            StepKindProto.STEP_BUY -> StepKind.BUY
            StepKindProto.STEP_SELL -> StepKind.SELL
            StepKindProto.STEP_TRANSFER -> StepKind.TRANSFER
            StepKindProto.STEP_ADD_EXTERNAL -> StepKind.ADD_EXTERNAL
            StepKindProto.STEP_DRAW_EXTERNAL -> StepKind.DRAW_EXTERNAL
            else -> throw invalid("step $position: kind is required")
        }
        if (step.accountId <= 0) throw invalid("step $position: account is required")
        val account = accountRows[AccountId(step.accountId)] ?: throw invalid("step $position: no account ${step.accountId}")
        val toAccount = if (step.toAccountId > 0) {
            accountRows[AccountId(step.toAccountId)] ?: throw invalid("step $position: no account ${step.toAccountId}")
        } else null
        val security = if (step.securityId > 0) SecurityId(step.securityId) else null
        val shares = step.shares.value.trim().ifEmpty { null }?.let {
            try { BigDecimal(it) } catch (e: NumberFormatException) { throw invalid("step $position: shares \"$it\" is not a number") }
        }
        val amount = step.amount.value.trim().ifEmpty { null }?.let {
            try { BigDecimal(it) } catch (e: NumberFormatException) { throw invalid("step $position: amount \"$it\" is not a number") }
        }
        // Shape rules mirror the rules' own requirements, so the
        // stored row always reconstructs into a valid PlanStep.
        when (kind) {
            StepKind.BUY, StepKind.SELL -> {
                if (security == null) throw invalid("step $position: security is required")
                if ((shares == null) == (amount == null)) throw invalid("step $position: give shares or an amount, not both")
            }
            StepKind.TRANSFER -> {
                if (toAccount == null || toAccount.id == account.id) throw invalid("step $position: transfer needs a different destination account")
                if (amount == null) throw invalid("step $position: amount is required")
            }
            StepKind.ADD_EXTERNAL, StepKind.DRAW_EXTERNAL -> if (amount == null) throw invalid("step $position: amount is required")
        }
        if (shares != null && shares.signum() <= 0) throw invalid("step $position: shares must be positive")
        if (amount != null && amount.signum() <= 0) throw invalid("step $position: amount must be positive")
        return PlanStepInputRecord(
            kind = kind.name,
            accountId = account.id,
            toAccountId = toAccount?.id,
            securityId = security,
            shares = shares,
            amount = amount,
            note = step.note.trim().take(255),
        )
    }

    private fun ruleStep(position: Int, s: PlanStepInputRecord, currency: CurrencyUnit): PlanStep = PlanStep(
        position = position,
        kind = StepKind.valueOf(s.kind),
        accountId = s.accountId,
        toAccountId = s.toAccountId,
        securityId = s.securityId,
        shares = s.shares?.let { net.stewart.finance.domain.Quantity.of(it) },
        amount = s.amount?.let { Money.of(it, currency) },
        note = s.note,
    )

    private fun className(raw: String, inputs: PlanInputs): String {
        val name = raw.trim()
        if (name !in inputs.classes) throw invalid("unknown asset class \"$name\"")
        return name
    }

    private fun planName(raw: String): String {
        val name = raw.trim()
        if (name.isEmpty()) throw invalid("plan name is required")
        if (name.length > 120) throw invalid("plan name exceeds 120 characters")
        return name
    }

    private fun findPlan(raw: Long, portfolioId: PortfolioId): PlanRecord {
        if (raw <= 0) throw invalid("plan id is required")
        return plans.find(PlanId(raw), portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no plan $raw"))
    }

    private fun portfolio(): PortfolioId =
        portfolios.portfolioFor(UserId(currentAuthUser().id))

    private fun invalid(message: String) =
        StatusException(Status.INVALID_ARGUMENT.withDescription(message))

    private fun failed(message: String) =
        StatusException(Status.FAILED_PRECONDITION.withDescription(message))
}
