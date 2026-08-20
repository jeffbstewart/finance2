package net.stewart.finance.ops

import com.linecorp.armeria.common.HttpHeaderNames
import com.linecorp.armeria.common.HttpRequest
import com.linecorp.armeria.common.HttpResponse
import com.linecorp.armeria.server.DecoratingHttpServiceFunction
import com.linecorp.armeria.server.HttpService
import com.linecorp.armeria.server.ServiceRequestContext

/**
 * Enforces the no-third-party-requests property (ruling 2026-08-20):
 * the SPA vendors its fonts, so the CSP can pin every source to
 * 'self'. style-src additionally allows 'unsafe-inline' because
 * Angular Material injects runtime styles — the standard Angular
 * trade-off; scripts stay strictly 'self'.
 */
class SecurityHeaders : DecoratingHttpServiceFunction {

    override fun serve(delegate: HttpService, ctx: ServiceRequestContext, req: HttpRequest): HttpResponse {
        ctx.mutateAdditionalResponseHeaders { headers ->
            headers.add(HttpHeaderNames.CONTENT_SECURITY_POLICY, CSP)
            headers.add(HttpHeaderNames.X_CONTENT_TYPE_OPTIONS, "nosniff")
            headers.add(HttpHeaderNames.REFERRER_POLICY, "same-origin")
        }
        return delegate.serve(ctx, req)
    }

    companion object {
        const val CSP =
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
                "font-src 'self'; img-src 'self' data:; connect-src 'self'; " +
                "manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    }
}
