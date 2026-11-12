package net.stewart.finance.ops

import com.linecorp.armeria.common.HttpMethod
import com.linecorp.armeria.common.HttpRequest
import com.linecorp.armeria.common.HttpResponse
import com.linecorp.armeria.common.HttpStatus
import com.linecorp.armeria.server.HttpService
import com.linecorp.armeria.server.ServiceRequestContext
import java.net.InetSocketAddress
import kotlin.test.Test
import kotlin.test.assertEquals

private const val MAIN_PORT = 9090
private const val INTERNAL_PORT = 9091

class InternalPortGateTest {

    private val gate = InternalPortGate(INTERNAL_PORT)
    private val okService = HttpService { _, _ -> HttpResponse.of(HttpStatus.OK) }

    private fun serve(path: String, localPort: Int): HttpStatus {
        val request = HttpRequest.of(HttpMethod.GET, path)
        val ctx = ServiceRequestContext.builder(request)
            .localAddress(InetSocketAddress("10.0.0.1", localPort))
            .build()
        return gate.serve(okService, ctx, request).aggregate().join().status()
    }

    @Test
    fun `only the ops paths answer on the internal port`() {
        assertEquals(HttpStatus.OK, serve("/healthz", INTERNAL_PORT))
        assertEquals(HttpStatus.OK, serve("/metrics", INTERNAL_PORT))
        assertEquals(HttpStatus.OK, serve("/", INTERNAL_PORT))
        assertEquals(HttpStatus.NOT_FOUND, serve("/finance.SessionService/Login", INTERNAL_PORT))
        assertEquals(HttpStatus.NOT_FOUND, serve("/app/", INTERNAL_PORT))
    }

    @Test
    fun `the main port is untouched`() {
        assertEquals(HttpStatus.OK, serve("/finance.SessionService/Login", MAIN_PORT))
        assertEquals(HttpStatus.OK, serve("/app/", MAIN_PORT))
    }
}
