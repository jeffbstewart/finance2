package net.stewart.finance

import io.grpc.Status
import net.stewart.armeria.AppServerConfig
import net.stewart.armeria.ArmeriaAppServer
import net.stewart.armeria.GrpcServiceSpec
import net.stewart.armeria.SinglePageAppConfig
import net.stewart.armeria.auth.AuthGrpcInterceptor
import net.stewart.armeria.auth.GrpcAuthConfig
import java.nio.file.Path

/**
 * finance2 server bootstrap: one Armeria port serving gRPC (native +
 * gRPC-Web), a health endpoint, and — once Phase 6 builds it — the SPA.
 *
 * Auth posture from day one: every RPC not on the explicit
 * unauthenticated allowlist is rejected. No authenticators are wired
 * yet (Phase 5 adds SessionService/JwtService from
 * auth-kotlin-toolkit), so today the allowlist is the only reachable
 * surface.
 */
fun main() {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 9090

    val authInterceptor = AuthGrpcInterceptor(
        GrpcAuthConfig(
            unauthenticatedMethods = setOf("finance.InfoService/GetInfo"),
            gate = { _, _ -> Status.PERMISSION_DENIED.withDescription("no roles defined yet") },
        )
    )

    ArmeriaAppServer(
        AppServerConfig(
            port = port,
            grpcServices = listOf(GrpcServiceSpec(InfoGrpcService())),
            grpcInterceptors = listOf(authInterceptor),
            singlePageApp = SinglePageAppConfig(dir = Path.of("spa")),
            healthPath = "/healthz",
        )
    ).start()
}
