package net.stewart.finance.db

import java.math.BigDecimal
import java.time.LocalDate
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class FxRepositoryTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    private val repo get() = FxRepository(db.dataSource)
    private val today = LocalDate.parse("2026-08-19")

    @Test
    fun `self-currency conversion is exactly one, no lookup`() {
        // No rows in fx_rates at all - the identity needs none.
        assertEquals(BigDecimal.ONE, repo.latestRate(CurrencyUnit.USD, CurrencyUnit.USD, today))
        assertEquals(BigDecimal.ONE, repo.latestRate(CurrencyUnit.EUR, CurrencyUnit.EUR, today))
        // And storing a self-conversion rate is a caller bug.
        kotlin.test.assertFailsWith<IllegalArgumentException> {
            repo.upsert(
                CurrencyUnit.USD, CurrencyUnit.USD, today, BigDecimal.ONE,
                net.stewart.finance.domain.RateSource.MANUAL,
            )
        }
    }

    @Test
    fun `latest rate on or before the date wins, absent pairs are null`() {
        db.dataSource.connection.use { conn ->
            conn.createStatement().executeUpdate(
                "INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate, source) VALUES " +
                    "('EUR', 'USD', DATE '2026-08-01', 1.05000000, 'test'), " +
                    "('EUR', 'USD', DATE '2026-08-15', 1.10000000, 'test'), " +
                    "('EUR', 'USD', DATE '2026-09-01', 1.20000000, 'test')"
            )
        }
        assertEquals(BigDecimal("1.10000000"), repo.latestRate(CurrencyUnit.EUR, CurrencyUnit.USD, today))
        assertNull(repo.latestRate(CurrencyUnit.USD, CurrencyUnit.EUR, today)) // direction matters
    }
}
