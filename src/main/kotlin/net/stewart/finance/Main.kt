package net.stewart.finance

import io.micrometer.core.instrument.binder.jvm.JvmGcMetrics
import io.micrometer.core.instrument.binder.jvm.JvmMemoryMetrics
import io.micrometer.core.instrument.binder.system.ProcessorMetrics
import io.micrometer.core.instrument.binder.system.UptimeMetrics
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import java.nio.file.Path
import java.security.SecureRandom
import net.stewart.armeria.AppServerConfig
import net.stewart.armeria.ArmeriaAppServer
import net.stewart.armeria.GrpcServiceSpec
import net.stewart.armeria.HttpServiceSpec
import net.stewart.armeria.SinglePageAppConfig
import net.stewart.armeria.auth.AuthGrpcInterceptor
import net.stewart.armeria.auth.grpcAuthConfig
import net.stewart.auth.LoginService
import net.stewart.auth.SessionService
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.finance.auth.RequestMetaInterceptor
import net.stewart.finance.auth.TrustedProxyDecorator
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.AssetClassRepository
import net.stewart.finance.db.BrokerRepository
import net.stewart.finance.db.ClassificationRepository
import net.stewart.finance.db.TargetAllocationRepository
import net.stewart.finance.db.FxRepository
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.CpiRepository
import net.stewart.finance.feeds.CpiFeed
import net.stewart.finance.feeds.EcbFxFeed
import net.stewart.finance.ops.AuthMaintenance
import net.stewart.finance.ops.PeriodicJob
import net.stewart.finance.ops.InternalHttpService
import net.stewart.finance.ops.InternalPortGate
import net.stewart.finance.proto.InfoServiceGrpc
import net.stewart.finance.proto.SessionServiceGrpc
import net.stewart.h2toolkit.H2Config
import net.stewart.h2toolkit.H2Database
import org.slf4j.LoggerFactory

/**
 * finance2 server bootstrap: one Armeria port serving gRPC (native +
 * gRPC-Web), a health endpoint, and — once Phase 6 builds it — the SPA.
 * TLS terminates at HAProxy; this listener stays cleartext. When
 * TRUSTED_PROXIES is set, only those peers may talk to it (except
 * /healthz and /metrics) and every proxied request must carry the
 * forwarded client address (build-scope §10).
 *
 * Auth posture: every RPC not on the explicit unauthenticated
 * allowlist requires a valid session cookie (auth-kotlin-toolkit via
 * the armeria auth bridge, build-scope §8). The allowlisted
 * SessionService RPCs implement first-run setup, login, and logout;
 * first-run setup additionally requires the per-run token printed to
 * this process's log.
 */
