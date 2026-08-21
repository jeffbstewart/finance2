package net.stewart.finance.testsupport

import net.stewart.armeria.auth.currentAuthUser
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.UserId
import net.stewart.finance.proto.ResetPortfolioRequest
import net.stewart.finance.proto.ResetPortfolioResponse
import net.stewart.finance.proto.SeedSamplePortfolioRequest
import net.stewart.finance.proto.SeedSamplePortfolioResponse
import net.stewart.finance.proto.TestSupportServiceGrpcKt

/**
 * Test-only fixtures (docs/design/ui-testing.md). Main registers this
 * service ONLY when FINANCE2_TEST_SUPPORT=true — it does not exist in
 * a normal deployment, and calls are session-authenticated like every
 * other RPC.
 */
class TestSupportGrpcService(
    private val portfolios: PortfolioRepository,
    private val seeder: SampleSeeder,
) : TestSupportServiceGrpcKt.TestSupportServiceCoroutineImplBase() {

    override suspend fun resetPortfolio(request: ResetPortfolioRequest): ResetPortfolioResponse {
        portfolio() // asserts an authenticated caller with a portfolio
        seeder.reset()
        return ResetPortfolioResponse.getDefaultInstance()
    }

    override suspend fun seedSamplePortfolio(
        request: SeedSamplePortfolioRequest,
    ): SeedSamplePortfolioResponse {
        val ids = seeder.seed(portfolio())
        return SeedSamplePortfolioResponse.newBuilder().putAllIds(ids).build()
    }

    private fun portfolio(): PortfolioId =
        portfolios.portfolioFor(UserId(currentAuthUser().id))
}
