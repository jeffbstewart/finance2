package net.stewart.finance.db

import javax.sql.DataSource
import net.stewart.finance.domain.AccountId
import org.jdbi.v3.core.Jdbi

/**
 * Plaid account_ref → finance2 account links, chosen by the human in
 * the import screen and persistent across snapshots (pipeline design,
 * amended 2026-08-20).
 */
class PlaidAccountLinkRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun all(): Map<String, AccountId> = jdbi.sql { handle ->
        handle.createQuery("SELECT account_ref, account_id FROM plaid_account_links")
            .map { rs, _ -> rs.getString("account_ref") to AccountId(rs.getLong("account_id")) }
            .list()
            .toMap()
    }

    fun link(accountRef: String, accountId: AccountId) {
        jdbi.sql { handle ->
            handle.createUpdate(
                "MERGE INTO plaid_account_links (account_ref, account_id) " +
                    "KEY (account_ref) VALUES (:accountRef, :accountId)"
            )
                .bind("accountRef", accountRef)
                .bind("accountId", accountId.value)
                .execute()
        }
    }

    fun unlink(accountRef: String): Boolean = jdbi.sql { handle ->
        handle.createUpdate("DELETE FROM plaid_account_links WHERE account_ref = :accountRef")
            .bind("accountRef", accountRef)
            .execute() > 0
    }
}
