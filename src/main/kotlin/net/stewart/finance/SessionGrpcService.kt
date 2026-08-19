package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import net.stewart.armeria.auth.OriginCheck
import net.stewart.auth.AuthUser
import net.stewart.auth.LoginResult
import net.stewart.auth.LoginService
import net.stewart.auth.PasswordService
import net.stewart.auth.SessionService
import net.stewart.finance.auth.CLIENT_IP_KEY
import net.stewart.finance.auth.COOKIE_HEADER_KEY
import net.stewart.finance.auth.FinanceUser
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.finance.auth.RESPONSE_COOKIES_KEY
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

/**
 * The proto SessionService over auth-kotlin-toolkit (build-scope §8):
 * cookie sessions, rate-limited login, and the first-run single-user
 * setup flow. All four RPCs are on the unauthenticated allowlist —
 * this service resolves the session cookie itself where it needs one
 * (the auth interceptor skips identity resolution for allowlisted
 * methods).
 */
class SessionGrpcService(
    private val users: FinanceUserRepository,
    private val sessions: SessionService,
    private val logins: LoginService,
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
        if (username.isEmpty()) {
            throw StatusException(Status.INVALID_ARGUMENT.withDescription("username is required"))
        }
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
            users.createUser(username, PasswordService.hash(request.password), displayName)
        }
        establishSession(user)
        return CreateFirstUserResponse.newBuilder().setUser(user.toUserInfo()).build()
    }

    override suspend fun login(request: LoginRequest): LoginResponse {
        val ip = CLIENT_IP_KEY.get() ?: "unknown"
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
        RESPONSE_COOKIES_KEY.get()?.add(sessions.buildExpireCookieHeader())
        return LogoutResponse.getDefaultInstance()
    }

    private fun sessionToken(): String? {
        val cookieHeader = COOKIE_HEADER_KEY.get() ?: return null
        return OriginCheck.parseCookie(cookieHeader, sessions.cookieName)
    }

    private fun sessionUser(): AuthUser? = sessionToken()?.let { sessions.validateToken(it) }

    private fun establishSession(user: AuthUser) {
        val token = sessions.createSession(user, USER_AGENT_KEY.get() ?: "unknown")
        RESPONSE_COOKIES_KEY.get()?.add(sessions.buildCookieHeader(token, secureCookies))
    }

    private fun AuthUser.toUserInfo(): UserInfo = UserInfo.newBuilder()
        .setUsername(username)
        .setDisplayName((this as? FinanceUser)?.displayName ?: username)
        .build()
}
