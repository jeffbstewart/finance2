package net.stewart.finance

import io.grpc.Context
import io.grpc.Status
import io.grpc.StatusException
import java.time.LocalDate
import kotlinx.coroutines.runBlocking
import net.stewart.armeria.auth.GRPC_AUTH_USER_KEY
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.AssetClassRepository
import net.stewart.finance.db.BrokerRepository
import net.stewart.finance.db.ClassificationRepository
import net.stewart.finance.db.FxRepository
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.domain.ClassificationKind
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.EntrySource
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.UserId
import net.stewart.finance.proto.Decimal
import net.stewart.finance.proto.GetAllocationRequest
import net.stewart.finance.proto.SetTargetAllocationRequest
import net.stewart.finance.proto.TargetEntry
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private fun decimal(v: String): Decimal = Decimal.newBuilder().setValue(v).build()

class AllocationServiceTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()

        private val users by lazy { FinanceUserRepository(db.dataSource) }
        private val jeff by lazy { users.createUser("jeff", "hash", "Jeff") }
        private val portfolios by lazy { PortfolioRepository(db.dataSource) }
        private val assetClasses by lazy { AssetClassRepository(db.dataSource) }
        private val service by lazy {
            val marketRepo = net.stewart.finance.db.MarketPriceRepository(db.dataSource)
            AllocationGrpcService(
                portfolios, AccountRepository(db.dataSource), SecurityRepository(db.dataSource),
                LotRepository(db.dataSource), SaleRepository(db.dataSource),
                HoldingRepository(db.dataSource),
                net.stewart.finance.api.PricingService(
                    PrivatePriceRepository(db.dataSource), marketRepo,
                    net.stewart.finance.feeds.MarketData(marketRepo, emptyList()),
                ),
                ClassificationRepository(db.dataSource), assetClasses,
                net.stewart.finance.db.TargetAllocationRepository(db.dataSource),
                ReportingCurrency(FxRepository(db.dataSource)),
            )
        }

        /**
         * $500 of a US-stock fund (20 lots-shares at $25) in a taxable
         * account with $400 sweeps, plus a $100 bond holding in an IRA:
         * total 1000 = US Stock 500 + Bond 100 + Cash 400.
         */
        private val fixture by lazy {
            val portfolioId = portfolios.portfolioFor(UserId(jeff.id))
            val brokerId = BrokerRepository(db.dataSource).create(portfolioId, "Vanguard")
            val accounts = AccountRepository(db.dataSource)
            val taxable = accounts.create(brokerId, "Brokerage", "X-1", CurrencyUnit.USD, taxDeferred = false)
            val ira = accounts.create(brokerId, "IRA", "X-2", CurrencyUnit.USD, taxDeferred = true)
            accounts.update(
                taxable, "Brokerage", "X-1", false,
                Money.of("400", CurrencyUnit.USD), EntrySource.MANUAL, LocalDate.now(),
            )
            val securities = SecurityRepository(db.dataSource)
            val classifications = ClassificationRepository(db.dataSource)
            val prices = PrivatePriceRepository(db.dataSource)
            val vti = securities.create(portfolioId, "VTI", CurrencyUnit.USD)
            prices.add(vti, LocalDate.now().minusDays(1), Money.of("25", CurrencyUnit.USD))
            classifications.replace(
                vti, ClassificationKind.ASSET_CLASS,
                mapOf("US Stock" to Fraction.ONE), LocalDate.now(),
            )
            val bnd = securities.create(portfolioId, "BND", CurrencyUnit.USD)
            prices.add(bnd, LocalDate.now().minusDays(1), Money.of("80", CurrencyUnit.USD))
            classifications.replace(
                bnd, ClassificationKind.ASSET_CLASS,
                mapOf("Bond" to Fraction.ONE), LocalDate.now(),
            )
            LotRepository(db.dataSource).create(
                taxable, vti, LocalDate.now().minusYears(2),
                Quantity.of("20"), Money.of("10", CurrencyUnit.USD), Money.zero(CurrencyUnit.USD),
            )
            HoldingRepository(db.dataSource).upsert(
                ira, bnd, Quantity.of("1.25"), EntrySource.MANUAL, LocalDate.now(),
            )
            Fixture(taxable.value, bnd.value)
        }
    }

    private data class Fixture(val taxableId: Long, val bndId: Long)

    private fun <T> call(block: suspend () -> T): T {
        val ctx = Context.current().withValue(GRPC_AUTH_USER_KEY, jeff as net.stewart.auth.AuthUser)
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

    @Test
    fun `dashboard and target editing`() {
        val f = fixture

        // Before any target: current buckets only, no invented default.
        val untargeted = call { service.getAllocation(GetAllocationRequest.getDefaultInstance()) }
        assertTrue(!untargeted.targetSet)
        assertEquals("$1,000.00", untargeted.portfolioTotal.display)
        val byName = untargeted.classesList.associateBy { it.name }
        assertEquals("$500.00", byName.getValue("US Stock").current.display)
        assertEquals("$100.00", byName.getValue("Bond").current.display)
        assertEquals("$400.00", byName.getValue("Cash").current.display)
        assertEquals("50%", byName.getValue("US Stock").currentFraction.display)
        // The sweeps contributor is synthetic; the fund contributor
        // carries its share count.
        assertEquals("Sweeps", byName.getValue("Cash").contributorsList.single().ticker)
        assertEquals("20", byName.getValue("US Stock").contributorsList.single().shares.display)

        // Targets must sum to 1.
        assertEquals(
            Status.Code.INVALID_ARGUMENT,
            statusOf {
                service.setTargetAllocation(
                    SetTargetAllocationRequest.newBuilder()
                        .addEntries(entry("US Stock", "0.5")).build()
                )
            },
        )
        call {
            service.setTargetAllocation(
                SetTargetAllocationRequest.newBuilder()
                    .addEntries(entry("Cash", "0.1"))
                    .addEntries(entry("US Stock", "0.6"))
                    .addEntries(entry("Bond", "0.3"))
                    .build()
            )
        }

        // Drift: targets partition the total; deltas match by hand.
        val targeted = call { service.getAllocation(GetAllocationRequest.getDefaultInstance()) }
        assertTrue(targeted.targetSet)
        val targetedByName = targeted.classesList.associateBy { it.name }
        assertEquals("$600.00", targetedByName.getValue("US Stock").target.display)
        assertEquals("$100.00", targetedByName.getValue("US Stock").delta.display)
        assertEquals("$200.00", targetedByName.getValue("Bond").delta.display)
        assertEquals("($300.00)", targetedByName.getValue("Cash").delta.display)

    }

    private fun entry(className: String, fraction: String): TargetEntry =
        TargetEntry.newBuilder()
            .setAssetClass(className)
            .setFraction(decimal(fraction))
            .build()

    private fun fixtureVtiId(): Long =
        SecurityRepository(db.dataSource)
            .list(portfolios.portfolioFor(UserId(jeff.id)), includeHidden = false)
            .single { it.ticker == "VTI" }.id.value
}
