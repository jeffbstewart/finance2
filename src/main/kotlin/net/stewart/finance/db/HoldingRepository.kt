package net.stewart.finance.db

import java.sql.ResultSet
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId

data class HoldingRecord(
    val accountId: AccountId,
    val accountName: String,
    val securityId: SecurityId,
    val quantity: Quantity,
    val source: String,
    val asOf: LocalDate?,
)

/**
 * Position-level holdings — the record for tax-deferred accounts
 * (build-scope §1), with provenance.
 */
class HoldingRepository(private val dataSource: DataSource) {

    fun list(portfolioId: PortfolioId, accountId: AccountId? = null): List<HoldingRecord> =
        dataSource.connection.use { conn ->
            val sql = SELECT + " WHERE b.portfolio_id = ?" +
                (if (accountId != null) " AND h.account_id = ?" else "") +
                " ORDER BY h.account_id, h.security_id"
            conn.prepareStatement(sql).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                if (accountId != null) stmt.setLong(2, accountId.value)
                val rs = stmt.executeQuery()
                buildList { while (rs.next()) add(rs.toRecord()) }
            }
        }

    fun upsert(
        accountId: AccountId,
        securityId: SecurityId,
        quantity: Quantity,
        source: String,
        asOf: LocalDate,
    ) {
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "MERGE INTO holdings (account_id, security_id, quantity, source, as_of, updated_at) " +
                    "KEY (account_id, security_id) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
            ).use { stmt ->
                stmt.setLong(1, accountId.value)
                stmt.setLong(2, securityId.value)
                stmt.setBigDecimal(3, quantity.amount)
                stmt.setString(4, source)
                stmt.setObject(5, asOf)
                stmt.executeUpdate()
            }
        }
    }

    fun delete(accountId: AccountId, securityId: SecurityId): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "DELETE FROM holdings WHERE account_id = ? AND security_id = ?"
            ).use { stmt ->
                stmt.setLong(1, accountId.value)
                stmt.setLong(2, securityId.value)
                stmt.executeUpdate() > 0
            }
        }

    private fun ResultSet.toRecord() = HoldingRecord(
        accountId = AccountId(getLong("account_id")),
        accountName = getString("account_name"),
        securityId = SecurityId(getLong("security_id")),
        quantity = Quantity.of(getBigDecimal("quantity")),
        source = getString("source"),
        asOf = getObject("as_of", LocalDate::class.java),
    )

    private companion object {
        const val SELECT =
            "SELECT h.account_id, a.name AS account_name, h.security_id, h.quantity, h.source, h.as_of " +
                "FROM holdings h JOIN accounts a ON a.id = h.account_id " +
                "JOIN brokers b ON b.id = a.broker_id"
    }
}
