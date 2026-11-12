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

private const val MAIN_PORT = 9090
private const val INTERNAL_PORT = 9091

class TrustedProxyDecoratorTest {

    private val decorator = TrustedProxyDecorator(setOf("10.0.0.2"), internalPort = INTERNAL_PORT)
    private val okService = HttpService { _, _ -> HttpResponse.of(HttpStatus.OK) }

    private fun serve(
        path: String,
        peer: String,
        localPort: Int = MAIN_PORT,
        vararg headers: Pair<String, String>,
    ): HttpStatus {
        var request = HttpRequest.of(HttpMethod.POST, path)
        if (headers.isNotEmpty()) {
            val builder = request.headers().toBuilder()
            headers.forEach { (k, v) -> builder.add(k, v) }
            request = request.withHeaders(builder.build())
        }
        val ctx = ServiceRequestContext.builder(request)
            .remoteAddress(InetSocketAddress(peer, 55555))
            .localAddress(InetSocketAddress("10.0.0.1", localPort))
            .build()
        return decorator.serve(okService, ctx, request).aggregate().join().status()
    }

    @Test
    fun `requests from the proxy with a forwarded address pass`() {
        assertEquals(
            HttpStatus.OK,
            serve("/finance.SessionService/Login", "10.0.0.2", MAIN_PORT, "x-forwarded-for" to "203.0.113.9"),
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
    fun `a CIDR entry trusts the whole range and nothing beside it`() {
        // A same-host proxy reaches us from the gateway of whatever
        // network the container landed on; a range survives the move.
        val ranged = TrustedProxyDecorator(setOf("172.28.0.0/24", "fd00::/8"), internalPort = INTERNAL_PORT)
        fun from(peer: String): HttpStatus {
            val request = HttpRequest.of(HttpMethod.POST, "/finance.SessionService/Login")
                .withHeaders(
                    HttpRequest.of(HttpMethod.POST, "/x").headers().toBuilder()
                        .add("x-forwarded-for", "203.0.113.9").build()
                )
            val ctx = ServiceRequestContext.builder(request)
                .remoteAddress(InetSocketAddress(peer, 55555))
                .localAddress(InetSocketAddress("10.0.0.1", MAIN_PORT))
                .build()
            return ranged.serve(okService, ctx, request).aggregate().join().status()
        }
        assertEquals(HttpStatus.OK, from("172.28.0.1"))
        assertEquals(HttpStatus.OK, from("172.28.0.254"))
        assertEquals(HttpStatus.FORBIDDEN, from("172.28.1.1"))
        assertEquals(HttpStatus.FORBIDDEN, from("10.0.0.2"))
        assertEquals(HttpStatus.OK, from("fd12:3456::1"))
        assertEquals(HttpStatus.FORBIDDEN, from("fe80::1"))
    }

    @Test
    fun `malformed entries fail at construction, not at request time`() {
        for (bad in listOf("172.28.0.0/33", "172.28.0.0/x", "", "not an address")) {
            val failed = runCatching { TrustedProxyDecorator(setOf(bad)) }.isFailure
            assertEquals(true, failed, "expected \"$bad\" to be rejected")
        }
        // An exact address still means exactly that address.
        assertEquals("10.0.0.2", TrustedPeer.parse(" 10.0.0.2 ").toString())
        assertEquals("172.28.0.0/24", TrustedPeer.parse("172.28.0.0/24").toString())
    }

    @Test
    fun `the internal ops port bypasses proxy enforcement`() {
        // LAN-direct by design; InternalPortGate restricts what answers.
        assertEquals(HttpStatus.OK, serve("/metrics", "10.0.0.99", INTERNAL_PORT))
    }
}
