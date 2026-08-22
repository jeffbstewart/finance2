package net.stewart.finance.api

import io.grpc.Status
import io.grpc.StatusException
import java.math.BigDecimal
import java.time.LocalDate
import net.stewart.finance.db.FxRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.MtmMarkRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The sec. 1296 ledger over a real schema (build-scope sec. 11): a EUR fund
 * bought once, marked across years, with the FX chain and the
 * acquisition-cost floor exercised end to end.
 */
class MtmServiceTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    private val portfolioId = PortfolioId(1)
    private var priceHistory: List<PricingService.HistoryPoint> = emptyList()

    private val service
        get() = MtmService(
            lots = LotRepository(db.dataSource),
            sales = SaleRepository(db.dataSource),
            marks = MtmMarkRepository(db.dataSource),
            fx = FxRepository(db.dataSource),
            reporting = ReportingCurrency(FxRepository(db.dataSource)),
            history = { priceHistory },
        )

    private lateinit var security: SecurityRow

    @BeforeEach
    fun fixture() {
        val statements = listOf(
            "DELETE FROM mtm_marks",
            "DELETE FROM purchase_lots",
            "DELETE FROM sale_allocations",
            "DELETE FROM sales",
            "DELETE FROM securities",
            "DELETE FROM accounts",
            "DELETE FROM brokers",
            "DELETE FROM portfolios",
            "DELETE FROM fx_rates",
            "INSERT INTO portfolios (id, name) VALUES (1, 'test')",
            "INSERT INTO brokers (id, portfolio_id, name) VALUES (1, 1, 'EuroBank')",
            "INSERT INTO accounts (id, broker_id, name, account_number, currency) " +
                "VALUES (1, 1, 'EUR Brokerage', 'X-1', 'EUR')",
            "INSERT INTO securities (id, portfolio_id, ticker, currency, tax_treatment, pricing_locus) " +
                "VALUES (1, 1, 'EUFUND', 'EUR', 'MARK_TO_MARKET', 'MANUAL')",
            // 100 shares at EUR 90 plus EUR 10 costs on 2024-03-01:
            // EUR 9010 acquisition cost.
            "INSERT INTO purchase_lots (account_id, security_id, date_bought, quantity, price_per_share, purchase_costs) " +
                "VALUES (1, 1, DATE '2024-03-01', 100, 90.0000, 10.0000)",
            // EUR->USD: 1.10 at purchase, 1.00 at 2024 year end, 1.20
            // at 2025 year end.
            "INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate, source) VALUES " +
                "('EUR', 'USD', DATE '2024-03-01', 1.10000000, 'test'), " +
                "('EUR', 'USD', DATE '2024-12-31', 1.00000000, 'test'), " +
                "('EUR', 'USD', DATE '2025-12-31', 1.20000000, 'test')",
        )
        db.dataSource.connection.use { conn ->
            conn.createStatement().use { statement ->
                statements.forEach { statement.executeUpdate(it) }
            }
        }
        security = checkNotNull(SecurityRepository(db.dataSource).find(net.stewart.finance.domain.SecurityId(1), portfolioId))
        priceHistory = emptyList()
    }

    private fun eur(value: String) = Money.of(value, CurrencyUnit.EUR)
    private fun usd(value: String) = Money.of(value, CurrencyUnit.USD)

    @Test
    fun `acquisition cost converts each lot at its purchase-date rate`() {
        // EUR 9010 x 1.10 = USD 9911.
        assertEquals(usd("9911.0000"), service.acquisitionCostUsd(portfolioId, security))
    }

    @Test
    fun `first mark floors at acquisition cost when FMV is lower`() {
        // Year-end FMV EUR 9500 x 1.00 = USD 9500 < USD 9911 cost:
        // no inclusions to reverse, income 0, basis stays at cost.
        val mark = service.record(
            portfolioId, security, 2024, LocalDate.of(2024, 12, 31),
            Quantity.of("100"), eur("9500.0000"), BigDecimal("1.00000000"),
        )
        assertEquals(usd("9500.0000"), mark.fmvUsd)
        assertEquals(usd("9911.0000"), mark.basisBeforeUsd)
        assertEquals(usd("9911.0000"), mark.basisAfterUsd)
        assertEquals(usd("0.0000"), mark.ordinaryIncomeUsd)
    }

    @Test
    fun `second mark carries the chain and recognizes the gain`() {
        service.record(
            portfolioId, security, 2024, LocalDate.of(2024, 12, 31),
            Quantity.of("100"), eur("9500.0000"), BigDecimal("1.00000000"),
        )
        // FMV EUR 10000 x 1.20 = USD 12000; basis was 9911 -> +2089.
        val mark = service.record(
            portfolioId, security, 2025, LocalDate.of(2025, 12, 31),
            Quantity.of("100"), eur("10000.0000"), BigDecimal("1.20000000"),
        )
        assertEquals(usd("12000.0000"), mark.fmvUsd)
        assertEquals(usd("9911.0000"), mark.basisBeforeUsd)
        assertEquals(usd("12000.0000"), mark.basisAfterUsd)
        assertEquals(usd("2089.0000"), mark.ordinaryIncomeUsd)
    }

    @Test
    fun `marks must arrive in tax-year order and years never repeat`() {
        service.record(
            portfolioId, security, 2025, LocalDate.of(2025, 12, 31),
            Quantity.of("100"), eur("10000.0000"), BigDecimal("1.20000000"),
        )
        val outOfOrder = assertFailsWith<StatusException> {
            service.record(
                portfolioId, security, 2024, LocalDate.of(2024, 12, 31),
                Quantity.of("100"), eur("9500.0000"), BigDecimal("1.00000000"),
            )
        }
        assertEquals(Status.Code.FAILED_PRECONDITION, outOfOrder.status.code)
    }

    @Test
    fun `editing an early mark recomputes every later mark's chain`() {
        val first = service.record(
            portfolioId, security, 2024, LocalDate.of(2024, 12, 31),
            Quantity.of("100"), eur("9500.0000"), BigDecimal("1.00000000"),
        )
        val second = service.record(
            portfolioId, security, 2025, LocalDate.of(2025, 12, 31),
            Quantity.of("100"), eur("10000.0000"), BigDecimal("1.20000000"),
        )
        // Pre-edit: 2024 floored at cost (basis 9911), 2025 income 2089.
        assertEquals(usd("2089.0000"), second.ordinaryIncomeUsd)

        // The filed 2024 FMV was actually EUR 10500 (x 1.00 = USD
        // 10500, above the 9911 floor): 2024 recognizes 589, and 2025
        // restates against the new basis - 12000 - 10500 = 1500.
        val edited = service.update(
            portfolioId, security, first.id, LocalDate.of(2024, 12, 30),
            Quantity.of("100"), eur("10500.0000"), BigDecimal("1.00000000"),
        )
        assertEquals(LocalDate.of(2024, 12, 30), edited.markDate)
        assertEquals(usd("10500.0000"), edited.basisAfterUsd)
        assertEquals(usd("589.0000"), edited.ordinaryIncomeUsd)

        val restated = service.listForSecurity(security)
        assertEquals(usd("10500.0000"), restated[1].basisBeforeUsd)
        assertEquals(usd("1500.0000"), restated[1].ordinaryIncomeUsd)
        // The 2025 mark's own stored inputs were untouched.
        assertEquals(eur("10000.0000"), restated[1].fmvLocal)
        // Cumulative income still equals final basis - cost:
        // 589 + 1500 = 12000 - 9911.
        assertEquals(usd("12000.0000"), restated[1].basisAfterUsd)
    }

    @Test
    fun `a restated future mark clamps at the acquisition-cost floor`() {
        // Floor is USD 9911 (EUR 9010 x 1.10 at purchase).
        service.record(
            portfolioId, security, 2024, LocalDate.of(2024, 12, 31),
            Quantity.of("100"), eur("12000.0000"), BigDecimal("1.00000000"),
        )
        // 2025 FMV USD 9000 sits below the floor: basis clamps at
        // 9911 and only the 2024 inclusions reverse.
        val second = service.record(
            portfolioId, security, 2025, LocalDate.of(2025, 12, 31),
            Quantity.of("100"), eur("9000.0000"), BigDecimal("1.00000000"),
        )
        assertEquals(usd("9911.0000"), second.basisAfterUsd)
        assertEquals(usd("-2089.0000"), second.ordinaryIncomeUsd)

        // Editing 2024 down to FMV 10000 shrinks its inclusions to 89.
        // The restated 2025 mark would go 2089 below cost if it simply
        // took basis to FMV; the floor must hold in the chain walk
        // too, reversing only the remaining 89.
        val edited = service.update(
            portfolioId, security, service.listForSecurity(security)[0].id,
            LocalDate.of(2024, 12, 31),
            Quantity.of("100"), eur("10000.0000"), BigDecimal("1.00000000"),
        )
        assertEquals(usd("89.0000"), edited.ordinaryIncomeUsd)
        val restated = service.listForSecurity(security)[1]
        assertEquals(usd("10000.0000"), restated.basisBeforeUsd)
        assertEquals(usd("9911.0000"), restated.basisAfterUsd)
        assertEquals(usd("-89.0000"), restated.ordinaryIncomeUsd)
        // Cumulative income equals final basis - acquisition cost: 0.
        assertEquals(usd("0.0000"), edited.ordinaryIncomeUsd + restated.ordinaryIncomeUsd)
    }

    @Test
    fun `an edit cannot move a mark to another tax year`() {
        val mark = service.record(
            portfolioId, security, 2024, LocalDate.of(2024, 12, 31),
            Quantity.of("100"), eur("9500.0000"), BigDecimal("1.00000000"),
        )
        val rejected = assertFailsWith<StatusException> {
            service.update(
                portfolioId, security, mark.id, LocalDate.of(2025, 1, 2),
                Quantity.of("100"), eur("9500.0000"), BigDecimal("1.00000000"),
            )
        }
        assertEquals(Status.Code.INVALID_ARGUMENT, rejected.status.code)
    }

    @Test
    fun `only the latest mark deletes`() {
        val first = service.record(
            portfolioId, security, 2024, LocalDate.of(2024, 12, 31),
            Quantity.of("100"), eur("9500.0000"), BigDecimal("1.00000000"),
        )
        val second = service.record(
            portfolioId, security, 2025, LocalDate.of(2025, 12, 31),
            Quantity.of("100"), eur("10000.0000"), BigDecimal("1.20000000"),
        )
        val blocked = assertFailsWith<StatusException> { service.delete(portfolioId, first.id) }
        assertEquals(Status.Code.FAILED_PRECONDITION, blocked.status.code)
        service.delete(portfolioId, second.id)
        service.delete(portfolioId, first.id)
        assertTrue(service.listForSecurity(security).isEmpty())
    }

    @Test
    fun `suggestion computes from stored price and fx`() {
        priceHistory = listOf(
            PricingService.HistoryPoint(LocalDate.of(2024, 12, 30), eur("95.0000"), eur("95.0000")),
        )
        val suggestion = service.suggest(portfolioId, security, 2024)
        // 100 shares x EUR 95 = EUR 9500 at rate 1.00.
        assertEquals(eur("9500.0000"), suggestion.fmvLocal)
        assertEquals(0, BigDecimal("1.00000000").compareTo(suggestion.fxRate))
        assertEquals(usd("0.0000"), suggestion.computed?.ordinaryIncomeUsd)
        assertTrue(suggestion.notes.any { "2024-12-30" in it })
    }

    @Test
    fun `suggestion notes a missing year-end rate instead of failing`() {
        priceHistory = listOf(
            PricingService.HistoryPoint(LocalDate.of(2023, 12, 29), eur("92.0000"), eur("92.0000")),
        )
        // 2023 predates every stored rate - the ECB feed's 90-day
        // backfill makes this the common first-mark case.
        val suggestion = service.suggest(portfolioId, security, 2023)
        assertNull(suggestion.fxRate)
        assertNull(suggestion.computed)
        assertTrue(suggestion.notes.any { "enter the rate by hand" in it })
    }

    @Test
    fun `securities with sales are rejected until the sale ruling`() {
        db.dataSource.connection.use { conn ->
            conn.createStatement().executeUpdate(
                "INSERT INTO sales (account_id, security_id, sale_date, price_per_share, sale_costs) " +
                    "VALUES (1, 1, DATE '2025-06-01', 100.0000, 0)"
            )
        }
        val rejected = assertFailsWith<StatusException> {
            service.record(
                portfolioId, security, 2025, LocalDate.of(2025, 12, 31),
                Quantity.of("100"), eur("10000.0000"), BigDecimal("1.20000000"),
            )
        }
        assertEquals(Status.Code.FAILED_PRECONDITION, rejected.status.code)
    }

    @Test
    fun `lot-treatment securities cannot be marked`() {
        db.dataSource.connection.use { conn ->
            conn.createStatement().executeUpdate("UPDATE securities SET tax_treatment = 'LOTS' WHERE id = 1")
        }
        val lotsSecurity = checkNotNull(
            SecurityRepository(db.dataSource).find(net.stewart.finance.domain.SecurityId(1), portfolioId)
        )
        val rejected = assertFailsWith<StatusException> {
            service.record(
                portfolioId, lotsSecurity, 2024, LocalDate.of(2024, 12, 31),
                Quantity.of("100"), eur("9500.0000"), BigDecimal("1.00000000"),
            )
        }
        assertEquals(Status.Code.FAILED_PRECONDITION, rejected.status.code)
    }
}
