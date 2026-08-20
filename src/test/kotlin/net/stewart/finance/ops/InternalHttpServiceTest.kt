package net.stewart.finance.ops

import com.linecorp.armeria.common.HttpHeaderNames
import com.linecorp.armeria.common.HttpStatus
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class InternalHttpServiceTest {

    private val registry = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)
    private val service = InternalHttpService(registry)

    @Test
    fun `health answers OK`() {
        val response = service.health().aggregate().join()
        assertEquals(HttpStatus.OK, response.status())
        assertEquals("OK", response.contentUtf8())
    }

    @Test
    fun `metrics expose the registry in Prometheus text format`() {
        registry.counter("finance_test_counter").increment(3.0)
        val response = service.metrics().aggregate().join()
        assertEquals(HttpStatus.OK, response.status())
        assertTrue(response.contentUtf8().contains("finance_test_counter"))
    }

}
