package net.stewart.finance.db

import java.math.BigDecimal
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.RateSource
import org.jdbi.v3.core.Jdbi

/** Dated FX rates — the only path between currencies (build-scope §5). */
class FxRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    /**
     * Inserts or replaces the rate for (base, quote, date).
     *
     * Semantics: [rate] is quote units per one base unit —
     * amountInQuote = amountInBase × rate (e.g. base EUR, quote USD,
     * rate 1.16 means 1 EUR = 1.16 USD). A pair converts to itself
     * only via [latestRate]'s identity; storing one is a caller bug.
     */
    fun upsert(
        base: CurrencyUnit,
        quote: CurrencyUnit,
        date: LocalDate,
        rate: BigDecimal,
        source: RateSource,
    ) {
        require(base != quote) { "self-conversion rates are not stored: $base" }
        require(rate.signum() > 0) { "rate must be positive: $rate" }
        jdbi.sql { handle ->
            handle.createUpdate(
                "MERGE INTO fx_rates (base_currency, quote_currency, rate_date, rate, source) " +
                    "KEY (base_currency, quote_currency, rate_date) " +
                    "VALUES (:base, :quote, :date, :rate, :source)"
            )
                .bind("base", base.code)
                .bind("quote", quote.code)
                .bind("date", date)
                .bind("rate", rate)
                .bind("source", source.dbValue)
                .execute()
        }
    }

    /** The most recent quote-per-base rate on or before [asOf], or null.
     *  A currency converts to itself at exactly 1 — no lookup. */
    fun latestRate(base: CurrencyUnit, quote: CurrencyUnit, asOf: LocalDate): BigDecimal? {
        if (base == quote) return BigDecimal.ONE
        return jdbi.sql { handle ->
            handle.createQuery(
                "SELECT rate FROM fx_rates WHERE base_currency = :base AND quote_currency = :quote " +
                    "AND rate_date <= :asOf ORDER BY rate_date DESC LIMIT 1"
            )
                .bind("base", base.code)
                .bind("quote", quote.code)
                .bind("asOf", asOf)
                .mapTo(BigDecimal::class.java)
                .findOne()
                .orElse(null)
        }
    }
}
