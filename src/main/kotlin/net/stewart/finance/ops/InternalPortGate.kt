package net.stewart.finance.ops

import com.linecorp.armeria.common.HttpRequest
import com.linecorp.armeria.common.HttpResponse
import com.linecorp.armeria.common.HttpStatus
import com.linecorp.armeria.server.DecoratingHttpServiceFunction
import com.linecorp.armeria.server.HttpService
import com.linecorp.armeria.server.ServiceRequestContext

/**
 * The internal port serves *only* the ops endpoints (ruling
 * 2026-08-19): anything else arriving there — gRPC, the SPA, future
 * routes, which all share Armeria's route table across ports — is
 * 404'd. The toolkit's internal-only decorator handles the mirror
 * direction (ops services 404 on the main port).
 */
class InternalPortGate(
    private val internalPort: Int,
    private val allowedPaths: Set<String> = setOf("/", "/healthz", "/metrics"),
) : DecoratingHttpServiceFunction {

    init {
        require(internalPort > 0) { "InternalPortGate requires a positive internal port" }
    }

    override fun serve(delegate: HttpService, ctx: ServiceRequestContext, req: HttpRequest): HttpResponse {
        if (ctx.localAddress().port == internalPort && ctx.path() !in allowedPaths) {
            return HttpResponse.of(HttpStatus.NOT_FOUND)
        }
        return delegate.serve(ctx, req)
    }
}
