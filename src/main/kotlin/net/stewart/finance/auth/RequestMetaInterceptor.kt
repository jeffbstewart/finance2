package net.stewart.finance.auth

import io.grpc.Context
import io.grpc.Contexts
import io.grpc.ForwardingServerCall.SimpleForwardingServerCall
import io.grpc.Grpc
import io.grpc.Metadata
import io.grpc.ServerCall
import io.grpc.ServerCallHandler
import io.grpc.ServerInterceptor
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList

// Request/response plumbing SessionGrpcService needs beyond what the
// toolkit's AuthGrpcInterceptor provides: the trusted client IP for
// login rate limiting, the raw Cookie header (allowlisted RPCs like
// GetSessionStatus resolve the session themselves — the auth
// interceptor skips identity resolution for them), and a sink for
// Set-Cookie response headers.

/**
 * The calling client's IP. Behind HAProxy this comes from
 * X-Forwarded-For (build-scope §10) — trusted because only the proxy
 * can reach the cleartext listener; direct connections (dev) fall back
 * to the socket peer.
 */
val CLIENT_IP_KEY: Context.Key<String> = Context.key("finance-client-ip")

/** The request's raw Cookie header, when present. */
val COOKIE_HEADER_KEY: Context.Key<String> = Context.key("finance-cookie-header")

/** The request's User-Agent, when present. */
val USER_AGENT_KEY: Context.Key<String> = Context.key("finance-user-agent")

/** Sink for Set-Cookie headers the RPC wants on its response. */
val RESPONSE_COOKIES_KEY: Context.Key<ResponseCookies> = Context.key("finance-response-cookies")

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
        val cookies = ResponseCookies()
        val wrapped = object : SimpleForwardingServerCall<ReqT, RespT>(call) {
            override fun sendHeaders(responseHeaders: Metadata) {
                for (cookie in cookies.drain()) {
                    responseHeaders.put(SET_COOKIE_KEY, cookie)
                }
                super.sendHeaders(responseHeaders)
            }
        }
        var ctx = Context.current()
            .withValue(RESPONSE_COOKIES_KEY, cookies)
            .withValue(CLIENT_IP_KEY, clientIp(call, headers))
        headers.get(COOKIE_KEY)?.let { ctx = ctx.withValue(COOKIE_HEADER_KEY, it) }
        headers.get(USER_AGENT_METADATA_KEY)?.let { ctx = ctx.withValue(USER_AGENT_KEY, it) }
        return Contexts.interceptCall(ctx, wrapped, headers, next)
    }

    private fun clientIp(call: ServerCall<*, *>, headers: Metadata): String {
        // HAProxy appends the real client to X-Forwarded-For, so the
        // last element is the address the trusted proxy saw; earlier
        // elements are client-supplied and worthless.
        headers.get(X_FORWARDED_FOR_KEY)?.let { xff ->
            xff.split(',').lastOrNull()?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        }
        val remote = call.attributes.get(Grpc.TRANSPORT_ATTR_REMOTE_ADDR)
        return (remote as? InetSocketAddress)?.address?.hostAddress ?: "unknown"
    }

    private companion object {
        val COOKIE_KEY: Metadata.Key<String> =
            Metadata.Key.of("cookie", Metadata.ASCII_STRING_MARSHALLER)
        val X_FORWARDED_FOR_KEY: Metadata.Key<String> =
            Metadata.Key.of("x-forwarded-for", Metadata.ASCII_STRING_MARSHALLER)
        val USER_AGENT_METADATA_KEY: Metadata.Key<String> =
            Metadata.Key.of("user-agent", Metadata.ASCII_STRING_MARSHALLER)
        val SET_COOKIE_KEY: Metadata.Key<String> =
            Metadata.Key.of("set-cookie", Metadata.ASCII_STRING_MARSHALLER)
    }
}
