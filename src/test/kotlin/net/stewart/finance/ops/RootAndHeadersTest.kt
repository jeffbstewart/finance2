package net.stewart.finance.ops

import com.linecorp.armeria.common.HttpHeaderNames
import com.linecorp.armeria.common.HttpMethod
import com.linecorp.armeria.common.HttpRequest
import com.linecorp.armeria.common.HttpResponse
import com.linecorp.armeria.common.HttpStatus
import com.linecorp.armeria.server.HttpService
import com.linecorp.armeria.server.ServiceRequestContext
import java.net.InetSocketAddress
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private const val MAIN_PORT = 9090
private const val INTERNAL_PORT = 9091

class RootAndHeadersTest {

    private fun contextAt(port: Int): ServiceRequestContext =
        ServiceRequestContext.builder(HttpRequest.of(HttpMethod.GET, "/"))
            .localAddress(InetSocketAddress("10.0.0.1", port))
            .build()

    @Test
    fun `root is port-aware - SPA on main, metrics on internal`() {
        val redirect = RootRedirect(INTERNAL_PORT)
        val main = redirect.root(contextAt(MAIN_PORT)).aggregate().join()
        assertEquals("/app/", main.headers().get(HttpHeaderNames.LOCATION))
        val internal = redirect.root(contextAt(INTERNAL_PORT)).aggregate().join()
        assertEquals("/metrics", internal.headers().get(HttpHeaderNames.LOCATION))
    }

    @Test
    fun `security headers pin every source to self`() {
        val ctx = contextAt(MAIN_PORT)
        val response = SecurityHeaders()
            .serve(HttpService { _, _ -> HttpResponse.of(HttpStatus.OK) }, ctx, ctx.request())
        response.aggregate().join()
        val csp = ctx.additionalResponseHeaders().get(HttpHeaderNames.CONTENT_SECURITY_POLICY)
        assertEquals(SecurityHeaders.CSP, csp)
        assertTrue(csp!!.startsWith("default-src 'none'"))
        assertTrue(!csp.contains("http"), "no external origins anywhere in the policy")
        assertEquals("nosniff", ctx.additionalResponseHeaders().get(HttpHeaderNames.X_CONTENT_TYPE_OPTIONS))
    }
}
