package net.stewart.finance.db

import javax.sql.DataSource
import net.stewart.finance.domain.AssetClassId
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.PortfolioId

/** The portfolio's target allocation fractions (spec §4.2, §9.13). */
class TargetAllocationRepository(private val dataSource: DataSource) {

    /** Empty map = no target stored (the UI prompts; never a default). */
    fun get(portfolioId: PortfolioId): Map<AssetClassId, Fraction> =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT asset_class_id, fraction FROM target_allocations WHERE portfolio_id = ?"
            ).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                val rs = stmt.executeQuery()
                val result = linkedMapOf<AssetClassId, Fraction>()
                while (rs.next()) {
                    result[AssetClassId(rs.getLong("asset_class_id"))] =
                        Fraction.of(rs.getBigDecimal("fraction"))
                }
                result
            }
        }

    /** Replaces the portfolio's target atomically. */
    fun replace(portfolioId: PortfolioId, entries: Map<AssetClassId, Fraction>) {
        dataSource.connection.use { conn ->
            conn.autoCommit = false
            try {
                conn.prepareStatement("DELETE FROM target_allocations WHERE portfolio_id = ?").use { stmt ->
                    stmt.setLong(1, portfolioId.value)
                    stmt.executeUpdate()
                }
                conn.prepareStatement(
                    "INSERT INTO target_allocations (portfolio_id, asset_class_id, fraction) VALUES (?, ?, ?)"
                ).use { stmt ->
                    for ((classId, fraction) in entries) {
                        stmt.setLong(1, portfolioId.value)
                        stmt.setLong(2, classId.value)
                        stmt.setBigDecimal(3, fraction.value)
                        stmt.addBatch()
                    }
                    stmt.executeBatch()
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