fun main() {
    val log = LoggerFactory.getLogger("net.stewart.finance.Main")
    val port = System.getenv("PORT")?.toIntOrNull() ?: 9090
    val internalPort = System.getenv("INTERNAL_PORT")?.toIntOrNull() ?: 9091

    // One registry feeds /metrics on the internal port: Armeria server
    // metrics, HikariCP pool stats, and the standard JVM binders.
    val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    JvmMemoryMetrics().bindTo(registry)
    JvmGcMetrics().bindTo(registry)
    ProcessorMetrics().bindTo(registry)
    UptimeMetrics().bindTo(registry)

    val db = H2Database(
        H2Config(
            basePath = requireEnv("DB_PATH"),
            password = requireEnv("H2_PASSWORD"),
            filePassword = requireEnv("H2_FILE_PASSWORD"),
            metricsRegistry = registry,
        )
    ).apply { init() }

    val users = FinanceUserRepository(db.dataSource)
    val sessions = SessionService(db.dataSource, users, cookieName = "finance_session")
    val logins = LoginService(db.dataSource, users)
    val secureCookies = System.getenv("COOKIE_SECURE")?.toBooleanStrictOrNull() ?: true

    AuthMaintenance(sessions, logins).start()

    // ECB publishes reference rates once per business day; a daily
    // pull of the rolling 90-day feed keeps fx_rates current and
    // backfills after downtime (build-scope §5; ruling 2026-08-19:
    // simple in-process scheduling, one always-running container).
    val fxFeed = EcbFxFeed(net.stewart.finance.db.FxRepository(db.dataSource))
    PeriodicJob("ecb-fx-refresh", java.time.Duration.ofDays(1)) { fxFeed.refresh() }.start()

    // CPI: seeded from the embedded snapshot so inflation adjustment
    // works offline from first boot (spec S10); FRED publishes monthly,
    // so a weekly background pull is plenty.
    val cpiFeed = CpiFeed(CpiRepository(db.dataSource))
    cpiFeed.seedIfEmpty()
    PeriodicJob("fred-cpi-refresh", java.time.Duration.ofDays(7)) { cpiFeed.refresh() }.start()

    val setupToken = if (users.hasUsers()) null else generateSetupToken().also {
        log.info("First-run setup: no user exists. Setup token (required by CreateFirstUser): {}", it)
    }

    val trustedProxies = System.getenv("TRUSTED_PROXIES")
        ?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet()
        .orEmpty()
    if (trustedProxies.isEmpty()) {
        log.warn("TRUSTED_PROXIES is not set — accepting direct connections (dev mode only)")
    }

    // Allowlist derived from generated descriptors: a proto rename is a
    // compile error here, never a silent auth change.
    val authInterceptor = AuthGrpcInterceptor(
        grpcAuthConfig(
            sessionService = sessions,
            unauthenticatedMethods = setOf(
                InfoServiceGrpc.getGetInfoMethod().fullMethodName,
                SessionServiceGrpc.getGetSessionStatusMethod().fullMethodName,
                SessionServiceGrpc.getCreateFirstUserMethod().fullMethodName,
                SessionServiceGrpc.getLoginMethod().fullMethodName,
                SessionServiceGrpc.getLogoutMethod().fullMethodName,
            ),
        )
    )

    // Ops endpoints live only on the internal port (ruling
    // 2026-08-19): the gate 404s everything else arriving there, the
    // toolkit 404s the ops services on the main port, and the proxy
    // decorator skips the internal port (LAN-direct by design).
    //
    // Phase 6 note: the internal "/" (redirect to /metrics) and the
    // SPA's root redirect both want the "/" route — when the SPA
    // lands, replace them with one port-aware root handler.
    ArmeriaAppServer(
        AppServerConfig(
            port = port,
            grpcServices = run {
                val portfolios = PortfolioRepository(db.dataSource)
                val brokers = BrokerRepository(db.dataSource)
                val accounts = AccountRepository(db.dataSource)
                val reporting = ReportingCurrency(FxRepository(db.dataSource))
                val securities = SecurityRepository(db.dataSource)
                val classifications = ClassificationRepository(db.dataSource)
                val privatePrices = PrivatePriceRepository(db.dataSource)
                listOf(
                    GrpcServiceSpec(InfoGrpcService()),
                    GrpcServiceSpec(SessionGrpcService(users, sessions, logins, setupToken, secureCookies)),
                    GrpcServiceSpec(BrokerGrpcService(portfolios, brokers, accounts, reporting)),
                    GrpcServiceSpec(AccountGrpcService(portfolios, brokers, accounts, reporting)),
                    GrpcServiceSpec(
                        SecurityGrpcService(
                            portfolios, securities, classifications, privatePrices,
                            AssetClassRepository(db.dataSource),
                            cpiSeries = { cpiFeed.series() },
                        )
                    ),
                    GrpcServiceSpec(
                        PositionGrpcService(
                            portfolios, accounts, securities,
                            LotRepository(db.dataSource), SaleRepository(db.dataSource),
                            HoldingRepository(db.dataSource), privatePrices, reporting,
                            cpiSeries = { cpiFeed.series() },
                        )
                    ),
                    GrpcServiceSpec(
                        AllocationGrpcService(
                            portfolios, accounts, securities,
                            LotRepository(db.dataSource), SaleRepository(db.dataSource),
                            HoldingRepository(db.dataSource), privatePrices, classifications,
                            AssetClassRepository(db.dataSource), TargetAllocationRepository(db.dataSource),
                            reporting,
                        )
                    ),
                )
            },
            grpcInterceptors = listOf(RequestMetaInterceptor(), authInterceptor),
            globalDecorators = listOf(InternalPortGate(internalPort)) +
                if (trustedProxies.isEmpty()) emptyList()
                else listOf(TrustedProxyDecorator(trustedProxies, internalPort)),
            singlePageApp = SinglePageAppConfig(dir = Path.of("spa"), redirectRoot = false),
            healthPath = null,
            internalPort = internalPort,
            internalHttpServices = listOf(HttpServiceSpec(InternalHttpService(registry))),
            customizer = { it.meterRegistry(registry) },
        )
    ).start()
}

private fun generateSetupToken(): String {
    val bytes = ByteArray(16)
    SecureRandom().nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
}

private fun requireEnv(name: String): String =
    System.getenv(name)?.takeIf { it.isNotBlank() }
        ?: error("missing required environment variable $name — see example.env")
