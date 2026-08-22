package net.stewart.finance.db

import java.math.RoundingMode
import java.sql.ResultSet
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import javax.sql.DataSource
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.MarketSource
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.feeds.DailyBar
import org.jdbi.v3.core.Jdbi

data class MarketHistoryPoint(
    val date: LocalDate,
    val close: Money,
    val adjustedClose: Money,
)

/**
 * Persisted daily bars for MARKET-locus securities - also the spec
 * sec. 6.1 restart-surviving cache (fetched_at drives freshness). Provider
 * values round HALF_EVEN to the canonical scales on write
 * (build-scope sec. 2); currency comes from the security row, never a
 * caller. Binding is by name (JDBI), never by position.
 */
class MarketPriceRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun upsertBars(securityId: SecurityId, bars: List<DailyBar>, source: MarketSource) {
        if (bars.isEmpty()) return
        jdbi.useHandle<Exception> { handle ->
            val batch = handle.prepareBatch(
                "MERGE INTO market_prices (security_id, price_date, open, high, low, close, " +
                    "adjusted_close, dividend, split_coefficient, volume, source, fetched_at) " +
                    "KEY (security_id, price_date) " +
                    "VALUES (:securityId, :priceDate, :open, :high, :low, :close, " +
                    ":adjustedClose, :dividend, :splitCoefficient, :volume, :source, CURRENT_TIMESTAMP)"
            )
            for (bar in bars) {
                batch
                    .bind("securityId", securityId.value)
                    .bind("priceDate", bar.date)
                    .bind("open", bar.open.money())
                    .bind("high", bar.high.money())
                    .bind("low", bar.low.money())
                    .bind("close", bar.close.money())
                    .bind("adjustedClose", bar.adjustedClose.money())
                    .bind("dividend", bar.dividend.money())
                    .bind("splitCoefficient", bar.splitCoefficient.setScale(8, RoundingMode.HALF_EVEN))
                    .bind("volume", bar.volume)
                    .bind("source", source.dbValue)
                    .add()
            }
            batch.execute()
        }
    }

    /** Latest close per MARKET security in the portfolio. */
    fun latestBySecurity(portfolioId: PortfolioId): Map<SecurityId, Money> =
        jdbi.withHandle<Map<SecurityId, Money>, Exception> { handle ->
            handle.createQuery(
                "SELECT m.security_id, s.currency, m.close FROM market_prices m " +
                    "JOIN securities s ON s.id = m.security_id " +
                    "WHERE s.portfolio_id = :portfolioId AND m.price_date = (" +
                    "  SELECT MAX(m2.price_date) FROM market_prices m2 WHERE m2.security_id = m.security_id)"
            )
                .bind("portfolioId", portfolioId.value)
                .map { rs, _ ->
                    SecurityId(rs.getLong("security_id")) to Money.of(
                        rs.getBigDecimal("close"), rs.currency()
                    )
                }
                .list()
                .toMap(linkedMapOf())
        }

    /** Date-ascending history with raw and adjusted closes. */
    fun history(securityId: SecurityId): List<MarketHistoryPoint> =
        jdbi.withHandle<List<MarketHistoryPoint>, Exception> { handle ->
            handle.createQuery(
                "SELECT m.price_date, m.close, m.adjusted_close, s.currency FROM market_prices m " +
                    "JOIN securities s ON s.id = m.security_id " +
                    "WHERE m.security_id = :securityId ORDER BY m.price_date"
            )
                .bind("securityId", securityId.value)
                .map { rs, _ ->
                    val currency = rs.currency()
                    MarketHistoryPoint(
                        date = rs.getObject("price_date", LocalDate::class.java),
                        close = Money.of(rs.getBigDecimal("close"), currency),
                        adjustedClose = Money.of(rs.getBigDecimal("adjusted_close"), currency),
                    )
                }
                .list()
        }

    /** Date-ascending adjusted closes since [since], per security - sparklines. */
    fun recentAdjustedBySecurity(portfolioId: PortfolioId, since: LocalDate): Map<SecurityId, List<Money>> =
        jdbi.withHandle<Map<SecurityId, List<Money>>, Exception> { handle ->
            val result = linkedMapOf<SecurityId, MutableList<Money>>()
            handle.createQuery(
                "SELECT m.security_id, s.currency, m.adjusted_close FROM market_prices m " +
                    "JOIN securities s ON s.id = m.security_id " +
                    "WHERE s.portfolio_id = :portfolioId AND m.price_date >= :since " +
                    "ORDER BY m.security_id, m.price_date"
            )
                .bind("portfolioId", portfolioId.value)
                .bind("since", since)
                .map { rs, _ ->
                    SecurityId(rs.getLong("security_id")) to
                        Money.of(rs.getBigDecimal("adjusted_close"), rs.currency())
                }
                .forEach { (id, price) -> result.getOrPut(id) { mutableListOf() }.add(price) }
            result
        }

    /** [recentAdjustedBySecurity] with dates, for sparklines that place dots. */
    fun recentDatedAdjustedBySecurity(portfolioId: PortfolioId, since: LocalDate): Map<SecurityId, List<Pair<LocalDate, Money>>> =
        jdbi.withHandle<Map<SecurityId, List<Pair<LocalDate, Money>>>, Exception> { handle ->
            val result = linkedMapOf<SecurityId, MutableList<Pair<LocalDate, Money>>>()
            handle.createQuery(
                "SELECT m.security_id, s.currency, m.price_date, m.adjusted_close FROM market_prices m " +
                    "JOIN securities s ON s.id = m.security_id " +
                    "WHERE s.portfolio_id = :portfolioId AND m.price_date >= :since " +
                    "ORDER BY m.security_id, m.price_date"
            )
                .bind("portfolioId", portfolioId.value)
                .bind("since", since)
                .map { rs, _ ->
                    SecurityId(rs.getLong("security_id")) to (
                        rs.getObject("price_date", LocalDate::class.java) to
                            Money.of(rs.getBigDecimal("adjusted_close"), rs.currency())
                    )
                }
                .forEach { (id, point) -> result.getOrPut(id) { mutableListOf() }.add(point) }
            result
        }

    fun lastFetchedAt(securityId: SecurityId): Instant? =
        jdbi.withHandle<Instant?, Exception> { handle ->
            handle.createQuery(
                "SELECT MAX(fetched_at) AS latest FROM market_prices WHERE security_id = :securityId"
            )
                .bind("securityId", securityId.value)
                .map { rs, _ -> rs.getObject("latest", OffsetDateTime::class.java)?.toInstant() }
                .one()
        }

    fun hasAny(securityId: SecurityId): Boolean = lastFetchedAt(securityId) != null

    private fun ResultSet.currency(): CurrencyUnit = CurrencyUnit.parse(getString("currency").trim())

    private fun java.math.BigDecimal.money(): java.math.BigDecimal =
        setScale(4, RoundingMode.HALF_EVEN)
}
