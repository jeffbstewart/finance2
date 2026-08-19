package net.stewart.finance

import io.grpc.Context
import io.grpc.Status
import io.grpc.StatusException
import kotlinx.coroutines.runBlocking
import net.stewart.auth.LoginService
import net.stewart.auth.SessionService
import net.stewart.finance.auth.CLIENT_IP_KEY
import net.stewart.finance.auth.COOKIE_HEADER_KEY
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.finance.auth.RESPONSE_COOKIES_KEY
import net.stewart.finance.auth.ResponseCookies
import net.stewart.finance.proto.CreateFirstUserRequest
import net.stewart.finance.proto.GetSessionStatusRequest
import net.stewart.finance.proto.LoginRequest
import net.stewart.finance.proto.LogoutRequest
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SessionGrpcServiceTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    private val users by lazy { FinanceUserRepository(db.dataSource) }
    private val sessions by lazy {
        SessionService(db.dataSource, users, cookieName = "finance_session")
    }
    private val logins by lazy { LoginService(db.dataSource, users) }
    private val service by lazy { SessionGrpcService(users, sessions, logins, secureCookies = true) }

    /** Runs [block] inside a gRPC context shaped like RequestMetaInterceptor's. */
    private fun <T> call(
        cookies: ResponseCookies = ResponseCookies(),
        cookieHeader: String? = null,
        ip: String = "10.0.0.1",
        block: suspend () -> T,
    ): T {
        var ctx = Context.current()
            .withValue(RESPONSE_COOKIES_KEY, cookies)
            .withValue(CLIENT_IP_KEY, ip)
        if (cookieHeader != null) ctx = ctx.withValue(COOKIE_HEADER_KEY, cookieHeader)
        val prev = ctx.attach()
        try {
            return runBlocking { block() }
        } finally {
            ctx.detach(prev)
        }
    }

    private fun statusOf(block: suspend () -> Unit): Status.Code = try {
        call(block = block)
        error("expected a StatusException")
    } catch (e: StatusException) {
        e.status.code
    }

    private fun tokenFrom(cookies: ResponseCookies): String {
        val header = cookies.drain().single()
        assertTrue(header.contains("HttpOnly") && header.contains("Secure"), header)
        return Regex("finance_session=([^;]+)").find(header)!!.groupValues[1]
    }

    @Test
    fun `first-run setup, session status, login, and logout`() {
        // Fresh install: setup required, nobody signed in.
        val fresh = call { service.getSessionStatus(GetSessionStatusRequest.getDefaultInstance()) }
        assertTrue(fresh.setupRequired)
        assertTrue(!fresh.signedIn)

        // Weak passwords are rejected before any user is created.
        assertEquals(
            Status.Code.INVALID_ARGUMENT,
            statusOf {
                service.createFirstUser(
                    CreateFirstUserRequest.newBuilder().setUsername("jeff").setPassword("short").build()
                )
            },
        )

        // The first (and only) account: created and signed in.
        val setupCookies = ResponseCookies()
        val created = call(cookies = setupCookies) {
            service.createFirstUser(
                CreateFirstUserRequest.newBuilder()
                    .setUsername("jeff")
                    .setPassword("correct-horse-battery")
                    .setDisplayName("Jeff")
                    .build()
            )
        }
        assertEquals("jeff", created.user.username)
        assertEquals("Jeff", created.user.displayName)
        val token = tokenFrom(setupCookies)

        // The cookie now authenticates the status probe.
        val signedIn = call(cookieHeader = "finance_session=$token") {
            service.getSessionStatus(GetSessionStatusRequest.getDefaultInstance())
        }
        assertTrue(!signedIn.setupRequired)
        assertTrue(signedIn.signedIn)
        assertEquals("jeff", signedIn.user.username)

        // Registration is closed forever (single-user ruling).
        assertEquals(
            Status.Code.PERMISSION_DENIED,
            statusOf {
                service.createFirstUser(
                    CreateFirstUserRequest.newBuilder()
                        .setUsername("intruder")
                        .setPassword("long-enough-password")
                        .build()
                )
            },
        )

        // Logout revokes server-side and expires the cookie.
        val logoutCookies = ResponseCookies()
        call(cookies = logoutCookies, cookieHeader = "finance_session=$token") {
            service.logout(LogoutRequest.getDefaultInstance())
        }
        assertNull(sessions.validateToken(token))
        assertTrue(logoutCookies.drain().single().contains("Max-Age=0"))

        // Wrong password fails without detail; right password signs in.
        assertEquals(
            Status.Code.UNAUTHENTICATED,
            statusOf {
                service.login(LoginRequest.newBuilder().setUsername("jeff").setPassword("wrong-password").build())
            },
        )
        val loginCookies = ResponseCookies()
        call(cookies = loginCookies) {
            service.login(
                LoginRequest.newBuilder().setUsername("jeff").setPassword("correct-horse-battery").build()
            )
        }
        assertNotNull(sessions.validateToken(tokenFrom(loginCookies)))
    }

    @Test
    fun `repeated failures rate-limit the caller`() {
        repeat(5) {
            assertEquals(
                Status.Code.UNAUTHENTICATED,
                statusOfAt("10.9.9.9") {
                    service.login(
                        LoginRequest.newBuilder().setUsername("nobody-here").setPassword("wrong-password").build()
                    )
                },
            )
        }
        assertEquals(
            Status.Code.RESOURCE_EXHAUSTED,
            statusOfAt("10.9.9.9") {
                service.login(
                    LoginRequest.newBuilder().setUsername("nobody-here").setPassword("wrong-password").build()
                )
            },
        )
    }

    private fun statusOfAt(ip: String, block: suspend () -> Unit): Status.Code = try {
        call(ip = ip, block = block)
        error("expected a StatusException")
    } catch (e: StatusException) {
        e.status.code
    }
}
