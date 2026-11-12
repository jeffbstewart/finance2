package net.stewart.finance.feeds

import java.math.BigDecimal
import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

// Synthetic payloads shaped like the providers' documented responses - 
// never captured data (Decision 4 persistence boundary).

private const val TIINGO_BODY = """[
  {"date":"2026-08-18T00:00:00.000Z","close":101.25,"high":102.0,"low":100.1,"open":100.5,
   "volume":1234567,"adjClose":100.9975,"adjHigh":102.0,"adjLow":100.1,"adjOpen":100.5,
   "adjVolume":1234567,"divCash":0.25,"splitFactor":1.0},
  {"date":"2026-08-17T00:00:00.000Z","close":99.5,"high":99.9,"low":99.0,"open":99.1,
   "volume":1000,"adjClose":99.5,"adjHigh":99.9,"adjLow":99.0,"adjOpen":99.1,
   "adjVolume":1000,"divCash":0.0,"splitFactor":1.0}
]"""

private const val EODHD_BODY = """[
  {"date":"2026-08-18","open":100.5,"high":102,"low":100.1,"close":101.25,
   "adjusted_close":99.9975,"volume":1234567}
]"""

class PriceSourceClientsTest {

    @Test
    fun `tiingo parses the full field list as exact decimals, ascending`() {
        var requested = ""
        var headers = emptyMap<String, String>()
        val source = TiingoPriceSource("we\$ird%tok") { url, h ->
            requested = url; headers = h; HttpResult(200, TIINGO_BODY)
        }
        val bars = source.dailyBars("VTI", LocalDate.parse("2026-08-01"))
        assertTrue(requested.contains("tiingo/daily/VTI/prices") && requested.contains("startDate=2026-08-01"))
        // The token rides the Authorization header, never the URL - 
        // $ and % in real tokens must not touch URI parsing.
        assertEquals("Token we\$ird%tok", headers["Authorization"])
        assertTrue(!requested.contains("tok"))
        assertEquals(2, bars.size)
        assertEquals(LocalDate.parse("2026-08-17"), bars[0].date) // sorted ascending
        val bar = bars[1]
        assertEquals(BigDecimal("101.25"), bar.close)
        assertEquals(BigDecimal("100.9975"), bar.adjustedClose)
        assertEquals(BigDecimal("0.25"), bar.dividend)
        assertEquals(BigDecimal("1.0"), bar.splitCoefficient)
        assertEquals(1234567L, bar.volume)
    }

    @Test
    fun `tiingo maps quota, unknown ticker, and garbage distinctly`() {
        assertFailsWith<QuotaExceededException> {
            TiingoPriceSource("k") { _, _ -> HttpResult(429, "") }.dailyBars("VTI", null)
        }
        assertEquals(
            emptyList(),
            TiingoPriceSource("k") { _, _ -> HttpResult(404, "") }.dailyBars("NOPE", null),
        )
        assertFailsWith<PriceSourceException> {
            TiingoPriceSource("k") { _, _ -> HttpResult(200, "not json") }.dailyBars("VTI", null)
        }
        assertFailsWith<PriceSourceException> {
            TiingoPriceSource("k") { _, _ -> HttpResult(500, "") }.dailyBars("VTI", null)
        }
    }

    @Test
    fun `eodhd parses bars with US suffix and default corporate actions`() {
        var requested = ""
        val source = EodhdPriceSource("we\$ird%tok") { url, _ ->
            requested = url; HttpResult(200, EODHD_BODY)
        }
        val bars = source.dailyBars("VTI", null)
        assertTrue(requested.contains("/eod/VTI.US?"))
        // Query-param tokens are URL-encoded so $ and % survive.
        assertTrue(requested.contains("api_token=we%24ird%25tok"))
        val bar = bars.single()
        assertEquals(BigDecimal("99.9975"), bar.adjustedClose)
        assertEquals(BigDecimal.ZERO, bar.dividend)
        assertEquals(BigDecimal.ONE, bar.splitCoefficient)
    }

    @Test
    fun `eodhd maps payment-required and rate limits to quota`() {
        assertFailsWith<QuotaExceededException> {
            EodhdPriceSource("k") { _, _ -> HttpResult(402, "") }.dailyBars("VTI", null)
        }
        assertFailsWith<QuotaExceededException> {
            EodhdPriceSource("k") { _, _ -> HttpResult(429, "") }.dailyBars("VTI", null)
        }
    }
}
