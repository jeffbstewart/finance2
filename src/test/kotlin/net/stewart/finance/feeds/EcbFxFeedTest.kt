package net.stewart.finance.feeds

import java.math.BigDecimal
import java.time.LocalDate
import net.stewart.finance.db.FxRepository
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

// Trimmed from the real eurofxref-hist-90d.xml shape.
private val ECB_XML = """
<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time="2026-08-19">
      <Cube currency="USD" rate="1.1605"/>
      <Cube currency="JPY" rate="184.62"/>
    </Cube>
    <Cube time="2026-08-18">
      <Cube currency="USD" rate="1.1580"/>
      <Cube currency="JPY" rate="184.11"/>
    </Cube>
  </Cube>
</gesmes:Envelope>
""".trim()

class EcbFxFeedTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    @Test
    fun `parses USD rates by date as exact decimals`() {
        val rates = parseEcbUsdRates(ECB_XML)
        assertEquals(BigDecimal("1.1605"), rates.getValue(LocalDate.parse("2026-08-19")))
        assertEquals(BigDecimal("1.1580"), rates.getValue(LocalDate.parse("2026-08-18")))
        assertEquals(2, rates.size)
    }

    @Test
    fun `rejects documents without USD and doctype smuggling`() {
        assertFailsWith<IllegalArgumentException> {
            parseEcbUsdRates("""<Cube><Cube time="2026-08-19"/></Cube>""")
        }
        assertFailsWith<Exception> {
            parseEcbUsdRates("""<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><Cube>&e;</Cube>""")
        }
    }

    @Test
    fun `refresh persists rates idempotently and latestRate serves them`() {
        db.dataSource.connection.use { conn ->
            conn.createStatement().executeUpdate("DELETE FROM fx_rates")
        }
        val fx = FxRepository(db.dataSource)
        val feed = EcbFxFeed(fx, fetch = { ECB_XML }, fetchFullHistory = { ECB_XML })
        feed.refresh()
        feed.refresh() // MERGE: reruns must not fail or duplicate
        assertEquals(
            BigDecimal("1.16050000"),
            fx.latestRate(CurrencyUnit.EUR, CurrencyUnit.USD, LocalDate.parse("2026-08-19")),
        )
        // On the 18th the 19th's rate is not yet visible.
        assertEquals(
            BigDecimal("1.15800000"),
            fx.latestRate(CurrencyUnit.EUR, CurrencyUnit.USD, LocalDate.parse("2026-08-18")),
        )
        db.dataSource.connection.use { conn ->
            val rs = conn.createStatement()
                .executeQuery("SELECT COUNT(*), MIN(source) FROM fx_rates")
            rs.next()
            assertEquals(2, rs.getInt(1))
            assertEquals("ecb", rs.getString(2))
        }
    }

    @Test
    fun `first refresh backfills the full archive, later runs use the window`() {
        db.dataSource.connection.use { conn ->
            conn.createStatement().executeUpdate("DELETE FROM fx_rates")
        }
        val fx = FxRepository(db.dataSource)
        var fullFetches = 0
        var windowFetches = 0
        val deepHistory = ECB_XML.replace("2026-08-18", "1999-01-04")
        val feed = EcbFxFeed(
            fx,
            fetch = { windowFetches++; ECB_XML },
            fetchFullHistory = { fullFetches++; deepHistory },
        )
        // Empty store: purchase-date conversions need arbitrarily old
        // rates (build-scope §11), so the full archive comes first.
        feed.refresh()
        assertEquals(1, fullFetches)
        assertEquals(0, windowFetches)
        // With deep history present, the daily run uses the window.
        feed.refresh()
        assertEquals(1, fullFetches)
        assertEquals(1, windowFetches)
        assertEquals(
            BigDecimal("1.15800000"),
            fx.latestRate(CurrencyUnit.EUR, CurrencyUnit.USD, LocalDate.parse("2000-01-01")),
        )
    }
}
