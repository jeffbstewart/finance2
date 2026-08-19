package net.stewart.finance.db

import java.sql.ResultSet
import javax.sql.DataSource
import net.stewart.finance.domain.BrokerId
import net.stewart.finance.domain.PortfolioId

data class BrokerRow(
    val id: BrokerId,
    val name: String,
    val hidden: Boolean,
)

/** Brokers, always scoped to one portfolio — a broker id from another
 *  portfolio behaves exactly like a nonexistent one. */
class BrokerRepository(private val dataSource: DataSource) {

    fun list(portfolioId: PortfolioId, includeHidden: Boolean): List<BrokerRow> =
        dataSource.connection.use { conn ->
            val sql = "SELECT id, name, hidden FROM brokers WHERE portfolio_id = ?" +
                (if (includeHidden) "" else " AND NOT hidden") + " ORDER BY name"
            conn.prepareStatement(sql).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                val rs = stmt.executeQuery()
                buildList { while (rs.next()) add(rs.toRow()) }
            }
        }

    fun find(id: BrokerId, portfolioId: PortfolioId): BrokerRow? =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT id, name, hidden FROM brokers WHERE id = ? AND portfolio_id = ?"
            ).use { stmt ->
                stmt.setLong(1, id.value)
                stmt.setLong(2, portfolioId.value)
                val rs = stmt.executeQuery()
                if (rs.next()) rs.toRow() else null
            }
        }

    /** Throws SQLException on a duplicate name within the portfolio. */
    fun create(portfolioId: PortfolioId, name: String): BrokerId =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "INSERT INTO brokers (portfolio_id, name) VALUES (?, ?)",
                java.sql.Statement.RETURN_GENERATED_KEYS,
            ).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                stmt.setString(2, name)
                stmt.executeUpdate()
                BrokerId(stmt.generatedKeys.also { check(it.next()) }.getLong(1))
            }
        }

    fun rename(id: BrokerId, portfolioId: PortfolioId, name: String): Boolean =
        update("UPDATE brokers SET name = ? WHERE id = ? AND portfolio_id = ?") {
            it.setString(1, name)
            it.setLong(2, id.value)
            it.setLong(3, portfolioId.value)
        }

    fun setHidden(id: BrokerId, portfolioId: PortfolioId, hidden: Boolean): Boolean =
        update("UPDATE brokers SET hidden = ? WHERE id = ? AND portfolio_id = ?") {
            it.setBoolean(1, hidden)
            it.setLong(2, id.value)
            it.setLong(3, portfolioId.value)
        }

    fun delete(id: BrokerId, portfolioId: PortfolioId): Boolean =
        update("DELETE FROM brokers WHERE id = ? AND portfolio_id = ?") {
            it.setLong(1, id.value)
            it.setLong(2, portfolioId.value)
        }

    /** True when the broker has any account ([visibleOnly] restricts to unhidden ones). */
    fun hasAccounts(id: BrokerId, visibleOnly: Boolean): Boolean =
        dataSource.connection.use { conn ->
            val sql = "SELECT 1 FROM accounts WHERE broker_id = ?" +
                (if (visibleOnly) " AND NOT hidden" else "") + " LIMIT 1"
            conn.prepareStatement(sql).use { stmt ->
                stmt.setLong(1, id.value)
                stmt.executeQuery().next()
            }
        }

    private fun update(sql: String, bind: (java.sql.PreparedStatement) -> Unit): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement(sql).use { stmt ->
                bind(stmt)
                stmt.executeUpdate() > 0
            }
        }

    private fun ResultSet.toRow() = BrokerRow(
        id = BrokerId(getLong("id")),
        name = getString("name"),
        hidden = getBoolean("hidden"),
    )
}
