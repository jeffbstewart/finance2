package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import java.sql.SQLException
import java.time.LocalDate
import net.stewart.armeria.auth.currentAuthUser
import net.stewart.finance.api.AccountValuation
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.api.provenanceOf
import net.stewart.finance.api.toFormatted
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.AccountRow
import net.stewart.finance.db.BrokerRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.BrokerId
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.EntrySource
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.UserId
import net.stewart.finance.proto.AccountServiceGrpcKt
import net.stewart.finance.proto.AccountSummary
import net.stewart.finance.proto.CreateAccountRequest
import net.stewart.finance.proto.CreateAccountResponse
import net.stewart.finance.proto.DeleteAccountRequest
import net.stewart.finance.proto.DeleteAccountResponse
import net.stewart.finance.proto.GetAccountRequest
import net.stewart.finance.proto.GetAccountResponse
import net.stewart.finance.proto.ListAccountsRequest
import net.stewart.finance.proto.ListAccountsResponse
import net.stewart.finance.proto.SetAccountHiddenRequest
import net.stewart.finance.proto.SetAccountHiddenResponse
import net.stewart.finance.proto.UpdateAccountRequest
import net.stewart.finance.proto.UpdateAccountResponse

/**
 * AccountService (spec sec. 7 "Accounts", sec. 9.3-sec. 9.5) with the sec. 5.9 guard
 * rails. Account currency is fixed at creation (build-scope sec. 5);
 * investment values are zero until priced positions arrive with the
 * Phase 4/5 pricing work.
 */
class AccountGrpcService(
    private val portfolios: PortfolioRepository,
    private val brokers: BrokerRepository,
    private val accounts: AccountRepository,
    private val reporting: ReportingCurrency,
    private val valuation: AccountValuation,
) : AccountServiceGrpcKt.AccountServiceCoroutineImplBase() {

    override suspend fun listAccounts(request: ListAccountsRequest): ListAccountsResponse {
        val portfolioId = portfolio()
        val today = LocalDate.now()
        val brokerFilter = if (request.brokerId > 0) BrokerId(request.brokerId) else null
        val rows = accounts.list(portfolioId, brokerFilter, request.includeHidden)
        val values = valuation.byAccount(portfolioId, rows, today)
        var totalSweeps = reporting.zero()
        var totalInvestment = reporting.zero()
        val builder = ListAccountsResponse.newBuilder()
        for (row in rows) {
            val value = values[row.id] ?: Money.zero(row.currency)
            if (!row.hidden) {
                totalSweeps += reporting.toReporting(row.sweep, today)
                totalInvestment += reporting.toReporting(value, today)
            }
            builder.addAccounts(row.toSummary(value))
        }
        return builder
            .setTotalInvestmentValue(totalInvestment.toFormatted())
            .setTotalSweeps(totalSweeps.toFormatted())
            .build()
    }

    override suspend fun getAccount(request: GetAccountRequest): GetAccountResponse {
        val portfolioId = portfolio()
        val row = accounts.find(accountId(request.accountId), portfolioId)
            ?: throw notFound(request.accountId)
        val value = valuation.byAccount(portfolioId, listOf(row), LocalDate.now())[row.id]
            ?: Money.zero(row.currency)
        return GetAccountResponse.newBuilder().setAccount(row.toSummary(value)).build()
    }

    override suspend fun createAccount(request: CreateAccountRequest): CreateAccountResponse {
        val portfolioId = portfolio()
        val name = request.name.trim()
        val number = request.accountNumber.trim()
        if (name.isEmpty()) throw invalid("account name is required")
        if (number.isEmpty()) throw invalid("account number is required")
        val currency = try {
            CurrencyUnit.parse(request.currencyCode)
        } catch (e: IllegalArgumentException) {
            throw invalid("unknown currency code \"${request.currencyCode}\"")
        }
        val brokerId = BrokerId(request.brokerId.takeIf { it > 0 } ?: throw invalid("broker id is required"))
        brokers.find(brokerId, portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no broker ${request.brokerId}"))
        val id = try {
            accounts.create(brokerId, name, number, currency, request.taxDeferred)
        } catch (e: SQLException) {
            throw StatusException(
                Status.ALREADY_EXISTS.withDescription("an account named \"$name\" already exists at this broker")
            )
        }
        return CreateAccountResponse.newBuilder().setAccountId(id.value).build()
    }

    override suspend fun updateAccount(request: UpdateAccountRequest): UpdateAccountResponse {
        val row = accounts.find(accountId(request.accountId), portfolio())
            ?: throw notFound(request.accountId)
        val name = request.name.trim().ifEmpty { throw invalid("account name is required") }
        val number = request.accountNumber.trim().ifEmpty { throw invalid("account number is required") }
        // The hand-maintained sweep balance (spec sec. 9.4), in the
        // account's currency - provenance flips back to manual.
        val sweep = try {
            Money.of(request.sweepBalance.value.ifEmpty { "0" }, row.currency)
        } catch (e: Exception) {
            throw invalid("sweep balance is not a valid amount: \"${request.sweepBalance.value}\"")
        }
        val updated = try {
            accounts.update(row.id, name, number, request.taxDeferred, sweep, EntrySource.MANUAL, LocalDate.now())
        } catch (e: SQLException) {
            throw StatusException(
                Status.ALREADY_EXISTS.withDescription("an account named \"$name\" already exists at this broker")
            )
        }
        check(updated) { "account ${row.id} vanished mid-update" }
        return UpdateAccountResponse.getDefaultInstance()
    }

    override suspend fun deleteAccount(request: DeleteAccountRequest): DeleteAccountResponse {
        val row = accounts.find(accountId(request.accountId), portfolio())
            ?: throw notFound(request.accountId)
        // Guard rail (sec. 5.9): only an empty account (no lots, no holdings).
        if (!accounts.isEmpty(row.id)) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription("the account still has positions")
            )
        }
        accounts.delete(row.id)
        return DeleteAccountResponse.getDefaultInstance()
    }

    override suspend fun setAccountHidden(request: SetAccountHiddenRequest): SetAccountHiddenResponse {
        val row = accounts.find(accountId(request.accountId), portfolio())
            ?: throw notFound(request.accountId)
        // Guard rail (sec. 5.9): hiding requires zero investment value - 
        // until valuation lands, approximated as "no lots, no holdings"
        // (stricter, never looser).
        if (request.hidden && !accounts.isEmpty(row.id)) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription("the account still has positions")
            )
        }
        accounts.setHidden(row.id, request.hidden)
        return SetAccountHiddenResponse.getDefaultInstance()
    }

    private fun AccountRow.toSummary(investmentValue: Money): AccountSummary = AccountSummary.newBuilder()
        .setAccountId(id.value)
        .setBrokerId(brokerId.value)
        .setBrokerName(brokerName)
        .setName(name)
        .setAccountNumber(accountNumber)
        .setCurrencyCode(currency.code)
        .setTaxDeferred(taxDeferred)
        .setSweepBalance(sweep.toFormatted())
        .setSweepProvenance(provenanceOf(sweepSource, sweepAsOf))
        .setInvestmentValue(investmentValue.toFormatted())
        .setHidden(hidden)
        .build()

    private fun portfolio(): PortfolioId =
        portfolios.portfolioFor(UserId(currentAuthUser().id))

    private fun accountId(raw: Long): AccountId =
        if (raw > 0) AccountId(raw) else throw invalid("account id is required")

    private fun invalid(message: String) =
        StatusException(Status.INVALID_ARGUMENT.withDescription(message))

    private fun notFound(raw: Long) =
        StatusException(Status.NOT_FOUND.withDescription("no account $raw"))
}
