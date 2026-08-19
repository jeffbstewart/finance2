package net.stewart.finance

import io.grpc.Context
import io.grpc.Status
import io.grpc.StatusException
import kotlinx.coroutines.runBlocking
import net.stewart.armeria.auth.GRPC_AUTH_USER_KEY
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.auth.FinanceUser
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.BrokerRepository
import net.stewart.finance.db.FxRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.proto.CreateAccountRequest
import net.stewart.finance.proto.CreateBrokerRequest
import net.stewart.finance.proto.Decimal
import net.stewart.finance.proto.DeleteAccountRequest
import net.stewart.finance.proto.DeleteBrokerRequest
import net.stewart.finance.proto.GetAccountRequest
import net.stewart.finance.proto.ListAccountsRequest
import net.stewart.finance.proto.ListBrokersRequest
import net.stewart.finance.proto.RenameBrokerRequest
import net.stewart.finance.proto.SetAccountHiddenRequest
import net.stewart.finance.proto.SetBrokerHiddenRequest
import net.stewart.finance.proto.UpdateAccountRequest
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BrokerAccountServiceTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    private val users by lazy { FinanceUserRepository(db.dataSource) }
    private val portfolios by lazy { PortfolioRepository(db.dataSource) }
    private val brokerRepo by lazy { BrokerRepository(db.dataSource) }
    private val accountRepo by lazy { AccountRepository(db.dataSource) }
    private val reporting by lazy { ReportingCurrency(FxRepository(db.dataSource)) }
    private val brokerService by lazy { BrokerGrpcService(portfolios, brokerRepo, accountRepo, reporting) }
    private val accountService by lazy { AccountGrpcService(portfolios, brokerRepo, accountRepo, reporting) }

    private fun <T> asUser(user: FinanceUser, block: suspend () -> T): T {
        val ctx = Context.current().withValue(GRPC_AUTH_USER_KEY, user)
        val prev = ctx.attach()
        try {
            return runBlocking { block() }
        } finally {
            ctx.detach(prev)
        }
    }

    private fun statusOf(user: FinanceUser, block: suspend () -> Unit): Status.Code = try {
        asUser(user, block)
        error("expected a StatusException")
    } catch (e: StatusException) {
        e.status.code
    }

    @Test
    fun `broker and account lifecycle with guard rails and totals`() {
        val jeff = users.createUser("jeff", "hash", "Jeff")

        // First authenticated use creates the default portfolio.
        assertEquals(0, asUser(jeff) { brokerService.listBrokers(ListBrokersRequest.getDefaultInstance()) }.brokersCount)
        db.dataSource.connection.use { conn ->
            val rs = conn.createStatement().executeQuery(
                "SELECT p.name FROM portfolios p " +
                    "JOIN portfolio_grants g ON g.portfolio_id = p.id WHERE g.user_id = ${jeff.id}"
            )
            assertTrue(rs.next())
            assertEquals("default", rs.getString(1))
            assertTrue(!rs.next(), "exactly one portfolio for the user")
        }

        // Create a broker; duplicates are ALREADY_EXISTS.
        val brokerId = asUser(jeff) {
            brokerService.createBroker(CreateBrokerRequest.newBuilder().setName("Vanguard").build())
        }.brokerId
        assertEquals(
            Status.Code.ALREADY_EXISTS,
            statusOf(jeff) {
                brokerService.createBroker(CreateBrokerRequest.newBuilder().setName("Vanguard").build())
            },
        )

        // Create a USD account and set its sweep by hand.
        val accountId = asUser(jeff) {
            accountService.createAccount(
                CreateAccountRequest.newBuilder()
                    .setBrokerId(brokerId).setName("Brokerage").setAccountNumber("X-1")
                    .setCurrencyCode("USD").build()
            )
        }.accountId
        asUser(jeff) {
            accountService.updateAccount(
                UpdateAccountRequest.newBuilder()
                    .setAccountId(accountId).setName("Brokerage").setAccountNumber("X-1")
                    .setSweepBalance(Decimal.newBuilder().setValue("1234.56"))
                    .build()
            )
        }
        val account = asUser(jeff) {
            accountService.getAccount(GetAccountRequest.newBuilder().setAccountId(accountId).build())
        }.account
        assertEquals("$1,234.56", account.sweepBalance.display)
        assertEquals("manual", account.sweepProvenance.source)

        // Broker totals reflect the sweep in the reporting currency.
        val listed = asUser(jeff) { brokerService.listBrokers(ListBrokersRequest.getDefaultInstance()) }
        assertEquals("$1,234.56", listed.getBrokers(0).sweeps.display)
        assertEquals("$1,234.56", listed.totalSweeps.display)

        // A EUR account without an FX rate fails loudly, never 1:1.
        asUser(jeff) {
            accountService.createAccount(
                CreateAccountRequest.newBuilder()
                    .setBrokerId(brokerId).setName("Euro").setAccountNumber("X-2")
                    .setCurrencyCode("EUR").build()
            )
        }
        val euroAccount = asUser(jeff) {
            accountService.listAccounts(ListAccountsRequest.getDefaultInstance())
        }.accountsList.single { it.currencyCode == "EUR" }
        asUser(jeff) {
            accountService.updateAccount(
                UpdateAccountRequest.newBuilder()
                    .setAccountId(euroAccount.accountId).setName("Euro").setAccountNumber("X-2")
                    .setSweepBalance(Decimal.newBuilder().setValue("100"))
                    .build()
            )
        }
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf(jeff) { brokerService.listBrokers(ListBrokersRequest.getDefaultInstance()) },
        )
        db.dataSource.connection.use { conn ->
            conn.createStatement().executeUpdate(
                "INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate, source) " +
                    "VALUES ('EUR', 'USD', CURRENT_DATE, 1.10000000, 'test')"
            )
        }
        val converted = asUser(jeff) { brokerService.listBrokers(ListBrokersRequest.getDefaultInstance()) }
        assertEquals("$1,344.56", converted.totalSweeps.display) // 1234.56 + 100×1.10

        // Guard rails: a broker with visible accounts cannot hide; an
        // account with no positions can hide; then the broker can.
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf(jeff) {
                brokerService.setBrokerHidden(
                    SetBrokerHiddenRequest.newBuilder().setBrokerId(brokerId).setHidden(true).build()
                )
            },
        )
        asUser(jeff) {
            accountService.setAccountHidden(
                SetAccountHiddenRequest.newBuilder().setAccountId(accountId).setHidden(true).build()
            )
            accountService.setAccountHidden(
                SetAccountHiddenRequest.newBuilder().setAccountId(euroAccount.accountId).setHidden(true).build()
            )
            brokerService.setBrokerHidden(
                SetBrokerHiddenRequest.newBuilder().setBrokerId(brokerId).setHidden(true).build()
            )
        }
        // Hidden items disappear from the default listing but return
        // with include_hidden (fixes legacy defect 6).
        assertEquals(0, asUser(jeff) { brokerService.listBrokers(ListBrokersRequest.getDefaultInstance()) }.brokersCount)
        assertEquals(
            1,
            asUser(jeff) {
                brokerService.listBrokers(ListBrokersRequest.newBuilder().setIncludeHidden(true).build())
            }.brokersCount,
        )
        asUser(jeff) {
            brokerService.setBrokerHidden(
                SetBrokerHiddenRequest.newBuilder().setBrokerId(brokerId).setHidden(false).build()
            )
        }

        // Deleting a broker with accounts is refused; after deleting
        // both accounts it works.
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf(jeff) {
                brokerService.deleteBroker(DeleteBrokerRequest.newBuilder().setBrokerId(brokerId).build())
            },
        )
        asUser(jeff) {
            accountService.deleteAccount(DeleteAccountRequest.newBuilder().setAccountId(accountId).build())
            accountService.deleteAccount(
                DeleteAccountRequest.newBuilder().setAccountId(euroAccount.accountId).build()
            )
            brokerService.renameBroker(
                RenameBrokerRequest.newBuilder().setBrokerId(brokerId).setName("Vanguard Group").build()
            )
            brokerService.deleteBroker(DeleteBrokerRequest.newBuilder().setBrokerId(brokerId).build())
        }
        assertEquals(0, asUser(jeff) { brokerService.listBrokers(ListBrokersRequest.getDefaultInstance()) }.brokersCount)
    }

    @Test
    fun `portfolios are isolated per user`() {
        val alice = users.createUser("alice", "hash", "Alice")
        val bob = users.createUser("bob", "hash", "Bob")
        asUser(alice) {
            brokerService.createBroker(CreateBrokerRequest.newBuilder().setName("Alice's Broker").build())
        }
        assertEquals(0, asUser(bob) { brokerService.listBrokers(ListBrokersRequest.getDefaultInstance()) }.brokersCount)
        // Bob cannot touch Alice's broker: scoped lookups treat it as
        // nonexistent.
        val aliceBroker = asUser(alice) {
            brokerService.listBrokers(ListBrokersRequest.getDefaultInstance())
        }.getBrokers(0).brokerId
        assertEquals(
            Status.Code.NOT_FOUND,
            statusOf(bob) {
                brokerService.deleteBroker(DeleteBrokerRequest.newBuilder().setBrokerId(aliceBroker).build())
            },
        )
    }
}
