package net.stewart.finance.db

import java.sql.ResultSet
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.BrokerId
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId

data class AccountRow(
    val id: AccountId,
    val brokerId: BrokerId,
    val brokerName: String,
    val name: String,
    val accountNumber: String,
    val currency: CurrencyUnit,
    val taxDeferred: Boolean,
    val sweep: Money,
    val sweepSource: String,
    val sweepAsOf: LocalDate?,
    val hidden: Boolean,
)

/** Accounts, portfolio-scoped through their broker join. */
class AccountRepository(private val dataSource: DataSource) {

    fun list(portfolioId: PortfolioId, brokerId: BrokerId?, includeHidden: Boolean): List<AccountRow> =
        dataSource.connection.use { conn ->
            val sql = SELECT + " WHERE b.portfolio_id = ?" +
                (if (brokerId != null) " AND a.broker_id = ?" else "") +
                (if (includeHidden) "" else " AND NOT a.hidden") +
                " ORDER BY b.name, a.name"
            conn.prepareStatement(sql).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                if (brokerId != null) stmt.setLong(2, brokerId.value)
                val rs = stmt.executeQuery()
                buildList { while (rs.next()) add(rs.toRow()) }
            }
        }

    fun find(id: AccountId, portfolioId: PortfolioId): AccountRow? =
        dataSource.connection.use { conn ->
            conn.prepareStatement("$SELECT WHERE a.id = ? AND b.portfolio_id = ?").use { stmt ->
                stmt.setLong(1, id.value)
                stmt.setLong(2, portfolioId.value)
                val rs = stmt.executeQuery()
                if (rs.next()) rs.toRow() else null
            }
        }

    /** Throws SQLException on a duplicate name within the broker. */
    fun create(
        brokerId: BrokerId,
        name: String,
        accountNumber: String,
        currency: CurrencyUnit,
        taxDeferred: Boolean,
    ): AccountId =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "INSERT INTO accounts (broker_id, name, account_number, currency, tax_deferred) " +
                    "VALUES (?, ?, ?, ?, ?)",
                java.sql.Statement.RETURN_GENERATED_KEYS,
            ).use { stmt ->
                stmt.setLong(1, brokerId.value)
                stmt.setString(2, name)
                stmt.setString(3, accountNumber)
                stmt.setString(4, currency.code)
                stmt.setBoolean(5, taxDeferred)
                stmt.executeUpdate()
                AccountId(stmt.generatedKeys.also { check(it.next()) }.getLong(1))
            }
        }

    fun update(
        id: AccountId,
        name: String,
        accountNumber: String,
        taxDeferred: Boolean,
        sweep: Money,
        sweepSource: String,
        sweepAsOf: LocalDate,
    ): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "UPDATE accounts SET name = ?, account_number = ?, tax_deferred = ?, " +
                    "sweep_balance = ?, sweep_source = ?, sweep_as_of = ? WHERE id = ?"
            ).use { stmt ->
                stmt.setString(1, name)
                stmt.setString(2, accountNumber)
                stmt.setBoolean(3, taxDeferred)
                stmt.setBigDecimal(4, sweep.amount)
                stmt.setString(5, sweepSource)
                stmt.setObject(6, sweepAsOf)
                stmt.setLong(7, id.value)
                stmt.executeUpdate() > 0
            }
        }

    fun setHidden(id: AccountId, hidden: Boolean): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement("UPDATE accounts SET hidden = ? WHERE id = ?").use { stmt ->
                stmt.setBoolean(1, hidden)
                stmt.setLong(2, id.value)
                stmt.executeUpdate() > 0
            }
        }

    fun delete(id: AccountId): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement("DELETE FROM accounts WHERE id = ?").use { stmt ->
                stmt.setLong(1, id.value)
                stmt.executeUpdate() > 0
            }
        }

    /** True when nothing references the account: no lots, no holdings. */
    fun isEmpty(id: AccountId): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT 1 FROM purchase_lots WHERE account_id = ? " +
                    "UNION ALL SELECT 1 FROM holdings WHERE account_id = ? LIMIT 1"
            ).use { stmt ->
                stmt.setLong(1, id.value)
                stmt.setLong(2, id.value)
                !stmt.executeQuery().next()
            }
        }

    private fun ResultSet.toRow(): AccountRow {
        val currency = CurrencyUnit.parse(getString("currency").trim())
        return AccountRow(
            id = AccountId(getLong("id")),
            brokerId = BrokerId(getLong("broker_id")),
            brokerName = getString("broker_name"),
            name = getString("name"),
            accountNumber = getString("account_number"),
            currency = currency,
            taxDeferred = getBoolean("tax_deferred"),
            sweep = Money.of(getBigDecimal("sweep_balance"), currency),
            sweepSource = getString("sweep_source"),
            sweepAsOf = getObject("sweep_as_of", LocalDate::class.java),
            hidden = getBoolean("hidden"),
        )
    }

    private companion object {
        const val SELECT =
            "SELECT a.id, a.broker_id, b.name AS broker_name, a.name, a.account_number, " +
                "a.currency, a.tax_deferred, a.sweep_balance, a.sweep_source, a.sweep_as_of, a.hidden " +
                "FROM accounts a JOIN brokers b ON b.id = a.broker_id"
    }
}
