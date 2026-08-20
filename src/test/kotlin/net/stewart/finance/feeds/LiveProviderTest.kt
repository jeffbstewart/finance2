package net.stewart.finance.feeds

import java.time.LocalDate
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Live-API validation (MODERNIZATION goal 4): runs only when the
 * provider key is in the environment, so CI stays secret-free.
 * Fetched data is asserted and discarded — never persisted to the
 * repository.
 */
class LiveProviderTest {

    @Test
    @EnabledIfEnvironmentVariable(named = "TIINGO_API_KEY", matches = ".+")
    fun `tiingo serves recent VTI bars with adjusted closes`() {
        val bars = TiingoPriceSource(System.getenv("TIINGO_API_KEY"))
            .dailyBars("VTI", LocalDate.now().minusDays(20))
        assertTrue(bars.isNotEmpty())
        assertTrue(bars.all { it.close.signum() > 0 && it.adjustedClose.signum() > 0 })
        assertTrue(bars.zipWithNext().all { (a, b) -> a.date < b.date })
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "TIINGO_API_KEY", matches = ".+")
    fun `tiingo serves mutual fund NAVs`() {
        val bars = TiingoPriceSource(System.getenv("TIINGO_API_KEY"))
            .dailyBars("VTSAX", LocalDate.now().minusDays(20))
        assertTrue(bars.isNotEmpty())
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "EODHD_API_KEY", matches = ".+")
    fun `eodhd serves recent VTI bars with adjusted closes`() {
        val bars = EodhdPriceSource(System.getenv("EODHD_API_KEY"))
            .dailyBars("VTI", LocalDate.now().minusDays(20))
        assertTrue(bars.isNotEmpty())
        assertTrue(bars.all { it.adjustedClose.signum() > 0 })
    }
}
