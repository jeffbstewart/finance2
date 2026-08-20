package net.stewart.finance.auth

import io.grpc.Attributes
import io.grpc.Metadata
import io.grpc.MethodDescriptor
import io.grpc.ServerCall
import io.grpc.ServerCallHandler
import io.grpc.Status
import java.io.ByteArrayInputStream
import java.io.InputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RequestMetaInterceptorTest {

    private val interceptor = RequestMetaInterceptor()

    private object NoopMarshaller : MethodDescriptor.Marshaller<Int> {
        override fun stream(value: Int): InputStream = ByteArrayInputStream(ByteArray(0))
        override fun parse(stream: InputStream): Int = 0
    }

    private val descriptor: MethodDescriptor<Int, Int> = MethodDescriptor.newBuilder<Int, Int>()
        .setType(MethodDescriptor.MethodType.UNARY)
        .setFullMethodName("test.Service/Method")
        .setRequestMarshaller(NoopMarshaller)
        .setResponseMarshaller(NoopMarshaller)
        .build()

    private inner class RecordingCall : ServerCall<Int, Int>() {
        var closedStatus: Status? = null
        var sentHeaders: Metadata? = null
        var messagesSent = 0
        override fun request(numMessages: Int) {}
        override fun sendHeaders(headers: Metadata) { sentHeaders = headers }
        override fun sendMessage(message: Int) { messagesSent++ }
        override fun close(status: Status, trailers: Metadata) { closedStatus = status }
        override fun isCancelled(): Boolean = false
        override fun getMethodDescriptor(): MethodDescriptor<Int, Int> = descriptor
        override fun getAttributes(): Attributes = Attributes.EMPTY
        override fun getAuthority(): String = "finance.local"
    }

    private fun metadata(vararg pairs: Pair<String, String>): Metadata {
        val md = Metadata()
        pairs.forEach { (k, v) -> md.put(Metadata.Key.of(k, Metadata.ASCII_STRING_MARSHALLER), v) }
        return md
    }

    /** Runs the interceptor and returns what the handler saw in its context. */
    private fun intercept(call: RecordingCall, headers: Metadata): Map<String, Any?> {
        val seen = mutableMapOf<String, Any?>()
        val handler = ServerCallHandler<Int, Int> { wrappedCall, _ ->
            seen["ip"] = CLIENT_IP_KEY.get()
            seen["cookie"] = COOKIE_HEADER_KEY.get()
            seen["origin"] = ORIGIN_KEY.get()
            seen["authority"] = AUTHORITY_KEY.get()
            seen["sink"] = RESPONSE_COOKIES_KEY.get()
            seen["call"] = wrappedCall
            object : ServerCall.Listener<Int>() {}
        }
        interceptor.interceptCall(call, headers, handler)
        return seen
    }

    @Test
    fun `the last forwarded-for element wins`() {
        val seen = intercept(RecordingCall(), metadata("x-forwarded-for" to "6.6.6.6, 203.0.113.9"))
        // Earlier elements are client-supplied; the last is what the
        // trusted proxy saw.
        assertEquals("203.0.113.9", seen["ip"])
    }

    @Test
    fun `cookie, origin, and authority reach the context`() {
        val seen = intercept(
            RecordingCall(),
            metadata(
                "x-forwarded-for" to "203.0.113.9",
                "cookie" to "finance_session=tok",
                "origin" to "https://finance.local",
            ),
        )
        assertEquals("finance_session=tok", seen["cookie"])
        assertEquals("https://finance.local", seen["origin"])
        assertEquals("finance.local", seen["authority"])
    }

    @Test
    fun `cookies deposited after the eager header send still flush`() {
        // The real transport calls sendHeaders BEFORE the handler body
        // runs, then the handler deposits its cookie, then the response
        // message goes out. The cookie must ride the actual header
        // write, not the too-early sendHeaders call.
        val call = RecordingCall()
        val seen = intercept(call, metadata("x-forwarded-for" to "203.0.113.9"))
        @Suppress("UNCHECKED_CAST")
        val wrapped = seen["call"] as ServerCall<Int, Int>
        wrapped.sendHeaders(Metadata())
        assertNull(call.sentHeaders, "headers must be held until the response flows")
        (seen["sink"] as ResponseCookies).add("finance_session=new; Path=/")
        wrapped.sendMessage(0)
        val setCookie = call.sentHeaders!!.get(
            Metadata.Key.of("set-cookie", Metadata.ASCII_STRING_MARSHALLER)
        )
        assertEquals("finance_session=new; Path=/", setCookie)
        assertTrue(call.messagesSent == 1, "message must follow the header flush")

        // A second header send must not happen at close.
        call.sentHeaders = null
        wrapped.close(Status.OK, Metadata())
        assertNull(call.sentHeaders)
        assertEquals(Status.Code.OK, call.closedStatus?.code)
    }

    @Test
    fun `error responses without a message still flush held headers`() {
        val call = RecordingCall()
        val seen = intercept(call, metadata("x-forwarded-for" to "203.0.113.9"))
        @Suppress("UNCHECKED_CAST")
        val wrapped = seen["call"] as ServerCall<Int, Int>
        wrapped.sendHeaders(Metadata())
        (seen["sink"] as ResponseCookies).add("finance_session=; Max-Age=0")
        wrapped.close(Status.UNAUTHENTICATED, Metadata())
        val setCookie = call.sentHeaders!!.get(
            Metadata.Key.of("set-cookie", Metadata.ASCII_STRING_MARSHALLER)
        )
        assertEquals("finance_session=; Max-Age=0", setCookie)
        assertEquals(Status.Code.UNAUTHENTICATED, call.closedStatus?.code)
    }

    @Test
    fun `trailers-only close without headers stays trailers-only`() {
        val call = RecordingCall()
        val seen = intercept(call, metadata("x-forwarded-for" to "203.0.113.9"))
        @Suppress("UNCHECKED_CAST")
        val wrapped = seen["call"] as ServerCall<Int, Int>
        wrapped.close(Status.PERMISSION_DENIED, Metadata())
        assertNull(call.sentHeaders, "no sendHeaders from grpc means none forwarded")
        assertEquals(Status.Code.PERMISSION_DENIED, call.closedStatus?.code)
    }

    @Test
    fun `oversized user agents are rejected as bad requests`() {
        val call = RecordingCall()
        val seen = intercept(
            call,
            metadata("user-agent" to "x".repeat(MAX_USER_AGENT_LENGTH + 1)),
        )
        assertNull(seen["ip"], "handler must not run for a rejected call")
        assertEquals(Status.Code.INVALID_ARGUMENT, call.closedStatus?.code)

        // A user agent at exactly the limit passes.
        var handlerRan = false
        interceptor.interceptCall(
            RecordingCall(),
            metadata("user-agent" to "x".repeat(MAX_USER_AGENT_LENGTH)),
        ) { _, _ ->
            handlerRan = true
            object : ServerCall.Listener<Int>() {}
        }
        assertTrue(handlerRan)
    }
}
