package net.stewart.finance.ops

import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import net.stewart.auth.LoginService
import net.stewart.auth.SessionService
import org.slf4j.LoggerFactory

/**
 * In-process housekeeping for the auth toolkit's tables (ruling
 * 2026-08-18, orange-team finding 7): without it, expired
 * session_token rows and login_attempt rows (which carry client IPs —
 * a retention concern, not just bloat) grow forever. The toolkit
 * provides the deletions (expired tokens; attempts older than 30
 * days); this schedules them.
 */
class AuthMaintenance(
    private val sessions: SessionService,
    private val logins: LoginService,
    private val period: Duration = Duration.ofHours(1),
) {
    private val log = LoggerFactory.getLogger(AuthMaintenance::class.java)
    private var executor: ScheduledExecutorService? = null

    /** One maintenance pass; failures are logged, never thrown. */
    fun runOnce() {
        runCatching { sessions.cleanupExpired() }
            .onFailure { log.warn("session cleanup failed", it) }
        runCatching { logins.cleanupOldAttempts() }
            .onFailure { log.warn("login-attempt cleanup failed", it) }
    }

    /** Starts the periodic schedule on a daemon thread; idempotent. */
    fun start() {
        check(executor == null) { "AuthMaintenance already started" }
        executor = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "auth-maintenance").apply { isDaemon = true }
        }.also {
            it.scheduleAtFixedRate(::runOnce, period.toMinutes(), period.toMinutes(), TimeUnit.MINUTES)
        }
        log.info("auth maintenance scheduled every {}", period)
    }

    fun stop() {
        executor?.shutdownNow()
        executor = null
    }
}
