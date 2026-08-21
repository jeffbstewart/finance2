package net.stewart.finance.db

import java.sql.ResultSet
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PriceId
import net.stewart.finance.domain.SecurityId
import org.jdbi.v3.core.Jdbi

data class PrivatePriceRow(
    val id: PriceId,
    val securityId: SecurityId,
    val date: LocalDate,
    val price: Money,
)

/**
 * Hand-entered price history for MANUAL-locus securities (spec §5.6);
 * prices are in the security's currency, read from the security row in
 * the same query — never asserted by a caller.
 */
class PrivatePriceRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    /** Newest first, for the price-history editor (spec §9.12). */
    fun list(securityId: SecurityId): List<PrivatePriceRow> = jdbi.sql { handle ->
        handle.createQuery(
            "SELECT p.id, p.security_id, p.price_date, p.price, s.currency FROM private_prices p " +
                "JOIN securities s ON s.id = p.security_id " +
                "WHERE p.security_id = :securityId ORDER BY p.price_date DESC"
        )
            .bind("securityId", securityId.value)
            .map { rs, _ -> rs.toRow() }
            .list()
    }

    /** Date-ascending closes for charts and indicators. */
    fun history(securityId: SecurityId): List<PrivatePriceRow> = list(securityId).asReversed()

    /**
     * Date-ascending closes since [since] for every non-hidden
     * security in the portfolio — one query feeds every sparkline
     * (the legacy N+1, defect 11, must not return).
     */
    fun recentBySecurity(portfolioId: PortfolioId, since: LocalDate): Map<SecurityId, List<Money>> =
        jdbi.sql { handle ->
            val result = linkedMapOf<SecurityId, MutableList<Money>>()
            handle.createQuery(
                "SELECT p.security_id, s.currency, p.price FROM private_prices p " +
                    "JOIN securities s ON s.id = p.security_id " +
                    "WHERE s.portfolio_id = :portfolioId AND p.price_date >= :since " +
                    "ORDER BY p.security_id, p.price_date"
            )
                .bind("portfolioId", portfolioId.value)
                .bind("since", since)
                .map { rs, _ ->
                    SecurityId(rs.getLong("security_id")) to Money.of(
                        rs.getBigDecimal("price"),
                        CurrencyUnit.parse(rs.getString("currency").trim()),
                    )
                }
                .forEach { (id, price) -> result.getOrPut(id) { mutableListOf() }.add(price) }
            result
        }

    /**
     * The newest price per MANUAL-locus security in the portfolio —
     * the "latest price" source for valuing manually priced holdings
     * (spec §5.6). Currency from the security row.
     */
    fun latestBySecurity(portfolioId: PortfolioId): Map<SecurityId, Money> = jdbi.sql { handle ->
        val result = linkedMapOf<SecurityId, Money>()
        handle.createQuery(
            "SELECT p.security_id, s.currency, p.price FROM private_prices p " +
                "JOIN securities s ON s.id = p.security_id " +
                "WHERE s.portfolio_id = :portfolioId AND p.price_date = (" +
                "  SELECT MAX(p2.price_date) FROM private_prices p2 WHERE p2.security_id = p.security_id)"
        )
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ ->
                SecurityId(rs.getLong("security_id")) to Money.of(
                    rs.getBigDecimal("price"),
                    CurrencyUnit.parse(rs.getString("currency").trim()),
                )
            }
            .forEach { (id, price) -> result[id] = price }
        result
    }

    fun find(id: PriceId, portfolioId: PortfolioId): PrivatePriceRow? = jdbi.sql { handle ->
        handle.createQuery(
            "SELECT p.id, p.security_id, p.price_date, p.price, s.currency FROM private_prices p " +
                "JOIN securities s ON s.id = p.security_id " +
                "WHERE p.id = :id AND s.portfolio_id = :portfolioId"
        )
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRow() }
            .findOne()
            .orElse(null)
    }

    /** Throws SQLException on a duplicate (security, date). */
    fun add(securityId: SecurityId, date: LocalDate, price: Money): PriceId = jdbi.sql { handle ->
        PriceId(
            handle.createUpdate(
                "INSERT INTO private_prices (security_id, price_date, price) " +
                    "VALUES (:securityId, :date, :price)"
            )
                .bind("securityId", securityId.value)
                .bind("date", date)
                .bind("price", price.amount)
                .executeAndReturnGeneratedKeys("id")
                .mapTo(Long::class.java)
                .one()
        )
    }

    /**
     * Records (or replaces) the price for a date from an import —
     * `source` names the provenance (e.g. "plaid") the way holdings
     * carry theirs; hand-entered rows keep the column's default.
     */
    fun upsert(securityId: SecurityId, date: LocalDate, price: Money, source: String) {
        jdbi.sql { handle ->
            handle.createUpdate(
                "MERGE INTO private_prices (security_id, price_date, price, source) " +
                    "KEY (security_id, price_date) VALUES (:securityId, :date, :price, :source)"
            )
                .bind("securityId", securityId.value)
                .bind("date", date)
                .bind("price", price.amount)
                .bind("source", source)
                .execute()
        }
    }

    /** Throws SQLException on a duplicate (security, date). */
    fun update(id: PriceId, date: LocalDate, price: Money): Boolean = jdbi.sql { handle ->
        handle.createUpdate(
            "UPDATE private_prices SET price_date = :date, price = :price WHERE id = :id"
        )
            .bind("date", date)
            .bind("price", price.amount)
            .bind("id", id.value)
            .execute() > 0
    }

    fun delete(id: PriceId): Boolean = jdbi.sql { handle ->
        handle.createUpdate("DELETE FROM private_prices WHERE id = :id")
            .bind("id", id.value)
            .execute() > 0
    }

    private fun ResultSet.toRow() = PrivatePriceRow(
        id = PriceId(getLong("id")),
        securityId = SecurityId(getLong("security_id")),
        date = getObject("price_date", LocalDate::class.java),
        price = Money.of(getBigDecimal("price"), CurrencyUnit.parse(getString("currency").trim())),
    )
}
