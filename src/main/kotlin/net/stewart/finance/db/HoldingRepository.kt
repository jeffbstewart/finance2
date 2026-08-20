package net.stewart.finance.db

import java.sql.ResultSet
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.EntrySource
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import org.jdbi.v3.core.Jdbi

data class HoldingRecord(
    val accountId: AccountId,
    val accountName: String,
    val securityId: SecurityId,
    val quantity: Quantity,
    val source: EntrySource,
    val asOf: LocalDate?,
)

/**
 * Position-level holdings — the record for tax-deferred accounts
 * (build-scope §1), with provenance.
 */
class HoldingRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun list(portfolioId: PortfolioId, accountId: AccountId? = null): List<HoldingRecord> =
        jdbi.sql { handle ->
            val query = handle.createQuery(
                SELECT + " WHERE b.portfolio_id = :portfolioId" +
                    (if (accountId != null) " AND h.account_id = :accountId" else "") +
                    " ORDER BY h.account_id, h.security_id"
            ).bind("portfolioId", portfolioId.value)
            if (accountId != null) query.bind("accountId", accountId.value)
            query.map { rs, _ -> rs.toRecord() }.list()
        }

    fun upsert(
        accountId: AccountId,
        securityId: SecurityId,
        quantity: Quantity,
        source: EntrySource,
        asOf: LocalDate,
    ) {
        jdbi.sql { handle ->
            handle.createUpdate(
                "MERGE INTO holdings (account_id, security_id, quantity, source, as_of, updated_at) " +
                    "KEY (account_id, security_id) " +
                    "VALUES (:accountId, :securityId, :quantity, :source, :asOf, CURRENT_TIMESTAMP)"
            )
                .bind("accountId", accountId.value)
                .bind("securityId", securityId.value)
                .bind("quantity", quantity.amount)
                .bind("source", source.dbValue)
                .bind("asOf", asOf)
                .execute()
        }
    }

    fun delete(accountId: AccountId, securityId: SecurityId): Boolean = jdbi.sql { handle ->
        handle.createUpdate(
            "DELETE FROM holdings WHERE account_id = :accountId AND security_id = :securityId"
        )
            .bind("accountId", accountId.value)
            .bind("securityId", securityId.value)
            .execute() > 0
    }

    private fun ResultSet.toRecord() = HoldingRecord(
        accountId = AccountId(getLong("account_id")),
        accountName = getString("account_name"),
        securityId = SecurityId(getLong("security_id")),
        quantity = Quantity.of(getBigDecimal("quantity")),
        source = EntrySource.parse(getString("source")),
        asOf = getObject("as_of", LocalDate::class.java),
    )

    private companion object {
        const val SELECT =
            "SELECT h.account_id, a.name AS account_name, h.security_id, h.quantity, h.source, h.as_of " +
                "FROM holdings h JOIN accounts a ON a.id = h.account_id " +
                "JOIN brokers b ON b.id = a.broker_id"
    }
}
