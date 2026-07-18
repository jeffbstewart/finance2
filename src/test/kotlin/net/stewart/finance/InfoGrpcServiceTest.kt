package net.stewart.finance

import com.linecorp.armeria.client.grpc.GrpcClients
import io.grpc.Status
import io.grpc.StatusException
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
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
