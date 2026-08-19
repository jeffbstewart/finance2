package net.stewart.finance

import java.nio.file.Path
import net.stewart.armeria.AppServerConfig
import net.stewart.armeria.ArmeriaAppServer
import net.stewart.armeria.GrpcServiceSpec
import net.stewart.armeria.SinglePageAppConfig
import net.stewart.armeria.auth.AuthGrpcInterceptor
import net.stewart.armeria.auth.grpcAuthConfig
import net.stewart.auth.LoginService
import net.stewart.auth.SessionService
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.finance.auth.RequestMetaInterceptor
import net.stewart.h2toolkit.H2Config
import net.stewart.h2toolkit.H2Database

/**
 * finance2 server bootstrap: one Armeria port serving gRPC (native +
 * gRPC-Web), a health endpoint, and — once Phase 6 builds it — the SPA.
 * TLS terminates at HAProxy; this listener stays cleartext and derives
 * the client IP from forwarded headers (build-scope §10).
 *
 * Auth posture: every RPC not on the explicit unauthenticated
 * allowlist requires a valid session cookie (auth-kotlin-toolkit via
 * the armeria auth bridge, build-scope §8). The allowlisted
 * SessionService RPCs implement first-run setup, login, and logout.
 */
fun main() {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 9090

    val db = H2Database(
        H2Config(
            basePath = requireEnv("DB_PATH"),
            password = requireEnv("H2_PASSWORD"),
            filePassword = requireEnv("H2_FILE_PASSWORD"),
        )
    ).apply { init() }

    val users = FinanceUserRepository(db.dataSource)
    val sessions = SessionService(db.dataSource, users, cookieName = "finance_session")
    val logins = LoginService(db.dataSource, users)
    val secureCookies = System.getenv("COOKIE_SECURE")?.toBooleanStrictOrNull() ?: true

    val authInterceptor = AuthGrpcInterceptor(
        grpcAuthConfig(
            sessionService = sessions,
            unauthenticatedMethods = setOf(
                "finance.InfoService/GetInfo",
                "finance.SessionService/GetSessionStatus",
                "finance.SessionService/CreateFirstUser",
                "finance.SessionService/Login",
                "finance.SessionService/Logout",
            ),
        )
    )

    ArmeriaAppServer(
        AppServerConfig(
            port = port,
            grpcServices = listOf(
                GrpcServiceSpec(InfoGrpcService()),
                GrpcServiceSpec(SessionGrpcService(users, sessions, logins, secureCookies)),
            ),
            grpcInterceptors = listOf(RequestMetaInterceptor(), authInterceptor),
            singlePageApp = SinglePageAppConfig(dir = Path.of("spa")),
            healthPath = "/healthz",
        )
    ).start()
}

private fun requireEnv(name: String): String =
    System.getenv(name)?.takeIf { it.isNotBlank() }
        ?: error("missing required environment variable $name — see example.env")
