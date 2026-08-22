package net.stewart.finance.feeds

import java.time.LocalDate
import java.time.YearMonth
import net.stewart.finance.db.CpiRepository
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CpiFeedTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    @Test
    fun `seeds from the embedded snapshot, then refreshes from FRED`() {
        val repo = CpiRepository(db.dataSource)
        val feed = CpiFeed(repo) { "observation_date,CPIAUCSL\n2026-08-01,333.100\n" }

        assertTrue(repo.isEmpty())
        assertEquals(null, feed.series())

        feed.seedIfEmpty()
        val seeded = feed.series()!!
        assertEquals(YearMonth.parse("1947-01"), seeded.firstMonth)
        assertTrue(seeded.lastMonth >= YearMonth.parse("2026-07"), "snapshot is current: ${seeded.lastMonth}")

        // Seeding is a first-boot-only affair; a refresh extends the
        // persisted series (2026-08 follows the snapshot's last month).
        feed.seedIfEmpty()
        feed.refresh()
        feed.refresh() // idempotent
        val refreshed = feed.series()!!
        assertEquals(YearMonth.parse("2026-08"), refreshed.lastMonth)

        // The persisted series converts sanely: identity on same date,
        // and a known 1947->snapshot-era ratio is > 1.
        val today = LocalDate.parse("2026-08-15")
        assertEquals(
            Money.of("100", CurrencyUnit.USD),
            refreshed.convert(Money.of("100", CurrencyUnit.USD), today, today),
        )
        assertTrue(
            refreshed.convert(
                Money.of("100", CurrencyUnit.USD), LocalDate.parse("1947-01-01"), today
            ) > Money.of("1000", CurrencyUnit.USD),
        )
    }
}
