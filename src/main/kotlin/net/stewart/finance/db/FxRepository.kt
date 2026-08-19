package net.stewart.finance.db

import java.math.BigDecimal
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.CurrencyUnit

/** Dated FX rates — the only path between currencies (build-scope §5). */
class FxRepository(private val dataSource: DataSource) {

    /** The most recent quote-per-base rate on or before [asOf], or null. */
    fun latestRate(base: CurrencyUnit, quote: CurrencyUnit, asOf: LocalDate): BigDecimal? =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT rate FROM fx_rates WHERE base_currency = ? AND quote_currency = ? " +
                    "AND rate_date <= ? ORDER BY rate_date DESC LIMIT 1"
            ).use { stmt ->
                stmt.setString(1, base.code)
                stmt.setString(2, quote.code)
                stmt.setObject(3, asOf)
                val rs = stmt.executeQuery()
                if (rs.next()) rs.getBigDecimal(1) else null
            }
        }
}
