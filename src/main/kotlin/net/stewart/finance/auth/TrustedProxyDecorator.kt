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
 * One TRUSTED_PROXIES entry: a single address ("172.28.0.1") or a CIDR
 * range ("172.28.0.0/24", "fd00::/8"). A range is what a proxy on the
 * same Docker host needs: its source address is the gateway of
 * whichever network the container landed on, and a stack re-creation
 * can move that.
 */
class TrustedPeer private constructor(
    private val network: ByteArray,
    private val prefixBits: Int,
    private val text: String,
) {
    fun matches(peer: InetAddress): Boolean {
        val bytes = peer.address
        if (bytes.size != network.size) return false
        val fullBytes = prefixBits / 8
        for (i in 0 until fullBytes) if (bytes[i] != network[i]) return false
        val rest = prefixBits % 8
        if (rest == 0) return true
        val mask = (0xFF shl (8 - rest)) and 0xFF
        return (bytes[fullBytes].toInt() and mask) == (network[fullBytes].toInt() and mask)
    }

    override fun toString(): String = text

    companion object {
        /** Parses an address or CIDR; throws on anything else (config errors fail at boot). */
        fun parse(entry: String): TrustedPeer {
            val spec = entry.trim()
            require(spec.isNotEmpty()) { "empty TRUSTED_PROXIES entry" }
            val slash = spec.indexOf('/')
            val address = InetAddress.getByName(if (slash < 0) spec else spec.substring(0, slash))
            val width = address.address.size * 8
            val bits = if (slash < 0) {
                width
            } else {
                spec.substring(slash + 1).toIntOrNull()
                    ?.takeIf { it in 0..width }
                    ?: throw IllegalArgumentException("bad prefix length in TRUSTED_PROXIES entry \"$spec\"")
            }
            val label = if (slash < 0) address.hostAddress else "${address.hostAddress}/$bits"
            return TrustedPeer(address.address, bits, label)
        }
    }
}

/**
 * Deployment-topology enforcement (build-scope sec. 10, rulings 2026-08-18
 * and 2026-08-19): every main-port request must arrive from a trusted
 * proxy - a request from any other peer is rejected outright, and a
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
    private val trusted: List<TrustedPeer> = trustedProxies.map(TrustedPeer::parse)
    private val trustedForLog: String = trusted.joinToString(", ")

    init {
        require(trusted.isNotEmpty()) { "TrustedProxyDecorator requires at least one proxy address" }
        log.info("Trusted proxies: [{}]; internal port {} is exempt", trustedForLog, internalPort)
    }

    override fun serve(delegate: HttpService, ctx: ServiceRequestContext, req: HttpRequest): HttpResponse {
        if (internalPort > 0 && ctx.localAddress().port == internalPort) {
            return delegate.serve(ctx, req)
        }
        val peer = (ctx.remoteAddress() as? InetSocketAddress)?.address
        if (peer == null || trusted.none { it.matches(peer) }) {
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
