package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import java.security.MessageDigest
import net.stewart.armeria.auth.OriginCheck
import net.stewart.auth.AuthUser
import net.stewart.auth.LoginResult
import net.stewart.auth.LoginService
import net.stewart.auth.PasswordService
import net.stewart.auth.SessionService
import net.stewart.finance.auth.AUTHORITY_KEY
import net.stewart.finance.auth.CLIENT_IP_KEY
import net.stewart.finance.auth.COOKIE_HEADER_KEY
import net.stewart.finance.auth.FinanceUser
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.finance.auth.ORIGIN_KEY
import net.stewart.finance.auth.RESPONSE_COOKIES_KEY
import net.stewart.finance.auth.ResponseCookies
import net.stewart.finance.auth.USER_AGENT_KEY
import net.stewart.finance.proto.CreateFirstUserRequest
import net.stewart.finance.proto.CreateFirstUserResponse
import net.stewart.finance.proto.GetSessionStatusRequest
import net.stewart.finance.proto.GetSessionStatusResponse
import net.stewart.finance.proto.LoginRequest
import net.stewart.finance.proto.LoginResponse
import net.stewart.finance.proto.LogoutRequest
import net.stewart.finance.proto.LogoutResponse
import net.stewart.finance.proto.SessionServiceGrpcKt
import net.stewart.finance.proto.UserInfo

/** Usernames must fit the users.username column. */
const val MAX_USERNAME_LENGTH = 100

/**
 * The proto SessionService over auth-kotlin-toolkit (build-scope §8):
 * cookie sessions, rate-limited login, and the first-run single-user
 * setup flow. All four RPCs are on the unauthenticated allowlist —
 * this service resolves the session cookie itself where it needs one
 * (the auth interceptor skips identity resolution for allowlisted
 * methods), applying the same Origin CSRF check the interceptor uses.
 */
class SessionGrpcService(
    private val users: FinanceUserRepository,
    private val sessions: SessionService,
    private val logins: LoginService,
    /**
     * The per-run setup token printed to the server log at boot when no
     * user existed; null when the boot found a user (setup closed) —
     * a mid-run wipe then requires a restart to reopen setup.
     */
    private val setupToken: String?,
    /** False only in cookie-insecure dev setups; true behind HAProxy (§10). */
    private val secureCookies: Boolean = true,
) : SessionServiceGrpcKt.SessionServiceCoroutineImplBase() {

    private val setupLock = Any()

    override suspend fun getSessionStatus(request: GetSessionStatusRequest): GetSessionStatusResponse {
        val user = sessionUser()
        val builder = GetSessionStatusResponse.newBuilder()
            .setSetupRequired(!users.hasUsers())
            .setSignedIn(user != null)
        if (user != null) builder.setUser(user.toUserInfo())
        return builder.build()
    }

    override suspend fun createFirstUser(request: CreateFirstUserRequest): CreateFirstUserResponse {
        val username = request.username.trim()
        validateUsername(username)
        PasswordService.validate(request.password, username).firstOrNull()?.let {
            throw StatusException(Status.INVALID_ARGUMENT.withDescription(it))
        }
        val displayName = request.displayName.trim().ifEmpty { username }
        // The single-user ruling (build-scope §8): the first account is
        // the only account; once any user exists, registration is
        // closed for good. The lock closes the check-then-insert race.
        val user = synchronized(setupLock) {
            if (users.hasUsers()) {
                throw StatusException(
                    Status.PERMISSION_DENIED.withDescription("setup is complete; registration is closed")
                )
            }
            requireSetupToken(request.setupToken)
            users.createUser(username, PasswordService.hash(request.password), displayName)
        }
        establishSession(user)
        return CreateFirstUserResponse.newBuilder().setUser(user.toUserInfo()).build()
    }

    override suspend fun login(request: LoginRequest): LoginResponse {
        val ip = CLIENT_IP_KEY.get()
            ?: error("BUG: client IP missing — RequestMetaInterceptor not installed")
        when (val result = logins.login(request.username, request.password, ip)) {
            is LoginResult.Success -> {
                establishSession(result.user)
                return LoginResponse.newBuilder().setUser(result.user.toUserInfo()).build()
            }
            is LoginResult.RateLimited -> throw StatusException(
                Status.RESOURCE_EXHAUSTED.withDescription(
                    "too many attempts; try again in ${result.retryAfterSeconds}s"
                )
            )
            LoginResult.Failed -> throw StatusException(
                Status.UNAUTHENTICATED.withDescription("invalid username or password")
            )
        }
    }

    override suspend fun logout(request: LogoutRequest): LogoutResponse {
        sessionToken()?.let { sessions.revokeByToken(it) }
        responseCookies().add(sessions.buildExpireCookieHeader())
        return LogoutResponse.getDefaultInstance()
    }

    /** Username rules (ruling 2026-08-18): 1–100 chars, visible 7-bit ASCII. */
    private fun validateUsername(username: String) {
        if (username.isEmpty()) {
            throw StatusException(Status.INVALID_ARGUMENT.withDescription("username is required"))
        }
        if (username.length > MAX_USERNAME_LENGTH) {
            throw StatusException(
                Status.INVALID_ARGUMENT.withDescription("username exceeds $MAX_USERNAME_LENGTH characters")
            )
        }
        if (username.any { it.code !in 0x21..0x7E }) {
            throw StatusException(
                Status.INVALID_ARGUMENT.withDescription(
                    "username must be printable 7-bit ASCII without spaces"
                )
            )
        }
    }

    private fun requireSetupToken(presented: String) {
        val expected = setupToken ?: throw StatusException(
            Status.PERMISSION_DENIED.withDescription(
                "no setup token was issued this run; restart the server to obtain one"
            )
        )
        if (!MessageDigest.isEqual(presented.toByteArray(), expected.toByteArray())) {
            throw StatusException(
                Status.PERMISSION_DENIED.withDescription(
                    "setup token missing or incorrect — it is printed in the server log at startup"
                )
            )
        }
    }

    /**
     * The session cookie's token, honored only when the request's
     * Origin (if any) matches the authority — the same CSRF posture
     * the auth interceptor applies on authenticated RPCs.
     */
    private fun sessionToken(): String? {
        val cookieHeader = COOKIE_HEADER_KEY.get() ?: return null
        val token = OriginCheck.parseCookie(cookieHeader, sessions.cookieName) ?: return null
        if (!OriginCheck.originPermitted(ORIGIN_KEY.get(), AUTHORITY_KEY.get())) return null
        return token
    }

    private fun sessionUser(): AuthUser? = sessionToken()?.let { sessions.validateToken(it) }

    private fun responseCookies(): ResponseCookies = RESPONSE_COOKIES_KEY.get()
        ?: error("BUG: response-cookie sink missing — RequestMetaInterceptor not installed")

    private fun establishSession(user: AuthUser) {
        val token = sessions.createSession(user, USER_AGENT_KEY.get() ?: "unknown")
        responseCookies().add(sessions.buildCookieHeader(token, secureCookies))
    }

    private fun AuthUser.toUserInfo(): UserInfo = UserInfo.newBuilder()
        .setUsername(username)
        .setDisplayName((this as? FinanceUser)?.displayName ?: username)
        .build()
}
