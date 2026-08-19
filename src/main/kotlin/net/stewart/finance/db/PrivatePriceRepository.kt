package net.stewart.finance.db

import java.sql.ResultSet
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PriceId
import net.stewart.finance.domain.SecurityId

data class PrivatePriceRow(
    val id: PriceId,
    val securityId: SecurityId,
    val date: LocalDate,
    val price: Money,
)

/**
 * Hand-entered price history for MANUAL-locus securities (spec §5.6);
 * prices are in the security's currency.
 */
class PrivatePriceRepository(private val dataSource: DataSource) {

    /** Newest first, for the price-history editor (spec §9.12). */
    fun list(securityId: SecurityId, currency: CurrencyUnit): List<PrivatePriceRow> =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT id, security_id, price_date, price FROM private_prices " +
                    "WHERE security_id = ? ORDER BY price_date DESC"
            ).use { stmt ->
                stmt.setLong(1, securityId.value)
                val rs = stmt.executeQuery()
                buildList { while (rs.next()) add(rs.toRow(currency)) }
            }
        }

    /** Date-ascending closes for charts and indicators. */
    fun history(securityId: SecurityId, currency: CurrencyUnit): List<PrivatePriceRow> =
        list(securityId, currency).asReversed()

    /**
     * Date-ascending closes since [since] for every non-hidden
     * security in the portfolio — one query feeds every sparkline
     * (the legacy N+1, defect 11, must not return).
     */
    fun recentBySecurity(portfolioId: PortfolioId, since: LocalDate): Map<SecurityId, List<Money>> =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT p.security_id, s.currency, p.price FROM private_prices p " +
                    "JOIN securities s ON s.id = p.security_id " +
                    "WHERE s.portfolio_id = ? AND p.price_date >= ? ORDER BY p.security_id, p.price_date"
            ).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                stmt.setObject(2, since)
                val rs = stmt.executeQuery()
                val result = linkedMapOf<SecurityId, MutableList<Money>>()
                while (rs.next()) {
                    val id = SecurityId(rs.getLong("security_id"))
                    val currency = CurrencyUnit.parse(rs.getString("currency").trim())
                    result.getOrPut(id) { mutableListOf() }
                        .add(Money.of(rs.getBigDecimal("price"), currency))
                }
                result
            }
        }

    fun find(id: PriceId, portfolioId: PortfolioId): PrivatePriceRow? =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT p.id, p.security_id, p.price_date, p.price, s.currency FROM private_prices p " +
                    "JOIN securities s ON s.id = p.security_id WHERE p.id = ? AND s.portfolio_id = ?"
            ).use { stmt ->
                stmt.setLong(1, id.value)
                stmt.setLong(2, portfolioId.value)
                val rs = stmt.executeQuery()
                if (rs.next()) rs.toRow(CurrencyUnit.parse(rs.getString("currency").trim())) else null
            }
        }

    /** Throws SQLException on a duplicate (security, date). */
    fun add(securityId: SecurityId, date: LocalDate, price: Money): PriceId =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "INSERT INTO private_prices (security_id, price_date, price) VALUES (?, ?, ?)",
                java.sql.Statement.RETURN_GENERATED_KEYS,
            ).use { stmt ->
                stmt.setLong(1, securityId.value)
                stmt.setObject(2, date)
                stmt.setBigDecimal(3, price.amount)
                stmt.executeUpdate()
                PriceId(stmt.generatedKeys.also { check(it.next()) }.getLong(1))
            }
        }

    /** Throws SQLException on a duplicate (security, date). */
    fun update(id: PriceId, date: LocalDate, price: Money): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "UPDATE private_prices SET price_date = ?, price = ? WHERE id = ?"
            ).use { stmt ->
                stmt.setObject(1, date)
                stmt.setBigDecimal(2, price.amount)
                stmt.setLong(3, id.value)
                stmt.executeUpdate() > 0
            }
        }

    fun delete(id: PriceId): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement("DELETE FROM private_prices WHERE id = ?").use { stmt ->
                stmt.setLong(1, id.value)
                stmt.executeUpdate() > 0
            }
        }

    private fun ResultSet.toRow(currency: CurrencyUnit) = PrivatePriceRow(
        id = PriceId(getLong("id")),
        securityId = SecurityId(getLong("security_id")),
        date = getObject("price_date", LocalDate::class.java),
        price = Money.of(getBigDecimal("price"), currency),
    )
}
