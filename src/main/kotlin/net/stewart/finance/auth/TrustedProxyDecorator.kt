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
import org.slf4j.LoggerFactory

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

    private val log = LoggerFactory.getLogger(TrustedProxyDecorator::class.java)
    private val trusted: Set<InetAddress> = trustedProxies.map { InetAddress.getByName(it) }.toSet()
    private val trustedForLog: String = trusted.joinToString(", ") { it.hostAddress }

    init {
        require(trusted.isNotEmpty()) { "TrustedProxyDecorator requires at least one proxy address" }
        log.info("Trusted proxies: [{}]; internal port {} is exempt", trustedForLog, internalPort)
    }

    override fun serve(delegate: HttpService, ctx: ServiceRequestContext, req: HttpRequest): HttpResponse {
        if (internalPort > 0 && ctx.localAddress().port == internalPort) {
            return delegate.serve(ctx, req)
        }
        val peer = (ctx.remoteAddress() as? InetSocketAddress)?.address
        if (peer == null || peer !in trusted) {
            // Diagnosable on purpose: the usual cause is the proxy reaching
            // us from an address other than the one in TRUSTED_PROXIES
            // (Docker bridge gateway, IPv6 loopback, a NAT hop), and the
            // 403 body deliberately says nothing about which.
            log.error(
                "Rejected {} {} from untrusted peer {} (local {}:{}); trusted proxies: [{}]",
                req.method(), req.path(),
                peer?.hostAddress ?: "<unknown: ${ctx.remoteAddress()}>",
                ctx.localAddress().address?.hostAddress, ctx.localAddress().port,
                trustedForLog,
            )
            return HttpResponse.of(
                HttpStatus.FORBIDDEN, MediaType.PLAIN_TEXT_UTF_8,
                "requests are accepted only via the configured proxy",
            )
        }
        if (req.headers().get("x-forwarded-for").isNullOrBlank()) {
            log.error(
                "Rejected {} {} from trusted proxy {}: no X-Forwarded-For header (proxy must set it)",
                req.method(), req.path(), peer.hostAddress,
            )
            return HttpResponse.of(
                HttpStatus.BAD_REQUEST, MediaType.PLAIN_TEXT_UTF_8,
                "missing forwarded client address",
            )
        }
        return delegate.serve(ctx, req)
    }
}
