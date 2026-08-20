package net.stewart.finance.auth

import io.grpc.Context
import io.grpc.Contexts
import io.grpc.ForwardingServerCall.SimpleForwardingServerCall
import io.grpc.Grpc
import io.grpc.Metadata
import io.grpc.ServerCall
import io.grpc.ServerCallHandler
import io.grpc.ServerInterceptor
import io.grpc.Status
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import net.stewart.armeria.auth.requestAuthority

// Request/response plumbing SessionGrpcService needs beyond what the
// toolkit's AuthGrpcInterceptor provides: the trusted client IP for
// login rate limiting, the raw Cookie/Origin headers (allowlisted RPCs
// like GetSessionStatus resolve the session themselves — the auth
// interceptor skips identity resolution for them), and a sink for
// Set-Cookie response headers.

/**
 * The calling client's IP. Behind HAProxy this comes from
 * X-Forwarded-For (build-scope §10) — [TrustedProxyDecorator] has
 * already rejected requests from any peer other than the proxy and
 * requests missing the header; direct connections (dev, no proxies
 * configured) fall back to the socket peer.
 */
val CLIENT_IP_KEY: Context.Key<String> = Context.key("finance-client-ip")

/** The request's raw Cookie header, when present. */
val COOKIE_HEADER_KEY: Context.Key<String> = Context.key("finance-cookie-header")

/** The request's Origin header, when present (CSRF check input). */
val ORIGIN_KEY: Context.Key<String> = Context.key("finance-origin")

/** The request authority (Host), for the Origin CSRF check. */
val AUTHORITY_KEY: Context.Key<String> = Context.key("finance-authority")

/** The request's User-Agent, when present. */
val USER_AGENT_KEY: Context.Key<String> = Context.key("finance-user-agent")

/** Sink for Set-Cookie headers the RPC wants on its response. */
val RESPONSE_COOKIES_KEY: Context.Key<ResponseCookies> = Context.key("finance-response-cookies")

/** Longest accepted User-Agent (ruling 2026-08-18): the session store's
 *  column is VARCHAR(500); anything over this is a bad request. */
const val MAX_USER_AGENT_LENGTH = 400

class ResponseCookies {
    private val values = CopyOnWriteArrayList<String>()

    fun add(setCookieHeader: String) {
        values.add(setCookieHeader)
    }

    internal fun drain(): List<String> = values.toList()
}

class RequestMetaInterceptor : ServerInterceptor {

    override fun <ReqT, RespT> interceptCall(
        call: ServerCall<ReqT, RespT>,
        headers: Metadata,
        next: ServerCallHandler<ReqT, RespT>,
    ): ServerCall.Listener<ReqT> {
        val userAgent = headers.get(USER_AGENT_METADATA_KEY)
        if (userAgent != null && userAgent.length > MAX_USER_AGENT_LENGTH) {
            call.close(
                Status.INVALID_ARGUMENT.withDescription(
                    "user-agent exceeds $MAX_USER_AGENT_LENGTH characters"
                ),
                Metadata(),
            )
            return object : ServerCall.Listener<ReqT>() {}
        }

        val cookies = ResponseCookies()
        val wrapped = object : SimpleForwardingServerCall<ReqT, RespT>(call) {
            // The transport (grpc-kotlin over Armeria) calls
            // sendHeaders before the handler body has run, so any
            // cookie the RPC deposits would miss a flush done here.
            // Hold the headers and flush them at the first message —
            // or at close, so error responses still carry them.
            private var pendingHeaders: Metadata? = null
            private var headersSent = false

            override fun sendHeaders(responseHeaders: Metadata) {
                pendingHeaders = responseHeaders
            }

            override fun sendMessage(message: RespT) {
                flushHeaders()
                super.sendMessage(message)
            }

            override fun close(status: Status, trailers: Metadata) {
                flushHeaders()
                super.close(status, trailers)
            }

            private fun flushHeaders() {
                val headers = pendingHeaders ?: return
                if (headersSent) return
                headersSent = true
                for (cookie in cookies.drain()) {
                    headers.put(SET_COOKIE_KEY, cookie)
                }
                super.sendHeaders(headers)
            }
        }
        var ctx = Context.current()
            .withValue(RESPONSE_COOKIES_KEY, cookies)
            .withValue(CLIENT_IP_KEY, clientIp(call, headers))
        headers.get(COOKIE_KEY)?.let { ctx = ctx.withValue(COOKIE_HEADER_KEY, it) }
        headers.get(ORIGIN_METADATA_KEY)?.let { ctx = ctx.withValue(ORIGIN_KEY, it) }
        // requestAuthority, not call.authority: Armeria's gRPC bridge
        // returns null authority (gRPC-Web especially), which would
        // fail-close SessionGrpcService's Origin check for browsers.
        requestAuthority(call)?.let { ctx = ctx.withValue(AUTHORITY_KEY, it) }
        userAgent?.let { ctx = ctx.withValue(USER_AGENT_KEY, it) }
        return Contexts.interceptCall(ctx, wrapped, headers, next)
    }

    private fun clientIp(call: ServerCall<*, *>, headers: Metadata): String {
        // HAProxy appends the real client to X-Forwarded-For, so the
        // last element is the address the trusted proxy saw; earlier
        // elements are client-supplied and worthless. The decorator
        // has already guaranteed the header's presence when proxies
        // are configured.
        headers.get(X_FORWARDED_FOR_KEY)?.let { xff ->
            xff.split(',').lastOrNull()?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        }
        val remote = call.attributes.get(Grpc.TRANSPORT_ATTR_REMOTE_ADDR)
        return (remote as? InetSocketAddress)?.address?.hostAddress ?: "unknown"
    }

    private companion object {
        val COOKIE_KEY: Metadata.Key<String> =
            Metadata.Key.of("cookie", Metadata.ASCII_STRING_MARSHALLER)
        val ORIGIN_METADATA_KEY: Metadata.Key<String> =
            Metadata.Key.of("origin", Metadata.ASCII_STRING_MARSHALLER)
        val X_FORWARDED_FOR_KEY: Metadata.Key<String> =
            Metadata.Key.of("x-forwarded-for", Metadata.ASCII_STRING_MARSHALLER)
        val USER_AGENT_METADATA_KEY: Metadata.Key<String> =
            Metadata.Key.of("user-agent", Metadata.ASCII_STRING_MARSHALLER)
        val SET_COOKIE_KEY: Metadata.Key<String> =
            Metadata.Key.of("set-cookie", Metadata.ASCII_STRING_MARSHALLER)
    }
}
