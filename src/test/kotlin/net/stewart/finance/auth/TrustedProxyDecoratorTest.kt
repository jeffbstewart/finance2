package net.stewart.finance.auth

import com.linecorp.armeria.common.HttpMethod
import com.linecorp.armeria.common.HttpRequest
import com.linecorp.armeria.common.HttpResponse
import com.linecorp.armeria.common.HttpStatus
import com.linecorp.armeria.server.HttpService
import com.linecorp.armeria.server.ServiceRequestContext
import java.net.InetSocketAddress
import kotlin.test.Test
import kotlin.test.assertEquals

class TrustedProxyDecoratorTest {

    private val decorator = TrustedProxyDecorator(setOf("10.0.0.2"))
    private val okService = HttpService { _, _ -> HttpResponse.of(HttpStatus.OK) }

    private fun serve(path: String, peer: String, vararg headers: Pair<String, String>): HttpStatus {
        var request = HttpRequest.of(HttpMethod.POST, path)
        if (headers.isNotEmpty()) {
            val builder = request.headers().toBuilder()
            headers.forEach { (k, v) -> builder.add(k, v) }
            request = request.withHeaders(builder.build())
        }
        val ctx = ServiceRequestContext.builder(request)
            .remoteAddress(InetSocketAddress(peer, 55555))
            .build()
        return decorator.serve(okService, ctx, request).aggregate().join().status()
    }

    @Test
    fun `requests from the proxy with a forwarded address pass`() {
        assertEquals(
            HttpStatus.OK,
            serve("/finance.SessionService/Login", "10.0.0.2", "x-forwarded-for" to "203.0.113.9"),
        )
    }

    @Test
    fun `requests from any other peer are rejected`() {
        assertEquals(HttpStatus.FORBIDDEN, serve("/finance.SessionService/Login", "10.0.0.99"))
    }

    @Test
    fun `proxy requests missing the forwarded address are bad requests`() {
        assertEquals(HttpStatus.BAD_REQUEST, serve("/finance.SessionService/Login", "10.0.0.2"))
    }

    @Test
    fun `health and metrics stay reachable directly`() {
        assertEquals(HttpStatus.OK, serve("/healthz", "10.0.0.99"))
        assertEquals(HttpStatus.OK, serve("/metrics", "10.0.0.99"))
    }
}
