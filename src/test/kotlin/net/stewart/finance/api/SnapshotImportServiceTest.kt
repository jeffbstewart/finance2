package net.stewart.finance.api

import io.grpc.Status
import io.grpc.StatusException
import java.time.LocalDate
import net.stewart.bankferry.proto.Account as PlaidAccount
import net.stewart.bankferry.proto.Date as PlaidDate
import net.stewart.bankferry.proto.Decimal as PlaidDecimal
import net.stewart.bankferry.proto.Holding
import net.stewart.bankferry.proto.InvestmentsSnapshot
import net.stewart.bankferry.proto.ItemSnapshot
import net.stewart.bankferry.proto.Money as PlaidMoney
import net.stewart.bankferry.proto.SecurityRef
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.PlaidAccountLinkRepository
import net.stewart.finance.db.PlaidSecurityLinkRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.SnapshotRepository
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.EntrySource
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.SnapshotStatus
import net.stewart.finance.proto.ReportSeverity
import net.stewart.finance.proto.ImportReport
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class SnapshotImportServiceTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    private val portfolioId = PortfolioId(1)
    private val service
        get() = SnapshotImportService(
            SnapshotRepository(db.dataSource),
            PlaidAccountLinkRepository(db.dataSource),
            AccountRepository(db.dataSource),
            SecurityRepository(db.dataSource),
            HoldingRepository(db.dataSource),
            LotRepository(db.dataSource),
            SaleRepository(db.dataSource),
            PlaidSecurityLinkRepository(db.dataSource),
            PrivatePriceRepository(db.dataSource),
        )

    @BeforeEach
    fun fixture() {
        val statements = listOf(
            "DELETE FROM snapshot_uploads",
            "DELETE FROM plaid_account_links",
            "DELETE FROM plaid_security_links",
            "DELETE FROM private_prices",
            "DELETE FROM holdings",
            "DELETE FROM sale_allocations",
            "DELETE FROM sales",
            "DELETE FROM purchase_lots",
            "DELETE FROM securities",
            "DELETE FROM accounts",
            "DELETE FROM brokers",
            "DELETE FROM portfolios",
            "INSERT INTO portfolios (id, name) VALUES (1, 'test')",
            "INSERT INTO brokers (id, portfolio_id, name) VALUES (1, 1, 'Vanguard')",
            "INSERT INTO accounts (id, broker_id, name, account_number, currency, tax_deferred) " +
                "VALUES (1, 1, 'IRA', 'X-1', 'USD', TRUE)",
            "INSERT INTO accounts (id, broker_id, name, account_number, currency, tax_deferred) " +
                "VALUES (2, 1, 'Brokerage', 'X-2', 'USD', FALSE)",
            "INSERT INTO securities (id, portfolio_id, ticker, currency) VALUES (1, 1, 'VTI', 'USD')",
            // A 401(k) trust-class fund: no public ticker, priced by hand.
            "INSERT INTO securities (id, portfolio_id, ticker, currency, pricing_locus) " +
                "VALUES (2, 1, 'VBTIX-TR', 'USD', 'MANUAL')",
            // Taxable Brokerage holds a 10-share VTI lot by hand.
            "INSERT INTO purchase_lots (account_id, security_id, date_bought, quantity, price_per_share, purchase_costs) " +
                "VALUES (2, 1, DATE '2026-01-05', 10, 200.0000, 0)",
            // Explicit-id fixtures leave the identity counters behind;
            // restart them so repository create() calls don't collide.
            "ALTER TABLE accounts ALTER COLUMN id RESTART WITH 100",
            "ALTER TABLE securities ALTER COLUMN id RESTART WITH 100",
            "ALTER TABLE brokers ALTER COLUMN id RESTART WITH 100",
        )
        db.dataSource.connection.use { conn ->
            conn.createStatement().use { s -> statements.forEach { s.executeUpdate(it) } }
        }
    }

    private fun decimal(v: String): PlaidDecimal = PlaidDecimal.newBuilder().setValue(v).build()
    private fun money(v: String, currency: String = "USD"): PlaidMoney =
        PlaidMoney.newBuilder().setAmount(decimal(v)).setCurrencyCode(currency).build()

    private fun security(ticker: String, cash: Boolean = false): SecurityRef =
        SecurityRef.newBuilder().setTicker(ticker).setCurrencyCode("USD")
            .setName("$ticker fund").setIsCashEquivalent(cash).build()

    private fun holding(ticker: String, quantity: String, cash: Boolean = false, value: String = "0"): Holding =
        Holding.newBuilder()
            .setSecurity(security(ticker, cash))
            .setQuantity(decimal(quantity))
            .setInstitutionValue(money(value))
            .build()

    /** A trust-class holding the way Plaid reports it: no ticker, a
     *  stable security id, institution price and value. */
    private fun trustHolding(quantity: String, price: String, value: String): Holding =
        Holding.newBuilder()
            .setSecurity(
                SecurityRef.newBuilder().setPlaidSecurityId("plaid-sec-trust")
                    .setName("Inst Tot Bd Mkt Ix Tr").setType("mutual fund").setCurrencyCode("USD")
            )
            .setQuantity(decimal(quantity))
            .setInstitutionPrice(money(price))
            .setPriceAsOf(PlaidDate.newBuilder().setYear(2026).setMonth(8).setDay(14))
            .setInstitutionValue(money(value))
            .build()

    /** A 401(k) as Plaid reports it: available balance = the whole account. */
    private fun account401k(vararg holdings: Holding, total: String, available: String? = total): PlaidAccount {
        val builder = PlaidAccount.newBuilder()
            .setAccountRef("ref-401k").setName("401(k)").setMask("4401")
            .setType("investment").setSubtype("401k")
            .setInstitutionValue(money(total))
            .addAllHoldings(holdings.toList())
        available?.let { builder.setCashBalance(money(it)) }
        return builder.build()
    }

    private fun snapshot(vararg accounts: PlaidAccount): InvestmentsSnapshot =
        InvestmentsSnapshot.newBuilder()
            .setSchemaVersion(1)
            .setAsOf(PlaidDate.newBuilder().setYear(2026).setMonth(8).setDay(15))
            .addItems(
                ItemSnapshot.newBuilder()
                    .setInstitutionEntry("Vanguard")
                    .setItemRef("item-1")
                    .addAllAccounts(accounts.toList())
            )
            .build()

    private fun iraAccount(vararg holdings: Holding): PlaidAccount =
        PlaidAccount.newBuilder()
            .setAccountRef("ref-ira").setName("Roth IRA").setMask("1234")
            .setType("investment").setSubtype("roth")
            .setCashBalance(money("55.25"))
            .addAllHoldings(holdings.toList())
            .build()

    private fun brokerageAccount(vararg holdings: Holding): PlaidAccount =
        PlaidAccount.newBuilder()
            .setAccountRef("ref-brok").setName("Brokerage").setMask("9876")
            .setType("investment").setSubtype("brokerage")
            .addAllHoldings(holdings.toList())
            .build()

    private fun lines(report: ImportReport): List<String> = report.linesList.map { it.message }

    @Test
    fun `upload validates schema version and shape, then archives verbatim`() {
        assertFailsWith<StatusException> { service.upload(portfolioId, "x.pb", ByteArray(0)) }
        assertFailsWith<StatusException> {
            service.upload(portfolioId, "x.pb", "not a proto".toByteArray())
        }.also { assertEquals(Status.Code.INVALID_ARGUMENT, it.status.code) }
        val futureSchema = snapshot(iraAccount()).toBuilder().setSchemaVersion(2).build()
        assertFailsWith<StatusException> {
            service.upload(portfolioId, "x.pb", futureSchema.toByteArray())
        }.also { assertTrue("schema v2" in (it.status.description ?: "")) }

        val bytes = snapshot(iraAccount(holding("VTI", "12"))).toByteArray()
        val record = service.upload(portfolioId, "vanguard-aug.pb", bytes)
        assertEquals(SnapshotStatus.UPLOADED, record.status)
        assertEquals(LocalDate.of(2026, 8, 15), record.asOf)
        // Verbatim archive: the stored bytes are exactly the upload.
        assertTrue(
            SnapshotRepository(db.dataSource).content(record.id, portfolioId)!!
                .contentEquals(bytes)
        )
        // Upload mutates nothing.
        assertTrue(HoldingRepository(db.dataSource).list(portfolioId).isEmpty())
    }

    @Test
    fun `unlinked accounts warn and import nothing`() {
        val record = service.upload(
            portfolioId, "s.pb", snapshot(iraAccount(holding("VTI", "12"))).toByteArray()
        )
        val processed = service.process(portfolioId, record.id)
        assertEquals(SnapshotStatus.PROCESSED, processed.status)
        val report = ImportReport.parseFrom(processed.report!!)
        assertTrue(lines(report).any { "not linked" in it })
        assertEquals(0, report.holdingsUpdated)
        assertTrue(HoldingRepository(db.dataSource).list(portfolioId).isEmpty())
    }

    @Test
    fun `linked tax-deferred accounts get holdings and sweep with plaid provenance`() {
        PlaidAccountLinkRepository(db.dataSource).link("ref-ira", AccountId(1))
        val record = service.upload(
            portfolioId, "s.pb",
            snapshot(
                iraAccount(
                    holding("VTI", "12.5"),
                    holding("VMFXX", "55.25", cash = true, value = "55.25"),
                    holding("MYSTERY", "3"),
                )
            ).toByteArray(),
        )
        val processed = service.process(portfolioId, record.id)
        val report = ImportReport.parseFrom(processed.report!!)

        assertEquals(1, report.holdingsUpdated)
        assertEquals(1, report.sweepsUpdated)
        assertTrue(lines(report).any { "MYSTERY is not a known security" in it })

        val holdingRow = HoldingRepository(db.dataSource).list(portfolioId).single()
        assertEquals(SecurityId(1), holdingRow.securityId)
        assertEquals(Quantity.of("12.5"), holdingRow.quantity)
        assertEquals(EntrySource.PLAID, holdingRow.source)
        assertEquals(LocalDate.of(2026, 8, 15), holdingRow.asOf)

        val account = AccountRepository(db.dataSource).find(AccountId(1), portfolioId)!!
        assertEquals(Money.of("55.25", CurrencyUnit.USD).amount, account.sweep.amount)
        assertEquals(EntrySource.PLAID, account.sweepSource)
    }

    @Test
    fun `taxable accounts compare and never mutate, and re-processing reflects lot fixes`() {
        PlaidAccountLinkRepository(db.dataSource).link("ref-brok", AccountId(2))
        // Institution says 12; lots hold 10 - mismatch warning.
        val record = service.upload(
            portfolioId, "s.pb", snapshot(brokerageAccount(holding("VTI", "12"))).toByteArray()
        )
        val first = ImportReport.parseFrom(service.process(portfolioId, record.id).report!!)
        assertTrue(lines(first).any { "institution reports 12" in it && "lots hold 10" in it })
        assertEquals(0, first.holdingsUpdated)
        // No lot was touched.
        assertEquals(1, LotRepository(db.dataSource).list(portfolioId).size)

        // The human records the missing 2-share lot, then revisits the
        // same archived snapshot (ruling 2026-08-20).
        LotRepository(db.dataSource).create(
            AccountId(2), SecurityId(1), LocalDate.of(2026, 7, 1),
            Quantity.of("2"), Money.of("210.00", CurrencyUnit.USD), Money.zero(CurrencyUnit.USD),
        )
        val second = ImportReport.parseFrom(service.process(portfolioId, record.id).report!!)
        assertTrue(lines(second).none { "institution reports" in it })
        assertTrue(lines(second).any { "1 position(s) match" in it })
    }

    @Test
    fun `an account that does not exist at upload time can be created, linked, and re-processed`() {
        // The snapshot mentions a 401(k) finance2 has never seen.
        val plaid401k = PlaidAccount.newBuilder()
            .setAccountRef("ref-401k").setName("My 401(k)").setMask("5555")
            .setType("investment").setSubtype("401k")
            .addHoldings(holding("VTI", "40"))
            .build()
        val record = service.upload(portfolioId, "s.pb", snapshot(plaid401k).toByteArray())

        // First pass: nothing to link to - a warning, no writes, and
        // the run still completes as PROCESSED.
        val first = service.process(portfolioId, record.id)
        assertEquals(SnapshotStatus.PROCESSED, first.status)
        assertTrue(lines(ImportReport.parseFrom(first.report!!)).any { "not linked" in it })
        assertTrue(HoldingRepository(db.dataSource).list(portfolioId).isEmpty())

        // The human creates the local account, links it, and revisits
        // the same archived snapshot (ruling 2026-08-20).
        val created = AccountRepository(db.dataSource).create(
            net.stewart.finance.domain.BrokerId(1), "401k", "X-3", CurrencyUnit.USD, taxDeferred = true,
        )
        PlaidAccountLinkRepository(db.dataSource).link("ref-401k", created)
        val second = service.process(portfolioId, record.id)
        val report = ImportReport.parseFrom(second.report!!)
        assertEquals(1, report.holdingsUpdated)
        val imported = HoldingRepository(db.dataSource).list(portfolioId).single()
        assertEquals(created, imported.accountId)
        assertEquals(Quantity.of("40"), imported.quantity)
    }

    @Test
    fun `vanished tax-deferred holdings are flagged, not deleted`() {
        PlaidAccountLinkRepository(db.dataSource).link("ref-ira", AccountId(1))
        HoldingRepository(db.dataSource).upsert(
            AccountId(1), SecurityId(1), Quantity.of("7"), EntrySource.MANUAL, LocalDate.of(2026, 1, 1),
        )
        val record = service.upload(portfolioId, "s.pb", snapshot(iraAccount()).toByteArray())
        val report = ImportReport.parseFrom(service.process(portfolioId, record.id).report!!)
        assertTrue(lines(report).any { "absent from the snapshot" in it })
        // Still there - the human decides.
        assertEquals(1, HoldingRepository(db.dataSource).list(portfolioId).size)
    }

    @Test
    fun `snapshot accounts list link state for the import screen`() {
        PlaidAccountLinkRepository(db.dataSource).link("ref-ira", AccountId(1))
        val record = service.upload(
            portfolioId, "s.pb",
            snapshot(iraAccount(holding("VTI", "1")), brokerageAccount()).toByteArray(),
        )
        val accounts = service.snapshotAccounts(portfolioId, record.id)
        assertEquals(2, accounts.size)
        val (_, ira, iraLink) = accounts.single { it.second.accountRef == "ref-ira" }
        assertEquals("Roth IRA", ira.name)
        assertEquals("IRA", iraLink?.name)
        val (_, _, brokLink) = accounts.single { it.second.accountRef == "ref-brok" }
        assertEquals(null, brokLink)
    }

    @Test
    fun `report lines carry the account they concern, unlinked ones none`() {
        PlaidAccountLinkRepository(db.dataSource).link("ref-ira", AccountId(1))
        val record = service.upload(
            portfolioId, "s.pb",
            snapshot(iraAccount(holding("MYSTERY", "3")), brokerageAccount(holding("VTI", "1"))).toByteArray(),
        )
        val report = ImportReport.parseFrom(service.process(portfolioId, record.id).report!!)
        val mystery = report.linesList.single { "MYSTERY" in it.message }
        assertEquals(1L, mystery.accountId)
        val unlinked = report.linesList.single { "not linked" in it.message }
        assertEquals(0L, unlinked.accountId)
    }

    @Test
    fun `latest warnings follow the most recent processing run and skip unattributed lines`() {
        assertTrue(service.latestWarnings(portfolioId).isEmpty())
        PlaidAccountLinkRepository(db.dataSource).link("ref-ira", AccountId(1))
        PlaidAccountLinkRepository(db.dataSource).link("ref-brok", AccountId(2))
        val first = service.upload(
            portfolioId, "first.pb",
            snapshot(iraAccount(holding("MYSTERY", "3")), brokerageAccount(holding("VTI", "12"))).toByteArray(),
        )
        // Uploaded but unprocessed: still nothing to show.
        assertTrue(service.latestWarnings(portfolioId).isEmpty())
        service.process(portfolioId, first.id)

        val warnings = service.latestWarnings(portfolioId)
        assertEquals(listOf(AccountId(1), AccountId(2)), warnings.map { it.account.id })
        assertEquals(LocalDate.of(2026, 8, 15), warnings[0].asOf)
        assertTrue("MYSTERY" in warnings[0].message)
        assertTrue("institution reports 12" in warnings[1].message)
        // Info lines and the unlinked Plaid account never surface here.
        assertTrue(warnings.none { "holding(s) updated" in it.message || "not linked" in it.message })

        // A newer snapshot with a clean IRA and an unlinked brokerage:
        // only its warnings count, and the unlinked one has no account.
        val second = service.upload(
            portfolioId, "second.pb",
            snapshot(
                iraAccount(holding("VTI", "1")),
                brokerageAccount(holding("VTI", "12")).toBuilder().setAccountRef("ref-other").build(),
            ).toByteArray(),
        )
        service.process(portfolioId, second.id)
        assertTrue(service.latestWarnings(portfolioId).isEmpty())

        // Re-running the older snapshot makes it the latest run again
        // (ordered by processed_at; the pause keeps the two runs apart).
        Thread.sleep(5)
        service.process(portfolioId, first.id)
        val rerun = service.latestWarnings(portfolioId)
        assertTrue(rerun.all { it.snapshotId == first.id })
        // The original two, plus: the second run imported VTI into the
        // IRA and the first snapshot does not carry it.
        assertEquals(3, rerun.size)
        assertTrue(rerun.any { it.account.id == AccountId(1) && "absent from the snapshot" in it.message })
    }

    @Test
    fun `no-ticker holdings warn until linked, then import with the institution price recorded`() {
        PlaidAccountLinkRepository(db.dataSource).link("ref-401k", AccountId(1))
        val record = service.upload(
            portfolioId, "s.pb",
            snapshot(account401k(trustHolding("100.5", "11.2500", "1130.63"), total = "1130.63")).toByteArray(),
        )
        val first = ImportReport.parseFrom(service.process(portfolioId, record.id).report!!)
        val unmatched = first.linesList.single { "has no ticker" in it.message }
        assertTrue("link it to a finance2 security on the Import screen" in unmatched.message)
        assertEquals(1L, unmatched.accountId)
        assertEquals(0, first.holdingsUpdated)
        assertEquals(0, first.pricesRecorded)
        assertTrue(PrivatePriceRepository(db.dataSource).list(SecurityId(2)).isEmpty())

        // The human links the Plaid security to the hand-priced fund.
        PlaidSecurityLinkRepository(db.dataSource).link("plaid-sec-trust", SecurityId(2))
        val second = ImportReport.parseFrom(service.process(portfolioId, record.id).report!!)
        assertTrue(lines(second).none { "has no ticker" in it })
        assertEquals(1, second.holdingsUpdated)
        assertEquals(1, second.pricesRecorded)
        val holdingRow = HoldingRepository(db.dataSource).list(portfolioId).single()
        assertEquals(SecurityId(2), holdingRow.securityId)
        assertEquals(Quantity.of("100.5"), holdingRow.quantity)
        // Institution price lands as a private price on Plaid's price date.
        val price = PrivatePriceRepository(db.dataSource).list(SecurityId(2)).single()
        assertEquals(LocalDate.of(2026, 8, 14), price.date)
        assertEquals(0, Money.of("11.25", CurrencyUnit.USD).amount.compareTo(price.price.amount))
        // Re-processing replaces rather than duplicates the price.
        service.process(portfolioId, record.id)
        assertEquals(1, PrivatePriceRepository(db.dataSource).list(SecurityId(2)).size)
    }

    @Test
    fun `a 401k whose available balance is the whole account does not become sweep`() {
        PlaidAccountLinkRepository(db.dataSource).link("ref-401k", AccountId(1))
        PlaidSecurityLinkRepository(db.dataSource).link("plaid-sec-trust", SecurityId(2))
        val record = service.upload(
            portfolioId, "s.pb",
            snapshot(
                account401k(
                    trustHolding("100", "10.00", "1000.00"),
                    holding("VTI", "2", value = "500.00"),
                    total = "1500.00",
                )
            ).toByteArray(),
        )
        val report = ImportReport.parseFrom(service.process(portfolioId, record.id).report!!)
        // Sweep is the account value less its valued holdings: zero.
        val account = AccountRepository(db.dataSource).find(AccountId(1), portfolioId)!!
        assertEquals(0, account.sweep.amount.signum())
        assertEquals(EntrySource.PLAID, account.sweepSource)
        assertTrue(lines(report).any { "sweep derived as account value" in it })
        assertEquals(2, report.holdingsUpdated)
    }

    @Test
    fun `a plausible cash balance is still believed, and an unvalued holding blocks derivation`() {
        PlaidAccountLinkRepository(db.dataSource).link("ref-401k", AccountId(1))
        // Cash below the account value: that is cash.
        val plausible = service.upload(
            portfolioId, "a.pb",
            snapshot(account401k(holding("VTI", "2", value = "500.00"), total = "600.00", available = "100.00"))
                .toByteArray(),
        )
        service.process(portfolioId, plausible.id)
        assertEquals(
            0,
            Money.of("100.00", CurrencyUnit.USD).amount
                .compareTo(AccountRepository(db.dataSource).find(AccountId(1), portfolioId)!!.sweep.amount),
        )
        // Whole-account "cash" with a holding Plaid did not value: no
        // derivation possible - leave the sweep alone and say so.
        val unvalued = service.upload(
            portfolioId, "b.pb",
            snapshot(
                account401k(holding("VTI", "2").toBuilder().clearInstitutionValue().build(), total = "600.00")
            ).toByteArray(),
        )
        val report = ImportReport.parseFrom(service.process(portfolioId, unvalued.id).report!!)
        assertEquals(0, report.sweepsUpdated)
        assertTrue(lines(report).any { "sweep left unchanged" in it })
        assertEquals(
            0,
            Money.of("100.00", CurrencyUnit.USD).amount
                .compareTo(AccountRepository(db.dataSource).find(AccountId(1), portfolioId)!!.sweep.amount),
        )
    }

    @Test
    fun `a reported CUSIP matches a security that carries it, without a link`() {
        db.dataSource.connection.use { conn ->
            conn.createStatement().use { s -> s.executeUpdate("UPDATE securities SET cusip = '922908769' WHERE id = 2") }
        }
        PlaidAccountLinkRepository(db.dataSource).link("ref-401k", AccountId(1))
        val withCusip = trustHolding("10", "10.00", "100.00").toBuilder().apply {
            securityBuilder.setCusip("922908769")
        }.build()
        val record = service.upload(portfolioId, "s.pb", snapshot(account401k(withCusip, total = "100.00")).toByteArray())
        val rows = service.snapshotSecurities(portfolioId, record.id)
        assertEquals(SecurityMatch.BY_CUSIP, rows.single().match)
        assertEquals("VBTIX-TR", rows.single().security?.ticker)
        val report = ImportReport.parseFrom(service.process(portfolioId, record.id).report!!)
        assertEquals(1, report.holdingsUpdated)
    }

    @Test
    fun `snapshot securities list each distinct non-cash security with its match`() {
        PlaidSecurityLinkRepository(db.dataSource).link("plaid-sec-trust", SecurityId(2))
        val record = service.upload(
            portfolioId, "s.pb",
            snapshot(
                iraAccount(holding("VTI", "1"), holding("VMFXX", "5", cash = true), holding("MYSTERY", "1")),
                account401k(trustHolding("100", "10.00", "1000.00"), holding("VTI", "2"), total = "1020.00"),
            ).toByteArray(),
        )
        val rows = service.snapshotSecurities(portfolioId, record.id)
        assertEquals(listOf("VTI", "MYSTERY", ""), rows.map { it.ref.ticker })
        val vti = rows[0]
        assertEquals(SecurityMatch.BY_TICKER, vti.match)
        assertEquals(2, vti.accountCount)
        assertEquals(SecurityMatch.UNMATCHED, rows[1].match)
        assertEquals(null, rows[1].security)
        val trust = rows[2]
        assertEquals(SecurityMatch.BY_LINK, trust.match)
        assertEquals("VBTIX-TR", trust.security?.ticker)
        assertEquals("Inst Tot Bd Mkt Ix Tr", trust.ref.name)
    }

    @Test
    fun `severity levels distinguish info from warnings`() {
        PlaidAccountLinkRepository(db.dataSource).link("ref-ira", AccountId(1))
        val record = service.upload(
            portfolioId, "s.pb", snapshot(iraAccount(holding("VTI", "12.5"))).toByteArray()
        )
        val report = ImportReport.parseFrom(service.process(portfolioId, record.id).report!!)
        assertTrue(report.linesList.any { it.severity == ReportSeverity.INFO })
        assertTrue(report.linesList.none { it.severity == ReportSeverity.WARNING })
    }
}
