package net.stewart.finance.ops

import com.linecorp.armeria.common.HttpResponse
import com.linecorp.armeria.server.ServiceRequestContext
import com.linecorp.armeria.server.annotation.Get

/**
 * One port-aware "/" (resolves the Phase 6 route conflict): the
 * internal ops port redirects to /metrics (ruling 2026-08-19), the
 * main port to the SPA.
 */
class RootRedirect(private val internalPort: Int) {

    @Get("/")
    fun root(ctx: ServiceRequestContext): HttpResponse =
        if (ctx.localAddress().port == internalPort) {
            HttpResponse.ofRedirect("/metrics")
        } else {
            HttpResponse.ofRedirect("/app/")
        }
}
