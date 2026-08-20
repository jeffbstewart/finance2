package net.stewart.finance.auth

import java.sql.ResultSet
import javax.sql.DataSource
import net.stewart.auth.AuthUser
import net.stewart.auth.UserRepository
import net.stewart.finance.db.sql
import org.jdbi.v3.core.Jdbi

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
class FinanceUserRepository(dataSource: DataSource) : UserRepository {

    private val jdbi = Jdbi.create(dataSource)

    override fun findById(id: Long): FinanceUser? = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE id = :id")
            .bind("id", id)
            .map { rs, _ -> rs.toUser() }
            .findOne()
            .orElse(null)
    }

    override fun findByUsername(username: String): FinanceUser? = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE username = :username")
            .bind("username", username)
            .map { rs, _ -> rs.toUser() }
            .findOne()
            .orElse(null)
    }

    override fun hasUsers(): Boolean = jdbi.sql { handle ->
        handle.createQuery("SELECT 1 FROM users LIMIT 1")
            .mapTo(Int::class.java)
            .findOne()
            .isPresent
    }

    override fun lockUser(id: Long) {
        jdbi.sql { handle ->
            handle.createUpdate("UPDATE users SET locked = TRUE WHERE id = :id")
                .bind("id", id)
                .execute()
        }
    }

    /** Inserts a new user; the username must not already exist. */
    fun createUser(username: String, passwordHash: String, displayName: String): FinanceUser =
        jdbi.sql { handle ->
            val id = handle.createUpdate(
                "INSERT INTO users (username, password_hash, display_name) " +
                    "VALUES (:username, :passwordHash, :displayName)"
            )
                .bind("username", username)
                .bind("passwordHash", passwordHash)
                .bind("displayName", displayName)
                .executeAndReturnGeneratedKeys("id")
                .mapTo(Long::class.java)
                .one()
            FinanceUser(
                id = id,
                username = username,
                passwordHash = passwordHash,
                isLocked = false,
                mustChangePassword = false,
                displayName = displayName,
            )
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
