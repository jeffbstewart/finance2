package net.stewart.finance.ops

import com.linecorp.armeria.common.HttpResponse
import com.linecorp.armeria.common.HttpStatus
import com.linecorp.armeria.common.MediaType
import com.linecorp.armeria.server.annotation.Get
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry

/**
 * The ops endpoints, served only on the internal port (ruling
 * 2026-08-19): the health probe, the Prometheus exposition, and a
 * root redirect to the metrics for humans poking the port. Both are
 * unauthenticated and reachable without the proxy - the internal port
 * is LAN-only by deployment.
 */
class InternalHttpService(private val registry: PrometheusMeterRegistry) {

    @Get("/healthz")
    fun health(): HttpResponse = HttpResponse.of(HttpStatus.OK, MediaType.PLAIN_TEXT_UTF_8, "OK")

    @Get("/metrics")
    fun metrics(): HttpResponse = HttpResponse.of(
        HttpStatus.OK,
        MediaType.parse("text/plain; version=0.0.4; charset=utf-8"),
        registry.scrape(),
    )
}
