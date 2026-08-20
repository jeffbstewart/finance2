package net.stewart.finance.db

import java.sql.ResultSet
import javax.sql.DataSource
import net.stewart.finance.domain.BrokerId
import net.stewart.finance.domain.PortfolioId
import org.jdbi.v3.core.Jdbi

data class BrokerRow(
    val id: BrokerId,
    val name: String,
    val hidden: Boolean,
)

/** Brokers, always scoped to one portfolio — a broker id from another
 *  portfolio behaves exactly like a nonexistent one. */
class BrokerRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun list(portfolioId: PortfolioId, includeHidden: Boolean): List<BrokerRow> = jdbi.sql { handle ->
        handle.createQuery(
            "SELECT id, name, hidden FROM brokers WHERE portfolio_id = :portfolioId" +
                (if (includeHidden) "" else " AND NOT hidden") + " ORDER BY name"
        )
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRow() }
            .list()
    }

    fun find(id: BrokerId, portfolioId: PortfolioId): BrokerRow? = jdbi.sql { handle ->
        handle.createQuery(
            "SELECT id, name, hidden FROM brokers WHERE id = :id AND portfolio_id = :portfolioId"
        )
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRow() }
            .findOne()
            .orElse(null)
    }

    /** Throws SQLException on a duplicate name within the portfolio. */
    fun create(portfolioId: PortfolioId, name: String): BrokerId = jdbi.sql { handle ->
        BrokerId(
            handle.createUpdate("INSERT INTO brokers (portfolio_id, name) VALUES (:portfolioId, :name)")
                .bind("portfolioId", portfolioId.value)
                .bind("name", name)
                .executeAndReturnGeneratedKeys("id")
                .mapTo(Long::class.java)
                .one()
        )
    }

    fun rename(id: BrokerId, portfolioId: PortfolioId, name: String): Boolean = jdbi.sql { handle ->
        handle.createUpdate(
            "UPDATE brokers SET name = :name WHERE id = :id AND portfolio_id = :portfolioId"
        )
            .bind("name", name)
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .execute() > 0
    }

    fun setHidden(id: BrokerId, portfolioId: PortfolioId, hidden: Boolean): Boolean = jdbi.sql { handle ->
        handle.createUpdate(
            "UPDATE brokers SET hidden = :hidden WHERE id = :id AND portfolio_id = :portfolioId"
        )
            .bind("hidden", hidden)
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .execute() > 0
    }

    fun delete(id: BrokerId, portfolioId: PortfolioId): Boolean = jdbi.sql { handle ->
        handle.createUpdate("DELETE FROM brokers WHERE id = :id AND portfolio_id = :portfolioId")
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .execute() > 0
    }

    /** True when the broker has any account ([visibleOnly] restricts to unhidden ones). */
    fun hasAccounts(id: BrokerId, visibleOnly: Boolean): Boolean = jdbi.sql { handle ->
        handle.createQuery(
            "SELECT 1 FROM accounts WHERE broker_id = :id" +
                (if (visibleOnly) " AND NOT hidden" else "") + " LIMIT 1"
        )
            .bind("id", id.value)
            .mapTo(Int::class.java)
            .findOne()
            .isPresent
    }

    private fun ResultSet.toRow() = BrokerRow(
        id = BrokerId(getLong("id")),
        name = getString("name"),
        hidden = getBoolean("hidden"),
    )
}
