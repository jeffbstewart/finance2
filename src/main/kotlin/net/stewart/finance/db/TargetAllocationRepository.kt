package net.stewart.finance.db

import javax.sql.DataSource
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.PortfolioId

/**
 * The portfolio's target allocation fractions (spec §4.2, §9.13),
 * keyed by asset-class name — the class table's numeric key stays a
 * database implementation detail inside this repository's SQL.
 */
class TargetAllocationRepository(private val dataSource: DataSource) {

    /** Empty map = no target stored (the UI prompts; never a default). */
    fun get(portfolioId: PortfolioId): Map<String, Fraction> =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT c.name, t.fraction FROM target_allocations t " +
                    "JOIN asset_classes c ON c.id = t.asset_class_id " +
                    "WHERE t.portfolio_id = ? ORDER BY c.display_order"
            ).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                val rs = stmt.executeQuery()
                val result = linkedMapOf<String, Fraction>()
                while (rs.next()) {
                    result[rs.getString("name")] = Fraction.of(rs.getBigDecimal("fraction"))
                }
                result
            }
        }

    /**
     * Replaces the portfolio's target atomically. Every key must be a
     * seeded class name; an unknown name throws IllegalArgumentException
     * (callers validate first — this is the backstop).
     */
    fun replace(portfolioId: PortfolioId, entries: Map<String, Fraction>) {
        dataSource.connection.use { conn ->
            conn.autoCommit = false
            try {
                conn.prepareStatement("DELETE FROM target_allocations WHERE portfolio_id = ?").use { stmt ->
                    stmt.setLong(1, portfolioId.value)
                    stmt.executeUpdate()
                }
                conn.prepareStatement(
                    "INSERT INTO target_allocations (portfolio_id, asset_class_id, fraction) " +
                        "SELECT ?, id, ? FROM asset_classes WHERE name = ?"
                ).use { stmt ->
                    for ((name, fraction) in entries) {
                        stmt.setLong(1, portfolioId.value)
                        stmt.setBigDecimal(2, fraction.value)
                        stmt.setString(3, name)
                        stmt.addBatch()
                    }
                    val inserted = stmt.executeBatch()
                    inserted.forEachIndexed { i, count ->
                        require(count == 1) {
                            "unknown asset class \"${entries.keys.elementAt(i)}\""
                        }
                    }
                }
                conn.commit()
            } catch (e: Exception) {
                conn.rollback()
                throw e
            } finally {
                conn.autoCommit = true
            }
        }
    }
}
