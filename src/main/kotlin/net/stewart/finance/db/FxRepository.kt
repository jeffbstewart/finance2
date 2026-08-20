package net.stewart.finance.db

import java.math.BigDecimal
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.RateSource

/** Dated FX rates — the only path between currencies (build-scope §5). */
class FxRepository(private val dataSource: DataSource) {

    /** Inserts or replaces the rate for (base, quote, date). */
    fun upsert(
        base: CurrencyUnit,
        quote: CurrencyUnit,
        date: LocalDate,
        rate: BigDecimal,
        source: RateSource,
    ) {
        require(rate.signum() > 0) { "rate must be positive: $rate" }
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "MERGE INTO fx_rates (base_currency, quote_currency, rate_date, rate, source) " +
                    "KEY (base_currency, quote_currency, rate_date) VALUES (?, ?, ?, ?, ?)"
            ).use { stmt ->
                stmt.setString(1, base.code)
                stmt.setString(2, quote.code)
                stmt.setObject(3, date)
                stmt.setBigDecimal(4, rate)
                stmt.setString(5, source.dbValue)
                stmt.executeUpdate()
            }
        }
    }

    /** The most recent quote-per-base rate on or before [asOf], or null.
     *  A currency converts to itself at exactly 1 — no lookup. */
    fun latestRate(base: CurrencyUnit, quote: CurrencyUnit, asOf: LocalDate): BigDecimal? {
        if (base == quote) return BigDecimal.ONE
        return dataSource.connection.use { conn ->
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
}
