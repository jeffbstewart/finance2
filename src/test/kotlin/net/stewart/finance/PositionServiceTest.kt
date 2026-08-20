package net.stewart.finance

import io.grpc.Context
import io.grpc.Status
import io.grpc.StatusException
import kotlinx.coroutines.runBlocking
import net.stewart.armeria.auth.GRPC_AUTH_USER_KEY
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.BrokerRepository
import net.stewart.finance.db.ClassificationRepository
import net.stewart.finance.db.FxRepository
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.UserId
import net.stewart.finance.proto.AddPurchaseRequest
import net.stewart.finance.proto.Date
import net.stewart.finance.proto.Decimal
import net.stewart.finance.proto.DeleteHoldingRequest
import net.stewart.finance.proto.DeletePurchaseRequest
import net.stewart.finance.proto.GetLotDetailsRequest
import net.stewart.finance.proto.GetPurchaseFormInfoRequest
import net.stewart.finance.proto.GetTaxReportRequest
import net.stewart.finance.proto.ListPositionsRequest
import net.stewart.finance.proto.LotSaleAllocation
import net.stewart.finance.proto.RecordSaleRequest
import net.stewart.finance.proto.SetHoldingRequest
import net.stewart.finance.proto.UpdatePurchaseRequest
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private fun date(y: Int, m: Int, d: Int): Date =
    Date.newBuilder().setYear(y).setMonth(m).setDay(d).build()

private fun decimal(v: String): Decimal = Decimal.newBuilder().setValue(v).build()

class PositionServiceTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()

        private val users by lazy { FinanceUserRepository(db.dataSource) }
        private val jeff by lazy { users.createUser("jeff", "hash", "Jeff") }
        private val portfolios by lazy { PortfolioRepository(db.dataSource) }
        private val accounts by lazy { AccountRepository(db.dataSource) }
        private val securities by lazy { SecurityRepository(db.dataSource) }
        private val privatePrices by lazy { PrivatePriceRepository(db.dataSource) }
        private val pricing by lazy {
            val marketRepo = net.stewart.finance.db.MarketPriceRepository(db.dataSource)
            net.stewart.finance.api.PricingService(
                privatePrices, marketRepo, net.stewart.finance.feeds.MarketData(marketRepo, emptyList()),
            )
        }
        private val service by lazy {
            PositionGrpcService(
                portfolios, accounts, securities,
                LotRepository(db.dataSource), SaleRepository(db.dataSource),
                HoldingRepository(db.dataSource), pricing,
                ReportingCurrency(FxRepository(db.dataSource)),
            )
        }

        /** One taxable and one tax-deferred USD account plus a priced security. */
        private val fixture by lazy {
            val portfolioId = portfolios.portfolioFor(UserId(jeff.id))
            val brokerId = BrokerRepository(db.dataSource).create(portfolioId, "Vanguard")
            val taxable = accounts.create(brokerId, "Brokerage", "X-1", CurrencyUnit.USD, taxDeferred = false)
            val ira = accounts.create(brokerId, "IRA", "X-2", CurrencyUnit.USD, taxDeferred = true)
            val trust = securities.create(portfolioId, "TRUST-A", CurrencyUnit.USD)
            privatePrices.add(trust, java.time.LocalDate.now().minusDays(1), usd("25.00"))
            Fixture(portfolioId, taxable.value, ira.value, trust.value)
        }

        private fun usd(s: String) = net.stewart.finance.domain.Money.of(s, CurrencyUnit.USD)
    }

    private data class Fixture(
        val portfolioId: PortfolioId,
        val taxableId: Long,
        val iraId: Long,
        val securityId: Long,
    )

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
    fun `full trade lifecycle - purchases, positions, sale, tax report`() {
        val f = fixture

        // Purchases go to taxable accounts only; tax-deferred rejects.
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf {
                service.addPurchase(purchase(f.iraId, f.securityId, "10", "10.00"))
            },
        )
        val lot1 = call { service.addPurchase(purchase(f.taxableId, f.securityId, "10", "10.00", commission = "10.00")) }.lotId
        val lot2 = call { service.addPurchase(purchase(f.taxableId, f.securityId, "5", "20.00", y = 2026, m = 6, d = 1)) }.lotId

        // Positions: 15 shares at $25, basis 110 (lot1) + 100 (lot2).
        val positions = call { service.listPositions(ListPositionsRequest.getDefaultInstance()) }
        val row = positions.positionsList.single { it.securityId == f.securityId }
        assertEquals("15", row.shares.display)
        assertEquals("$210.00", row.basis.display)
        assertEquals("$375.00", row.currentValue.display)
        assertEquals("$375.00", positions.totalValue.display)

        // Sale validation: overselling a lot is rejected before insert.
        assertEquals(
            Status.Code.INVALID_ARGUMENT,
            statusOf {
                service.recordSale(
                    sale(f.taxableId, f.securityId, "11", "30.00", lot1 to "11")
                )
            },
        )
        // A coherent multi-lot sale (LT lot1 + ST lot2 shares).
        call {
            service.recordSale(
                sale(f.taxableId, f.securityId, "5", "30.00", lot1 to "3", lot2 to "2", costs = "9.00")
            )
        }

        // Lot details: still-held shares and the sale history render.
        val details = call {
            service.getLotDetails(GetLotDetailsRequest.newBuilder().setSecurityId(f.securityId).build())
        }
        assertEquals(listOf("7", "3"), details.lotsList.map { it.sharesStillHeld.display })
        val saleRow = details.salesList.single()
        assertEquals("5", saleRow.shares.display)
        // lot1: (30−10)×3 − $3 pro-rated − 3/5 of $9 = $51.60 long-term.
        assertEquals("$51.60", saleRow.longTermGain.display)
        // lot2: (30−20)×2 − 2/5 of $9 = $16.40 short-term.
        assertEquals("$16.40", saleRow.shortTermGain.display)

        // The tax report covers the sale, portfolio-scoped, USD-only.
        val report = call {
            service.getTaxReport(
                GetTaxReportRequest.newBuilder()
                    .setFrom(date(2026, 1, 1)).setTo(date(2026, 12, 31)).build()
            )
        }
        assertEquals(2, report.rowsCount) // one row per (sale, lot)
        assertEquals("$51.60", report.totalLongTermGain.display)
        assertEquals("$16.40", report.totalShortTermGain.display)
        assertEquals("$68.00", report.totalGain.display)

        // Guard rails: a lot with sales cannot shrink below what was
        // sold, and cannot be deleted.
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf {
                service.updatePurchase(
                    UpdatePurchaseRequest.newBuilder()
                        .setLotId(lot1).setBought(date(2024, 1, 10))
                        .setShares(decimal("2")).setPricePerShare(decimal("10.00"))
                        .setCommission(decimal("10.00")).build()
                )
            },
        )
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf { service.deletePurchase(DeletePurchaseRequest.newBuilder().setLotId(lot1).build()) },
        )
    }

    @Test
    fun `tax-deferred holdings value positions without lots or basis`() {
        val f = fixture

        // SetHolding is the tax-deferred path; taxable accounts reject it.
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf {
                service.setHolding(
                    SetHoldingRequest.newBuilder()
                        .setAccountId(f.taxableId).setSecurityId(f.securityId)
                        .setQuantity(decimal("4")).build()
                )
            },
        )
        call {
            service.setHolding(
                SetHoldingRequest.newBuilder()
                    .setAccountId(f.iraId).setSecurityId(f.securityId)
                    .setQuantity(decimal("4.5")).build()
            )
        }
        val positions = call {
            service.listPositions(ListPositionsRequest.newBuilder().setAccountId(f.iraId).build())
        }
        val row = positions.positionsList.single()
        assertEquals("4.5", row.shares.display)
        assertEquals("$112.50", row.currentValue.display) // 4.5 × $25
        assertEquals("$0.00", row.basis.display)          // no basis in tax-deferred (§1)
        assertEquals("manual", row.provenance.source)

        call {
            service.deleteHolding(
                DeleteHoldingRequest.newBuilder()
                    .setAccountId(f.iraId).setSecurityId(f.securityId).build()
            )
        }
        assertTrue(
            call { service.listPositions(ListPositionsRequest.newBuilder().setAccountId(f.iraId).build()) }
                .positionsList.isEmpty()
        )
    }

    @Test
    fun `unpriced positions fail the request and the form info lists choices`() {
        val f = fixture
        val portfolioId = f.portfolioId
        val unpriced = securities.create(portfolioId, "NOPRICE", CurrencyUnit.USD)
        call {
            service.setHolding(
                SetHoldingRequest.newBuilder()
                    .setAccountId(f.iraId).setSecurityId(unpriced.value)
                    .setQuantity(decimal("1")).build()
            )
        }
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf { service.listPositions(ListPositionsRequest.getDefaultInstance()) },
        )
        call {
            service.deleteHolding(
                DeleteHoldingRequest.newBuilder()
                    .setAccountId(f.iraId).setSecurityId(unpriced.value).build()
            )
        }

        val form = call { service.getPurchaseFormInfo(GetPurchaseFormInfoRequest.getDefaultInstance()) }
        assertTrue(form.accountsList.any { it.name == "Brokerage" && !it.taxDeferred })
        assertTrue(form.accountsList.any { it.name == "IRA" && it.taxDeferred })
        assertTrue(form.securitiesList.any { it.ticker == "TRUST-A" })
    }

    @Test
    fun `inflation-adjusted lot details need CPI data and pass through flat CPI`() {
        val f = fixture
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf {
                service.getLotDetails(
                    GetLotDetailsRequest.newBuilder()
                        .setSecurityId(f.securityId).setInflationAdjusted(true).build()
                )
            },
        )

        val flat = net.stewart.finance.rules.CpiSeries(
            (0L..35L).associate {
                java.time.YearMonth.parse("2024-01").plusMonths(it) to java.math.BigDecimal("100")
            }
        )
        val inflationService = PositionGrpcService(
            portfolios, accounts, securities,
            LotRepository(db.dataSource), SaleRepository(db.dataSource),
            HoldingRepository(db.dataSource), pricing,
            ReportingCurrency(FxRepository(db.dataSource)),
            cpiSeries = { flat },
        )
        val lots = LotRepository(db.dataSource)
        val portfolioId = f.portfolioId
        val lotId = lots.create(
            net.stewart.finance.domain.AccountId(f.taxableId),
            net.stewart.finance.domain.SecurityId(f.securityId),
            java.time.LocalDate.parse("2024-06-01"),
            Quantity.of("2"), usd("10.00"), usd("1.00"),
        )
        try {
            val details = asUserCall {
                inflationService.getLotDetails(
                    GetLotDetailsRequest.newBuilder()
                        .setSecurityId(f.securityId).setInflationAdjusted(true).build()
                )
            }
            assertTrue(details.inflationAdjusted)
            val row = details.lotsList.single { it.lotId == lotId.value }
            // Flat CPI: adjusted cost columns equal nominal.
            assertEquals("$10.00", row.buyPricePerShare.display)
            assertEquals("$1.00", row.commission.display)
            assertEquals("$21.00", row.basis.display) // 2×10 + 1
        } finally {
            lots.delete(lotId)
        }
    }

    private fun asUserCall(block: suspend () -> net.stewart.finance.proto.GetLotDetailsResponse) =
        call(block)

    private fun purchase(
        accountId: Long,
        securityId: Long,
        shares: String,
        price: String,
        commission: String = "0",
        y: Int = 2024,
        m: Int = 1,
        d: Int = 10,
    ) = AddPurchaseRequest.newBuilder()
        .setAccountId(accountId).setSecurityId(securityId)
        .setBought(date(y, m, d))
        .setShares(decimal(shares)).setPricePerShare(decimal(price)).setCommission(decimal(commission))
        .build()

    private fun sale(
        accountId: Long,
        securityId: Long,
        shares: String,
        price: String,
        vararg allocations: Pair<Long, String>,
        costs: String = "0",
    ) = RecordSaleRequest.newBuilder()
        .setAccountId(accountId).setSecurityId(securityId)
        .setSold(date(2026, 7, 1))
        .setShares(decimal(shares)).setPricePerShare(decimal(price)).setSaleCosts(decimal(costs))
        .addAllAllocations(
            allocations.map { (lotId, qty) ->
                LotSaleAllocation.newBuilder().setLotId(lotId).setShares(decimal(qty)).build()
            }
        )
        .build()
}
