package net.stewart.finance.db

import javax.sql.DataSource
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.PortfolioId
import org.jdbi.v3.core.Jdbi

/**
 * The portfolio's target allocation fractions (spec sec. 4.2, sec. 9.13),
 * keyed by asset-class name - the class table's numeric key stays a
 * database implementation detail inside this repository's SQL.
 */
class TargetAllocationRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    /** Empty map = no target stored (the UI prompts; never a default). */
    fun get(portfolioId: PortfolioId): Map<String, Fraction> = jdbi.sql { handle ->
        val result = linkedMapOf<String, Fraction>()
        handle.createQuery(
            "SELECT c.name, t.fraction FROM target_allocations t " +
                "JOIN asset_classes c ON c.id = t.asset_class_id " +
                "WHERE t.portfolio_id = :portfolioId ORDER BY c.display_order"
        )
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.getString("name") to Fraction.of(rs.getBigDecimal("fraction")) }
            .forEach { (name, fraction) -> result[name] = fraction }
        result
    }

    /**
     * Replaces the portfolio's target atomically. Every key must be a
     * seeded class name; an unknown name throws IllegalArgumentException
     * (callers validate first - this is the backstop).
     */
    fun replace(portfolioId: PortfolioId, entries: Map<String, Fraction>) {
        jdbi.sqlTransaction { handle ->
            handle.createUpdate("DELETE FROM target_allocations WHERE portfolio_id = :portfolioId")
                .bind("portfolioId", portfolioId.value)
                .execute()
            val batch = handle.prepareBatch(
                "INSERT INTO target_allocations (portfolio_id, asset_class_id, fraction) " +
                    "SELECT :portfolioId, id, :fraction FROM asset_classes WHERE name = :name"
            )
            for ((name, fraction) in entries) {
                batch
                    .bind("portfolioId", portfolioId.value)
                    .bind("fraction", fraction.value)
                    .bind("name", name)
                    .add()
            }
            val inserted = batch.execute()
            inserted.forEachIndexed { i, count ->
                require(count == 1) { "unknown asset class \"${entries.keys.elementAt(i)}\"" }
            }
        }
    }
}
