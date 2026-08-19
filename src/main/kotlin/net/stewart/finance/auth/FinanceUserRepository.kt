package net.stewart.finance.auth

import java.sql.ResultSet
import java.sql.Statement
import javax.sql.DataSource
import net.stewart.auth.AuthUser
import net.stewart.auth.UserRepository

/** The single finance2 user row (build-scope §8: local auth, no email). */
data class FinanceUser(
    override val id: Long,
    override val username: String,
    override val passwordHash: String,
    override val isLocked: Boolean,
    override val mustChangePassword: Boolean,
    val displayName: String,
) : AuthUser

/**
 * Bridges auth-kotlin-toolkit's [UserRepository] to the `users` table.
 * Username lookups are case-insensitive by the column's
 * VARCHAR_IGNORECASE type, not by application-side lowercasing.
 */
class FinanceUserRepository(private val dataSource: DataSource) : UserRepository {

    override fun findById(id: Long): FinanceUser? =
        queryOne("$SELECT WHERE id = ?") { it.setLong(1, id) }

    override fun findByUsername(username: String): FinanceUser? =
        queryOne("$SELECT WHERE username = ?") { it.setString(1, username) }

    override fun hasUsers(): Boolean =
        dataSource.connection.use { conn ->
            conn.createStatement().executeQuery("SELECT 1 FROM users LIMIT 1").next()
        }

    override fun lockUser(id: Long) {
        dataSource.connection.use { conn ->
            conn.prepareStatement("UPDATE users SET locked = TRUE WHERE id = ?").use { stmt ->
                stmt.setLong(1, id)
                stmt.executeUpdate()
            }
        }
    }

    /** Inserts a new user; the username must not already exist. */
    fun createUser(username: String, passwordHash: String, displayName: String): FinanceUser =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)",
                Statement.RETURN_GENERATED_KEYS,
            ).use { stmt ->
                stmt.setString(1, username)
                stmt.setString(2, passwordHash)
                stmt.setString(3, displayName)
                stmt.executeUpdate()
                val keys = stmt.generatedKeys
                check(keys.next()) { "user insert returned no generated key" }
                FinanceUser(
                    id = keys.getLong(1),
                    username = username,
                    passwordHash = passwordHash,
                    isLocked = false,
                    mustChangePassword = false,
                    displayName = displayName,
                )
            }
        }

    private fun queryOne(sql: String, bind: (java.sql.PreparedStatement) -> Unit): FinanceUser? =
        dataSource.connection.use { conn ->
            conn.prepareStatement(sql).use { stmt ->
                bind(stmt)
                val rs = stmt.executeQuery()
                if (rs.next()) rs.toUser() else null
            }
        }

    private fun ResultSet.toUser() = FinanceUser(
        id = getLong("id"),
        username = getString("username"),
        passwordHash = getString("password_hash"),
        isLocked = getBoolean("locked"),
        mustChangePassword = getBoolean("must_change_password"),
        displayName = getString("display_name"),
    )

    private companion object {
        const val SELECT =
            "SELECT id, username, password_hash, locked, must_change_password, display_name FROM users"
    }
}
