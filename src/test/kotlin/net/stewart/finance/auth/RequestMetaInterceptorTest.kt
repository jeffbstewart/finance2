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
        override fun request(numMessages: Int) {}
        override fun sendHeaders(headers: Metadata) { sentHeaders = headers }
        override fun sendMessage(message: Int) {}
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
    fun `deposited cookies flush into response headers`() {
        val call = RecordingCall()
        val seen = intercept(call, metadata("x-forwarded-for" to "203.0.113.9"))
        (seen["sink"] as ResponseCookies).add("finance_session=new; Path=/")
        @Suppress("UNCHECKED_CAST")
        (seen["call"] as ServerCall<Int, Int>).sendHeaders(Metadata())
        val setCookie = call.sentHeaders!!.get(
            Metadata.Key.of("set-cookie", Metadata.ASCII_STRING_MARSHALLER)
        )
        assertEquals("finance_session=new; Path=/", setCookie)
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
