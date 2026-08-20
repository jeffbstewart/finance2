package net.stewart.finance.db

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

data class MarketHistoryPoint(
    val date: LocalDate,
    val close: Money,
    val adjustedClose: Money,
)

/**
 * Persisted daily bars for MARKET-locus securities — also the spec
 * §6.1 restart-surviving cache (fetched_at drives freshness). Provider
 * values round HALF_EVEN to the canonical scales on write
 * (build-scope §2); currency comes from the security row, never a
 * caller.
 */
class MarketPriceRepository(private val dataSource: DataSource) {

    fun upsertBars(securityId: SecurityId, bars: List<DailyBar>, source: MarketSource) {
        if (bars.isEmpty()) return
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "MERGE INTO market_prices (security_id, price_date, open, high, low, close, " +
                    "adjusted_close, dividend, split_coefficient, volume, source, fetched_at) " +
                    "KEY (security_id, price_date) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
            ).use { stmt ->
                for (bar in bars) {
                    stmt.setLong(1, securityId.value)
                    stmt.setObject(2, bar.date)
                    stmt.setBigDecimal(3, bar.open.money())
                    stmt.setBigDecimal(4, bar.high.money())
                    stmt.setBigDecimal(5, bar.low.money())
                    stmt.setBigDecimal(6, bar.close.money())
                    stmt.setBigDecimal(7, bar.adjustedClose.money())
                    stmt.setBigDecimal(8, bar.dividend.money())
                    stmt.setBigDecimal(9, bar.splitCoefficient.setScale(8, java.math.RoundingMode.HALF_EVEN))
                    stmt.setLong(10, bar.volume)
                    stmt.setString(11, source.dbValue)
                    stmt.addBatch()
                }
                stmt.executeBatch()
            }
        }
    }

    /** Latest close per MARKET security in the portfolio. */
    fun latestBySecurity(portfolioId: PortfolioId): Map<SecurityId, Money> =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT m.security_id, s.currency, m.close FROM market_prices m " +
                    "JOIN securities s ON s.id = m.security_id " +
                    "WHERE s.portfolio_id = ? AND m.price_date = (" +
                    "  SELECT MAX(m2.price_date) FROM market_prices m2 WHERE m2.security_id = m.security_id)"
            ).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                val rs = stmt.executeQuery()
                val result = linkedMapOf<SecurityId, Money>()
                while (rs.next()) {
                    result[SecurityId(rs.getLong("security_id"))] = Money.of(
                        rs.getBigDecimal("close"),
                        CurrencyUnit.parse(rs.getString("currency").trim()),
                    )
                }
                result
            }
        }

    /** Date-ascending history with raw and adjusted closes. */
    fun history(securityId: SecurityId): List<MarketHistoryPoint> =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT m.price_date, m.close, m.adjusted_close, s.currency FROM market_prices m " +
                    "JOIN securities s ON s.id = m.security_id " +
                    "WHERE m.security_id = ? ORDER BY m.price_date"
            ).use { stmt ->
                stmt.setLong(1, securityId.value)
                val rs = stmt.executeQuery()
                buildList {
                    while (rs.next()) {
                        val currency = CurrencyUnit.parse(rs.getString("currency").trim())
                        add(
                            MarketHistoryPoint(
                                date = rs.getObject("price_date", LocalDate::class.java),
                                close = Money.of(rs.getBigDecimal("close"), currency),
                                adjustedClose = Money.of(rs.getBigDecimal("adjusted_close"), currency),
                            )
                        )
                    }
                }
            }
        }

    /** Date-ascending adjusted closes since [since], per security — sparklines. */
    fun recentAdjustedBySecurity(portfolioId: PortfolioId, since: LocalDate): Map<SecurityId, List<Money>> =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT m.security_id, s.currency, m.adjusted_close FROM market_prices m " +
                    "JOIN securities s ON s.id = m.security_id " +
                    "WHERE s.portfolio_id = ? AND m.price_date >= ? ORDER BY m.security_id, m.price_date"
            ).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                stmt.setObject(2, since)
                val rs = stmt.executeQuery()
                val result = linkedMapOf<SecurityId, MutableList<Money>>()
                while (rs.next()) {
                    result.getOrPut(SecurityId(rs.getLong("security_id"))) { mutableListOf() }.add(
                        Money.of(
                            rs.getBigDecimal("adjusted_close"),
                            CurrencyUnit.parse(rs.getString("currency").trim()),
                        )
                    )
                }
                result
            }
        }

    fun lastFetchedAt(securityId: SecurityId): Instant? =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT MAX(fetched_at) FROM market_prices WHERE security_id = ?"
            ).use { stmt ->
                stmt.setLong(1, securityId.value)
                val rs = stmt.executeQuery()
                if (rs.next()) rs.getObject(1, OffsetDateTime::class.java)?.toInstant() else null
            }
        }

    fun hasAny(securityId: SecurityId): Boolean = lastFetchedAt(securityId) != null

    private fun java.math.BigDecimal.money(): java.math.BigDecimal =
        setScale(4, java.math.RoundingMode.HALF_EVEN)
}
