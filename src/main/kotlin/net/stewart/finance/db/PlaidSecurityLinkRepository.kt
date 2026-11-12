package net.stewart.finance.db

import javax.sql.DataSource
import net.stewart.finance.domain.SecurityId
import org.jdbi.v3.core.Jdbi

/**
 * Plaid security id -> finance2 security links, chosen by the human in
 * the import screen for securities Plaid reports without a ticker
 * (pipeline design, amended 2026-08-21). Persistent across snapshots.
 */
class PlaidSecurityLinkRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun all(): Map<String, SecurityId> = jdbi.sql { handle ->
        handle.createQuery("SELECT plaid_security_id, security_id FROM plaid_security_links")
            .map { rs, _ -> rs.getString("plaid_security_id") to SecurityId(rs.getLong("security_id")) }
            .list()
            .toMap()
    }

    fun link(plaidSecurityId: String, securityId: SecurityId) {
        jdbi.sql { handle ->
            handle.createUpdate(
                "MERGE INTO plaid_security_links (plaid_security_id, security_id) " +
                    "KEY (plaid_security_id) VALUES (:plaidSecurityId, :securityId)"
            )
                .bind("plaidSecurityId", plaidSecurityId)
                .bind("securityId", securityId.value)
                .execute()
        }
    }

    fun unlink(plaidSecurityId: String): Boolean = jdbi.sql { handle ->
        handle.createUpdate("DELETE FROM plaid_security_links WHERE plaid_security_id = :plaidSecurityId")
            .bind("plaidSecurityId", plaidSecurityId)
            .execute() > 0
    }
}
