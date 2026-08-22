package net.stewart.finance

import io.grpc.Context
import io.grpc.Status
import io.grpc.StatusException
import java.time.LocalDate
import kotlinx.coroutines.runBlocking
import net.stewart.armeria.auth.GRPC_AUTH_USER_KEY
import net.stewart.finance.api.AccountValuation
import net.stewart.finance.api.PricingService
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.api.TradingPlanAssembler
import net.stewart.finance.auth.FinanceUser
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.AssetClassRepository
import net.stewart.finance.db.ClassificationRepository
import net.stewart.finance.db.FxRepository
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.MarketPriceRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.TargetAllocationRepository
import net.stewart.finance.db.TradingPlanRepository
import net.stewart.finance.domain.UserId
import net.stewart.finance.feeds.MarketData
import net.stewart.finance.proto.CreatePlanRequest
import net.stewart.finance.proto.Decimal
import net.stewart.finance.proto.DeletePlanRequest
import net.stewart.finance.proto.GetBuyCandidatesRequest
import net.stewart.finance.proto.GetPlanRequest
import net.stewart.finance.proto.GetSellCandidatesRequest
import net.stewart.finance.proto.ListPlansRequest
import net.stewart.finance.proto.MarkPlanPrintedRequest
import net.stewart.finance.proto.PlanStatus
import net.stewart.finance.proto.PlanStepInput
import net.stewart.finance.proto.SetPlanStatusRequest
import net.stewart.finance.proto.SetPlanStepsRequest
import net.stewart.finance.proto.StepKind
import net.stewart.finance.testsupport.SampleSeeder
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The service over the seeded sample portfolio (SampleSeeder): Vanguard
 * Brokerage (taxable: VTI lots, BONDX lot) and Roth IRA (tax-deferred:
 * VTI and GOLD holdings), EuroBank EUR Brokerage.
 */
class TradingPlanServiceTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    private val users by lazy { FinanceUserRepository(db.dataSource) }
    private val portfolios by lazy { PortfolioRepository(db.dataSource) }
    private val accounts by lazy { AccountRepository(db.dataSource) }
    private val securities by lazy { SecurityRepository(db.dataSource) }
    private val reporting by lazy { ReportingCurrency(FxRepository(db.dataSource)) }
    private val pricing by lazy {
        val marketRepo = MarketPriceRepository(db.dataSource)
        PricingService(PrivatePriceRepository(db.dataSource), marketRepo, MarketData(marketRepo, emptyList()))
    }
    private val assembler by lazy {
        TradingPlanAssembler(
            accounts, securities, LotRepository(db.dataSource), SaleRepository(db.dataSource),
            HoldingRepository(db.dataSource), ClassificationRepository(db.dataSource),
            AssetClassRepository(db.dataSource), TargetAllocationRepository(db.dataSource), pricing, reporting,
        )
    }
    private val service by lazy {
        TradingPlanGrpcService(portfolios, accounts, TradingPlanRepository(db.dataSource), assembler)
    }
    private lateinit var jeff: FinanceUser
    private lateinit var ids: Map<String, Long>

    @BeforeEach
    fun seed() {
        val seeder = SampleSeeder(db.dataSource)
        seeder.reset()
        jeff = users.findByUsername("jeff") ?: users.createUser("jeff", "hash", "Jeff")
        ids = seeder.seed(portfolios.portfolioFor(UserId(jeff.id)))
    }

    private fun <T> call(block: suspend () -> T): T {
        val ctx = Context.current().withValue(GRPC_AUTH_USER_KEY, jeff)
        val prev = ctx.attach()
        try {
            return runBlocking { block() }
        } finally {
            ctx.detach(prev)
        }
    }

    private fun statusOf(block: suspend () -> Unit): Status.Code = try {
        call(block)
        error("expected a StatusException")
    } catch (e: StatusException) {
        e.status.code
    }

    private fun decimal(v: String): Decimal = Decimal.newBuilder().setValue(v).build()

    @Test
    fun `a new plan projects the portfolio unchanged, then steps move it`() {
        val created = call { service.createPlan(CreatePlanRequest.newBuilder().setName("  Autumn rebalance ").build()) }.plan
        assertEquals("Autumn rebalance", created.summary.name)
        assertEquals(PlanStatus.PLAN_OPEN, created.summary.status)
        val empty = created.projection
        assertEquals(empty.currentTotal, empty.projectedTotal)
        assertTrue(empty.executable)
        for (c in empty.classesList) assertEquals(c.before, c.after, c.name)
        assertTrue(empty.classesList.any { it.hasTargetFraction() }, "the seeded target is applied")

        // Add $1,000 from outside to the Roth, then buy $400 of VTI there.
        val roth = ids.getValue("account.roth")
        val vti = ids.getValue("security.vti")
        val scored = call {
            service.setPlanSteps(
                SetPlanStepsRequest.newBuilder().setPlanId(created.summary.planId)
                    .addSteps(PlanStepInput.newBuilder().setKind(StepKind.STEP_ADD_EXTERNAL).setAccountId(roth).setAmount(decimal("1000")).setNote("Q3"))
                    .addSteps(PlanStepInput.newBuilder().setKind(StepKind.STEP_BUY).setAccountId(roth).setSecurityId(vti).setAmount(decimal("400")))
                    .build()
            )
        }.plan
        assertEquals(2, scored.summary.stepCount)
        assertEquals("1,000.00", scored.projection.externalIn.display.filter { it.isDigit() || it == ',' || it == '.' })
        assertTrue(scored.projection.executable)
        val buy = scored.projection.stepsList[1]
        assertEquals("VTI", buy.ticker)
        assertTrue(buy.hasShares())
        assertTrue(buy.hasPlanPrice())
        val rothAfter = scored.projection.accountsList.single { it.accountId == roth }
        // 55.25 + 1000 - 400 = 655.25
        assertEquals("$655.25", rothAfter.sweepAfter.display)
        // The stored steps read back identically.
        val fetched = call { service.getPlan(GetPlanRequest.newBuilder().setPlanId(created.summary.planId).build()) }.plan
        assertEquals(2, fetched.projection.stepsCount)
        assertEquals("Q3", fetched.projection.stepsList[0].input.note)
    }

    @Test
    fun `malformed steps are refused before anything is stored`() {
        val plan = call { service.createPlan(CreatePlanRequest.newBuilder().setName("p").build()) }.plan
        val roth = ids.getValue("account.roth")
        suspend fun set(vararg steps: PlanStepInput.Builder) = service.setPlanSteps(
            SetPlanStepsRequest.newBuilder().setPlanId(plan.summary.planId).addAllSteps(steps.map { it.build() }).build()
        )
        // A buy with both shares and amount; a transfer to itself; a draw with no amount.
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf {
            set(PlanStepInput.newBuilder().setKind(StepKind.STEP_BUY).setAccountId(roth).setSecurityId(ids.getValue("security.vti")).setShares(decimal("1")).setAmount(decimal("1")))
        })
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf {
            set(PlanStepInput.newBuilder().setKind(StepKind.STEP_TRANSFER).setAccountId(roth).setToAccountId(roth).setAmount(decimal("1")))
        })
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf {
            set(PlanStepInput.newBuilder().setKind(StepKind.STEP_DRAW_EXTERNAL).setAccountId(roth))
        })
        assertEquals(0, call { service.getPlan(GetPlanRequest.newBuilder().setPlanId(plan.summary.planId).build()) }.plan.summary.stepCount)
    }

    @Test
    fun `an overdraw is a problem on the step, not an adjustment, and the plan is not executable`() {
        val plan = call { service.createPlan(CreatePlanRequest.newBuilder().setName("p").build()) }.plan
        val roth = ids.getValue("account.roth")
        val scored = call {
            service.setPlanSteps(
                SetPlanStepsRequest.newBuilder().setPlanId(plan.summary.planId)
                    .addSteps(PlanStepInput.newBuilder().setKind(StepKind.STEP_DRAW_EXTERNAL).setAccountId(roth).setAmount(decimal("5000")))
                    .build()
            )
        }.plan
        assertFalse(scored.projection.executable)
        assertTrue(scored.projection.stepsList.single().problemsList.single().contains("Roth IRA sweep would be"))
        assertEquals(1, scored.summary.stepCount) // stored anyway: the human sees what it would take
    }

    @Test
    fun `a taxable sell carries an estimated gain and a tax-deferred one does not`() {
        val plan = call { service.createPlan(CreatePlanRequest.newBuilder().setName("p").build()) }.plan
        val brokerage = ids.getValue("account.brokerage")
        val roth = ids.getValue("account.roth")
        val vti = ids.getValue("security.vti")
        val scored = call {
            service.setPlanSteps(
                SetPlanStepsRequest.newBuilder().setPlanId(plan.summary.planId)
                    .addSteps(PlanStepInput.newBuilder().setKind(StepKind.STEP_SELL).setAccountId(brokerage).setSecurityId(vti).setShares(decimal("5")))
                    .addSteps(PlanStepInput.newBuilder().setKind(StepKind.STEP_SELL).setAccountId(roth).setSecurityId(vti).setShares(decimal("2")))
                    .build()
            )
        }.plan
        val taxable = scored.projection.stepsList[0]
        val deferred = scored.projection.stepsList[1]
        assertTrue(taxable.hasEstLongTermGain() || taxable.hasEstShortTermGain())
        assertFalse(deferred.hasEstLongTermGain() || deferred.hasEstShortTermGain())
        assertTrue(scored.projection.executable)
    }

    @Test
    fun `sell candidates for a class list every contributing position, tax-deferred first by default`() {
        val response = call { service.getSellCandidates(GetSellCandidatesRequest.newBuilder().setClassName("US Stock").build()) }
        assertTrue(response.orderCaption.startsWith("Ordered by tax consequence"))
        val tickers = response.candidatesList.map { "${it.accountName}:${it.ticker}" }
        // VTI is held in both the Roth (deferred) and the Brokerage (taxable); VTI-TR too, via its mirror's class? No -
        // VTI-TR carries its own US Stock classification in the seed.
        assertTrue(tickers.contains("Roth IRA:VTI"), tickers.toString())
        assertTrue(tickers.contains("Brokerage:VTI"), tickers.toString())
        val firstTaxable = response.candidatesList.indexOfFirst { !it.taxDeferred }
        val lastDeferred = response.candidatesList.indexOfLast { it.taxDeferred }
        assertTrue(lastDeferred < firstTaxable, "tax-deferred candidates precede taxable ones")
        val taxableVti = response.candidatesList.first { !it.taxDeferred && it.ticker == "VTI" }
        assertTrue(taxableVti.hasGainPerDollar())
        assertFalse(response.candidatesList.first { it.taxDeferred }.hasGainPerDollar())
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf {
            service.getSellCandidates(GetSellCandidatesRequest.newBuilder().setClassName("Unicorns").build())
        })
    }

    @Test
    fun `buy candidates are ordered by available cash, not tax status`() {
        val response = call { service.getBuyCandidates(GetBuyCandidatesRequest.newBuilder().setClassName("US Stock").build()) }
        val accountsInOrder = response.candidatesList.map { it.accountName }.distinct()
        // Brokerage sweeps $500 > Roth $55.25: Brokerage (taxable) first, despite the Roth being tax-deferred.
        assertEquals(listOf("Brokerage", "Roth IRA"), accountsInOrder.filter { it == "Brokerage" || it == "Roth IRA" })
        assertTrue(response.candidatesList.all { it.hasAvailableSweep() && it.hasPlanPrice() })
    }

    @Test
    fun `plans list newest first, print stamps a date, archive hides and blocks edits, delete removes`() {
        val a = call { service.createPlan(CreatePlanRequest.newBuilder().setName("a").build()) }.plan
        val b = call { service.createPlan(CreatePlanRequest.newBuilder().setName("b").build()) }.plan
        assertEquals(listOf("b", "a"), call { service.listPlans(ListPlansRequest.getDefaultInstance()) }.plansList.map { it.name })

        val printed = call { service.markPlanPrinted(MarkPlanPrintedRequest.newBuilder().setPlanId(a.summary.planId).build()) }.summary
        assertTrue(printed.lastPrintedAt.isNotEmpty())

        call { service.setPlanStatus(SetPlanStatusRequest.newBuilder().setPlanId(a.summary.planId).setStatus(PlanStatus.PLAN_ARCHIVED).build()) }
        assertEquals(listOf("b"), call { service.listPlans(ListPlansRequest.getDefaultInstance()) }.plansList.map { it.name })
        assertEquals(listOf("b", "a"), call { service.listPlans(ListPlansRequest.newBuilder().setIncludeArchived(true).build()) }.plansList.map { it.name })
        assertEquals(Status.Code.FAILED_PRECONDITION, statusOf {
            service.setPlanSteps(SetPlanStepsRequest.newBuilder().setPlanId(a.summary.planId).build())
        })

        call { service.deletePlan(DeletePlanRequest.newBuilder().setPlanId(b.summary.planId).build()) }
        assertEquals(Status.Code.NOT_FOUND, statusOf {
            service.getPlan(GetPlanRequest.newBuilder().setPlanId(b.summary.planId).build())
        })
    }
}
