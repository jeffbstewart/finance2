package net.stewart.finance.ops

import net.stewart.auth.LoginService
import net.stewart.auth.SessionService
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals

class AuthMaintenanceTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    @Test
    fun `a pass removes expired sessions and stale attempts, keeps live rows`() {
        val users = FinanceUserRepository(db.dataSource)
        val user = users.createUser("jeff", "hash", "Jeff")
        db.dataSource.connection.use { conn ->
            conn.createStatement().executeUpdate(
                """
                INSERT INTO session_token (user_id, token_hash, created_at, expires_at) VALUES
                    (${user.id}, 'expired', DATEADD(DAY, -40, NOW()), DATEADD(DAY, -10, NOW())),
                    (${user.id}, 'live',    NOW(),                    DATEADD(DAY, 10, NOW()))
                """.trimIndent()
            )
            conn.createStatement().executeUpdate(
                """
                INSERT INTO login_attempt (username, ip_address, attempted_at, success) VALUES
                    ('jeff', '10.0.0.1', DATEADD(DAY, -31, NOW()), FALSE),
                    ('jeff', '10.0.0.1', NOW(),                    TRUE)
                """.trimIndent()
            )
        }

        AuthMaintenance(
            SessionService(db.dataSource, users),
            LoginService(db.dataSource, users),
        ).runOnce()

        db.dataSource.connection.use { conn ->
            val tokens = conn.createStatement()
                .executeQuery("SELECT token_hash FROM session_token")
                .let { rs -> buildList { while (rs.next()) add(rs.getString(1)) } }
            assertEquals(listOf("live"), tokens)
            val attempts = conn.createStatement()
                .executeQuery("SELECT COUNT(*) FROM login_attempt")
                .also { it.next() }.getInt(1)
            assertEquals(1, attempts)
        }
    }
}
