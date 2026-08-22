package net.stewart.finance.db

import java.sql.ResultSet
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.BrokerId
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.EntrySource
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import org.jdbi.v3.core.Jdbi

data class AccountRow(
    val id: AccountId,
    val brokerId: BrokerId,
    val brokerName: String,
    val name: String,
    val accountNumber: String,
    val currency: CurrencyUnit,
    val taxDeferred: Boolean,
    val sweep: Money,
    val sweepSource: EntrySource,
    val sweepAsOf: LocalDate?,
    val hidden: Boolean,
)

/** Accounts, portfolio-scoped through their broker join. */
class AccountRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun list(portfolioId: PortfolioId, brokerId: BrokerId?, includeHidden: Boolean): List<AccountRow> =
        jdbi.sql { handle ->
            val query = handle.createQuery(
                SELECT + " WHERE b.portfolio_id = :portfolioId" +
                    (if (brokerId != null) " AND a.broker_id = :brokerId" else "") +
                    (if (includeHidden) "" else " AND NOT a.hidden") +
                    " ORDER BY b.name, a.name"
            ).bind("portfolioId", portfolioId.value)
            if (brokerId != null) query.bind("brokerId", brokerId.value)
            query.map { rs, _ -> rs.toRow() }.list()
        }

    fun find(id: AccountId, portfolioId: PortfolioId): AccountRow? = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE a.id = :id AND b.portfolio_id = :portfolioId")
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRow() }
            .findOne()
            .orElse(null)
    }

    /** Throws SQLException on a duplicate name within the broker. */
    fun create(
        brokerId: BrokerId,
        name: String,
        accountNumber: String,
        currency: CurrencyUnit,
        taxDeferred: Boolean,
    ): AccountId = jdbi.sql { handle ->
        AccountId(
            handle.createUpdate(
                "INSERT INTO accounts (broker_id, name, account_number, currency, tax_deferred) " +
                    "VALUES (:brokerId, :name, :accountNumber, :currency, :taxDeferred)"
            )
                .bind("brokerId", brokerId.value)
                .bind("name", name)
                .bind("accountNumber", accountNumber)
                .bind("currency", currency.code)
                .bind("taxDeferred", taxDeferred)
                .executeAndReturnGeneratedKeys("id")
                .mapTo(Long::class.java)
                .one()
        )
    }

    fun update(
        id: AccountId,
        name: String,
        accountNumber: String,
        taxDeferred: Boolean,
        sweep: Money,
        sweepSource: EntrySource,
        sweepAsOf: LocalDate,
    ): Boolean = jdbi.sql { handle ->
        handle.createUpdate(
            "UPDATE accounts SET name = :name, account_number = :accountNumber, " +
                "tax_deferred = :taxDeferred, sweep_balance = :sweep, sweep_source = :sweepSource, " +
                "sweep_as_of = :sweepAsOf WHERE id = :id"
        )
            .bind("name", name)
            .bind("accountNumber", accountNumber)
            .bind("taxDeferred", taxDeferred)
            .bind("sweep", sweep.amount)
            .bind("sweepSource", sweepSource.dbValue)
            .bind("sweepAsOf", sweepAsOf)
            .bind("id", id.value)
            .execute() > 0
    }

    /** Sweep-only update with provenance - the snapshot importer's path. */
    fun updateSweep(id: AccountId, sweep: Money, source: EntrySource, asOf: LocalDate): Boolean =
        jdbi.sql { handle ->
            handle.createUpdate(
                "UPDATE accounts SET sweep_balance = :sweep, sweep_source = :sweepSource, " +
                    "sweep_as_of = :sweepAsOf WHERE id = :id"
            )
                .bind("sweep", sweep.amount)
                .bind("sweepSource", source.dbValue)
                .bind("sweepAsOf", asOf)
                .bind("id", id.value)
                .execute() > 0
        }

    fun setHidden(id: AccountId, hidden: Boolean): Boolean = jdbi.sql { handle ->
        handle.createUpdate("UPDATE accounts SET hidden = :hidden WHERE id = :id")
            .bind("hidden", hidden)
            .bind("id", id.value)
            .execute() > 0
    }

    fun delete(id: AccountId): Boolean = jdbi.sql { handle ->
        handle.createUpdate("DELETE FROM accounts WHERE id = :id")
            .bind("id", id.value)
            .execute() > 0
    }

    /** True when nothing references the account: no lots, no holdings. */
    fun isEmpty(id: AccountId): Boolean = jdbi.sql { handle ->
        handle.createQuery(
            "SELECT 1 FROM purchase_lots WHERE account_id = :id " +
                "UNION ALL SELECT 1 FROM holdings WHERE account_id = :id LIMIT 1"
        )
            .bind("id", id.value)
            .mapTo(Int::class.java)
            .findFirst()
            .isEmpty
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
            sweepSource = EntrySource.parse(getString("sweep_source")),
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
