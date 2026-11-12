package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import java.sql.SQLException
import java.time.LocalDate
import net.stewart.armeria.auth.currentAuthUser
import net.stewart.finance.api.AccountValuation
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.api.toFormatted
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.BrokerRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.domain.BrokerId
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.UserId
import net.stewart.finance.proto.BrokerServiceGrpcKt
import net.stewart.finance.proto.BrokerSummary
import net.stewart.finance.proto.CreateBrokerRequest
import net.stewart.finance.proto.CreateBrokerResponse
import net.stewart.finance.proto.DeleteBrokerRequest
import net.stewart.finance.proto.DeleteBrokerResponse
import net.stewart.finance.proto.ListBrokersRequest
import net.stewart.finance.proto.ListBrokersResponse
import net.stewart.finance.proto.RenameBrokerRequest
import net.stewart.finance.proto.RenameBrokerResponse
import net.stewart.finance.proto.SetBrokerHiddenRequest
import net.stewart.finance.proto.SetBrokerHiddenResponse

/**
 * BrokerService (spec sec. 7 "Brokers", sec. 9.1-sec. 9.3) with the sec. 5.9 guard
 * rails. Broker investment values are zero until priced positions
 * arrive with the Phase 4/5 pricing work - sweeps totals are real.
 */
class BrokerGrpcService(
    private val portfolios: PortfolioRepository,
    private val brokers: BrokerRepository,
    private val accounts: AccountRepository,
    private val reporting: ReportingCurrency,
    private val valuation: AccountValuation,
) : BrokerServiceGrpcKt.BrokerServiceCoroutineImplBase() {

    override suspend fun listBrokers(request: ListBrokersRequest): ListBrokersResponse {
        val portfolioId = portfolio()
        val today = LocalDate.now()
        val visibleAccounts = accounts.list(portfolioId, brokerId = null, includeHidden = false)
        val sweepsByBroker = visibleAccounts.groupBy({ it.brokerId }, { it.sweep })
        val values = valuation.byAccount(portfolioId, visibleAccounts, today)
        val holdingsByBroker = visibleAccounts.groupBy({ it.brokerId }, { values[it.id] }).mapValues { (_, v) -> v.filterNotNull() }

        var totalSweeps = reporting.zero()
        var totalHoldings = reporting.zero()
        val builder = ListBrokersResponse.newBuilder()
        for (broker in brokers.list(portfolioId, request.includeHidden)) {
            val sweeps = (sweepsByBroker[broker.id] ?: emptyList())
                .fold(reporting.zero()) { acc, sweep -> acc + reporting.toReporting(sweep, today) }
            val holdings = (holdingsByBroker[broker.id] ?: emptyList())
                .fold(reporting.zero()) { acc, value -> acc + reporting.toReporting(value, today) }
            totalSweeps += sweeps
            totalHoldings += holdings
            builder.addBrokers(
                BrokerSummary.newBuilder()
                    .setBrokerId(broker.id.value)
                    .setName(broker.name)
                    .setHidden(broker.hidden)
                    .setTotalHoldings(holdings.toFormatted())
                    .setSweeps(sweeps.toFormatted())
            )
        }
        return builder
            .setTotalHoldings(totalHoldings.toFormatted())
            .setTotalSweeps(totalSweeps.toFormatted())
            .build()
    }

    override suspend fun createBroker(request: CreateBrokerRequest): CreateBrokerResponse {
        val name = request.name.trim()
        if (name.isEmpty()) {
            throw StatusException(Status.INVALID_ARGUMENT.withDescription("broker name is required"))
        }
        val id = try {
            brokers.create(portfolio(), name)
        } catch (e: SQLException) {
            throw StatusException(
                Status.ALREADY_EXISTS.withDescription("a broker named \"$name\" already exists")
            )
        }
        return CreateBrokerResponse.newBuilder().setBrokerId(id.value).build()
    }

    override suspend fun renameBroker(request: RenameBrokerRequest): RenameBrokerResponse {
        val name = request.name.trim()
        if (name.isEmpty()) {
            throw StatusException(Status.INVALID_ARGUMENT.withDescription("broker name is required"))
        }
        val renamed = try {
            brokers.rename(brokerId(request.brokerId), portfolio(), name)
        } catch (e: SQLException) {
            throw StatusException(
                Status.ALREADY_EXISTS.withDescription("a broker named \"$name\" already exists")
            )
        }
        if (!renamed) throw notFound(request.brokerId)
        return RenameBrokerResponse.getDefaultInstance()
    }

    override suspend fun deleteBroker(request: DeleteBrokerRequest): DeleteBrokerResponse {
        val portfolioId = portfolio()
        val id = brokerId(request.brokerId)
        brokers.find(id, portfolioId) ?: throw notFound(request.brokerId)
        // Guard rail (sec. 5.9): only a broker with no accounts at all.
        if (brokers.hasAccounts(id, visibleOnly = false)) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription("the broker still has accounts")
            )
        }
        brokers.delete(id, portfolioId)
        return DeleteBrokerResponse.getDefaultInstance()
    }

    override suspend fun setBrokerHidden(request: SetBrokerHiddenRequest): SetBrokerHiddenResponse {
        val portfolioId = portfolio()
        val id = brokerId(request.brokerId)
        brokers.find(id, portfolioId) ?: throw notFound(request.brokerId)
        // Guard rail (sec. 5.9): hiding requires no visible accounts.
        if (request.hidden && brokers.hasAccounts(id, visibleOnly = true)) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription("the broker still has visible accounts")
            )
        }
        brokers.setHidden(id, portfolioId, request.hidden)
        return SetBrokerHiddenResponse.getDefaultInstance()
    }

    private fun portfolio(): PortfolioId =
        portfolios.portfolioFor(UserId(currentAuthUser().id))

    private fun brokerId(raw: Long): BrokerId =
        if (raw > 0) BrokerId(raw)
        else throw StatusException(Status.INVALID_ARGUMENT.withDescription("broker id is required"))

    private fun notFound(raw: Long) =
        StatusException(Status.NOT_FOUND.withDescription("no broker $raw"))
}
