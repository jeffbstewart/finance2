package net.stewart.finance.db

import javax.sql.DataSource
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.UserId
import org.jdbi.v3.core.Jdbi

/**
 * Portfolio lookup with the spec §3.2 behavior: each user operates on
 * one portfolio named "default", created (with its grant) on first
 * authenticated use.
 */
class PortfolioRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)
    private val createLock = Any()

    fun portfolioFor(userId: UserId): PortfolioId {
        find(userId)?.let { return it }
        synchronized(createLock) {
            find(userId)?.let { return it }
            return jdbi.sqlTransaction { handle ->
                val portfolioId = handle.createUpdate("INSERT INTO portfolios (name) VALUES ('default')")
                    .executeAndReturnGeneratedKeys("id")
                    .mapTo(Long::class.java)
                    .one()
                handle.createUpdate(
                    "INSERT INTO portfolio_grants (user_id, portfolio_id) VALUES (:userId, :portfolioId)"
                )
                    .bind("userId", userId.value)
                    .bind("portfolioId", portfolioId)
                    .execute()
                PortfolioId(portfolioId)
            }
        }
    }

    private fun find(userId: UserId): PortfolioId? = jdbi.sql { handle ->
        handle.createQuery("SELECT portfolio_id FROM portfolio_grants WHERE user_id = :userId LIMIT 1")
            .bind("userId", userId.value)
            .mapTo(Long::class.java)
            .findOne()
            .map { PortfolioId(it) }
            .orElse(null)
    }
}
