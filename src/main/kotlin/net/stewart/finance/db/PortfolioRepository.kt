package net.stewart.finance.db

import javax.sql.DataSource
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.UserId

/**
 * Portfolio lookup with the spec §3.2 behavior: each user operates on
 * one portfolio named "default", created (with its grant) on first
 * authenticated use.
 */
class PortfolioRepository(private val dataSource: DataSource) {

    private val createLock = Any()

    fun portfolioFor(userId: UserId): PortfolioId {
        find(userId)?.let { return it }
        synchronized(createLock) {
            find(userId)?.let { return it }
            dataSource.connection.use { conn ->
                conn.autoCommit = false
                try {
                    val portfolioId = conn.prepareStatement(
                        "INSERT INTO portfolios (name) VALUES ('default')",
                        java.sql.Statement.RETURN_GENERATED_KEYS,
                    ).use { stmt ->
                        stmt.executeUpdate()
                        stmt.generatedKeys.also { check(it.next()) }.getLong(1)
                    }
                    conn.prepareStatement(
                        "INSERT INTO portfolio_grants (user_id, portfolio_id) VALUES (?, ?)"
                    ).use { stmt ->
                        stmt.setLong(1, userId.value)
                        stmt.setLong(2, portfolioId)
                        stmt.executeUpdate()
                    }
                    conn.commit()
                    return PortfolioId(portfolioId)
                } catch (e: Exception) {
                    conn.rollback()
                    throw e
                } finally {
                    conn.autoCommit = true
                }
            }
        }
    }

    private fun find(userId: UserId): PortfolioId? =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT portfolio_id FROM portfolio_grants WHERE user_id = ? LIMIT 1"
            ).use { stmt ->
                stmt.setLong(1, userId.value)
                val rs = stmt.executeQuery()
                if (rs.next()) PortfolioId(rs.getLong(1)) else null
            }
        }
}
