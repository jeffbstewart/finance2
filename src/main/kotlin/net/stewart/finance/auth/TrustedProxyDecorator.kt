package net.stewart.finance.auth

import com.linecorp.armeria.common.HttpRequest
import com.linecorp.armeria.common.HttpResponse
import com.linecorp.armeria.common.HttpStatus
import com.linecorp.armeria.common.MediaType
import com.linecorp.armeria.server.DecoratingHttpServiceFunction
import com.linecorp.armeria.server.HttpService
import com.linecorp.armeria.server.ServiceRequestContext
import java.net.InetAddress
import java.net.InetSocketAddress

/**
 * Deployment-topology enforcement (build-scope §10, rulings 2026-08-18
 * and 2026-08-19): every main-port request must arrive from a trusted
 * proxy — a request from any other peer is rejected outright, and a
 * request from the proxy that lacks the forwarded client address is a
 * bad request (a misconfigured proxy must fail loudly, not collapse
 * every client into one rate-limit bucket). The internal ops port is
 * exempt: it is LAN-direct by design and [net.stewart.finance.ops.InternalPortGate]
 * restricts what answers there.
 */
class TrustedProxyDecorator(
    trustedProxies: Set<String>,
    private val internalPort: Int = 0,
) : DecoratingHttpServiceFunction {

    private val trusted: Set<InetAddress> = trustedProxies.map { InetAddress.getByName(it) }.toSet()

    init {
        require(trusted.isNotEmpty()) { "TrustedProxyDecorator requires at least one proxy address" }
    }

    override fun serve(delegate: HttpService, ctx: ServiceRequestContext, req: HttpRequest): HttpResponse {
        if (internalPort > 0 && ctx.localAddress().port == internalPort) {
            return delegate.serve(ctx, req)
        }
        val peer = (ctx.remoteAddress() as? InetSocketAddress)?.address
        if (peer == null || peer !in trusted) {
            return HttpResponse.of(
                HttpStatus.FORBIDDEN, MediaType.PLAIN_TEXT_UTF_8,
                "requests are accepted only via the configured proxy",
            )
        }
        if (req.headers().get("x-forwarded-for").isNullOrBlank()) {
            return HttpResponse.of(
                HttpStatus.BAD_REQUEST, MediaType.PLAIN_TEXT_UTF_8,
                "missing forwarded client address",
            )
        }
        return delegate.serve(ctx, req)
    }
}
