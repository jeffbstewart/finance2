package net.stewart.finance.feeds

import java.math.BigDecimal
import java.time.Duration
import java.time.LocalDate
import net.stewart.finance.db.MarketPriceRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.MarketSource
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.SecurityType
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

private fun bar(date: String, close: String) = DailyBar(
    date = LocalDate.parse(date),
    open = BigDecimal(close), high = BigDecimal(close), low = BigDecimal(close),
    close = BigDecimal(close), adjustedClose = BigDecimal(close),
    dividend = BigDecimal.ZERO, splitCoefficient = BigDecimal.ONE, volume = 100,
)

private class FakeSource(
    override val id: MarketSource,
    private val behavior: (String, LocalDate?) -> List<DailyBar>,
) : PriceSource {
    var calls = 0
    var lastStart: LocalDate? = LocalDate.MIN
    override fun dailyBars(ticker: String, startDate: LocalDate?): List<DailyBar> {
        calls++
        lastStart = startDate
        return behavior(ticker, startDate)
    }
}

class MarketDataTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    private val repo = MarketPriceRepository(db.dataSource)

    private fun marketSecurity(ticker: String): net.stewart.finance.db.SecurityRow {
        db.dataSource.connection.use { conn ->
            conn.createStatement().executeUpdate(
                "MERGE INTO portfolios (id, name) KEY (id) VALUES (1, 'p')"
            )
            conn.createStatement().executeUpdate(
                "INSERT INTO securities (portfolio_id, ticker, currency, pricing_locus) " +
                    "VALUES (1, '$ticker', 'USD', 'MARKET')"
            )
        }
        return SecurityRepository(db.dataSource)
            .list(PortfolioId(1), includeHidden = true).single { it.ticker == ticker }
    }

    @Test
    fun `first fetch is full history, refetch is recent, fresh is a no-op`() {
        val security = marketSecurity("VTI")
        val source = FakeSource(MarketSource.TIINGO) { _, _ ->
            listOf(bar("2026-08-18", "100.50"), bar("2026-08-19", "101.25"))
        }
        val market = MarketData(repo, listOf(source), requestSpacing = Duration.ZERO)

        market.ensureFresh(security)
        assertEquals(1, source.calls)
        assertNull(source.lastStart, "first acquaintance pulls full history")
        assertEquals(
            net.stewart.finance.domain.Money.of("101.25", CurrencyUnit.USD),
            repo.latestBySecurity(PortfolioId(1)).getValue(security.id),
        )

        // Within the TTL nothing refetches.
        market.ensureFresh(security)
        assertEquals(1, source.calls)

        // Backdate freshness: the next call refetches, recent window only.
        db.dataSource.connection.use { conn ->
            conn.createStatement().executeUpdate(
                "UPDATE market_prices SET fetched_at = DATEADD(DAY, -2, CURRENT_TIMESTAMP)"
            )
        }
        market.ensureFresh(security)
        assertEquals(2, source.calls)
        assertEquals(LocalDate.now().minusDays(45), source.lastStart)
    }

    @Test
    fun `quota on the primary fails over to the fallback`() {
        val security = marketSecurity("FALLBACK")
        val primary = FakeSource(MarketSource.TIINGO) { _, _ ->
            throw QuotaExceededException(MarketSource.TIINGO, "HTTP 429")
        }
        val fallback = FakeSource(MarketSource.EODHD) { _, _ -> listOf(bar("2026-08-19", "42")) }
        MarketData(repo, listOf(primary, fallback), requestSpacing = Duration.ZERO)
            .ensureFresh(security)
        assertEquals(1, primary.calls)
        assertEquals(1, fallback.calls)
        db.dataSource.connection.use { conn ->
            val rs = conn.createStatement().executeQuery(
                "SELECT source FROM market_prices WHERE security_id = ${security.id.value}"
            )
            rs.next()
            assertEquals("eodhd", rs.getString(1))
        }
    }

    @Test
    fun `all providers failing fails the fetch - none configured is dormant`() {
        val security = marketSecurity("DOOMED")
        val broken = FakeSource(MarketSource.TIINGO) { _, _ ->
            throw PriceSourceException("boom")
        }
        assertFailsWith<PriceSourceException> {
            MarketData(repo, listOf(broken), requestSpacing = Duration.ZERO).ensureFresh(security)
        }
        // Dormant module: no sources, no fetch, no failure.
        MarketData(repo, emptyList()).ensureFresh(security)
    }
}
