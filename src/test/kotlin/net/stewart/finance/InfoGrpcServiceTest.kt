package net.stewart.finance

import com.linecorp.armeria.client.grpc.GrpcClients
import io.grpc.Status
import io.grpc.StatusException
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import net.stewart.armeria.AppServerConfig
import net.stewart.armeria.ArmeriaAppServer
import net.stewart.armeria.GrpcServiceSpec
import net.stewart.armeria.auth.AuthGrpcInterceptor
import net.stewart.armeria.auth.GrpcAuthConfig
import net.stewart.finance.proto.GetInfoRequest
import net.stewart.finance.proto.InfoServiceGrpcKt

class InfoGrpcServiceTest {

    private var server: ArmeriaAppServer? = null

    @AfterTest
    fun tearDown() {
        server?.stop()
        server = null
    }

    private fun startServer(allowlist: Set<String>): InfoServiceGrpcKt.InfoServiceCoroutineStub {
        val s = ArmeriaAppServer(
            AppServerConfig(
                port = 0,
                grpcServices = listOf(GrpcServiceSpec(InfoGrpcService())),
                grpcInterceptors = listOf(
                    AuthGrpcInterceptor(GrpcAuthConfig(unauthenticatedMethods = allowlist))
                ),
            )
        )
        s.start()
        server = s
        return GrpcClients.newClient(
            "http://127.0.0.1:${s.activePort()}/",
            InfoServiceGrpcKt.InfoServiceCoroutineStub::class.java,
        )
    }

    @Test
    fun `GetInfo returns the app version on the unauthenticated allowlist`() {
        val stub = startServer(allowlist = setOf("finance.InfoService/GetInfo"))
        val response = runBlocking { stub.getInfo(GetInfoRequest.getDefaultInstance()) }
        assertEquals(APP_VERSION, response.version)
    }

    @Test
    fun `the build stamp is read from the environment, dev build without it`() {
        assertEquals("dev build", BuildInfo.fromEnv { null }.label)
        val env = mapOf(
            "FINANCE2_BUILD_PR" to "82",
            "FINANCE2_BUILD_COMMIT" to "7d470c5",
            "FINANCE2_BUILD_TIME" to "2026-08-21T22:30:00-04:00",
        )
        val build = BuildInfo.fromEnv(env::get)
        assertEquals(82, build.pullRequest)
        assertEquals("PR #82 - 2026-08-22 02:30 UTC - 7d470c5", build.label)
        // A partial stamp (a local build that set only the commit) still labels.
        assertEquals("abc1234", BuildInfo.fromEnv(mapOf("FINANCE2_BUILD_COMMIT" to "abc1234")::get).label)
        // Garbage is absent, not fatal.
        assertEquals("dev build", BuildInfo.fromEnv(mapOf("FINANCE2_BUILD_PR" to "x", "FINANCE2_BUILD_TIME" to "yesterday")::get).label)
    }

    @Test
    fun `the build stamp is exposed as two gauges, zero for a dev build`() {
        val stamped = io.micrometer.prometheusmetrics.PrometheusMeterRegistry(
            io.micrometer.prometheusmetrics.PrometheusConfig.DEFAULT
        )
        BuildInfo.fromEnv(
            mapOf(
                "FINANCE2_BUILD_PR" to "82",
                "FINANCE2_BUILD_COMMIT" to "7d470c5",
                "FINANCE2_BUILD_TIME" to "2026-08-22T02:30:00Z",
            )::get
        ).bindTo(stamped)
        val text = stamped.scrape()
        assertTrue(text.contains("finance2_build_pull_request{commit=\"7d470c5\"} 82.0"), text)
        assertTrue(text.contains("finance2_build_timestamp_seconds{commit=\"7d470c5\"} 1.7873658E9"), text)

        val dev = io.micrometer.prometheusmetrics.PrometheusMeterRegistry(
            io.micrometer.prometheusmetrics.PrometheusConfig.DEFAULT
        )
        BuildInfo.DEV.bindTo(dev)
        val devText = dev.scrape()
        assertTrue(devText.contains("finance2_build_pull_request{commit=\"dev\"} 0.0"), devText)
        assertTrue(devText.contains("finance2_build_timestamp_seconds{commit=\"dev\"} 0.0"), devText)
    }

    @Test
    fun `RPCs off the allowlist are rejected while no authenticators are wired`() {
        val stub = startServer(allowlist = emptySet())
        val status = try {
            runBlocking { stub.getInfo(GetInfoRequest.getDefaultInstance()) }
            Status.OK
        } catch (e: StatusException) {
            e.status
        }
        assertEquals(Status.Code.UNAUTHENTICATED, status.code)
    }
}
