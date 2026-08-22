package net.stewart.finance.testsupport

import java.math.BigDecimal
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.bankferry.proto.InvestmentsSnapshot
import net.stewart.finance.api.MtmService
import net.stewart.finance.api.ReportingCurrency
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.BrokerRepository
import net.stewart.finance.db.ClassificationRepository
import net.stewart.finance.db.FxRepository
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.MarketPriceRepository
import net.stewart.finance.db.MtmMarkRepository
import net.stewart.finance.db.PlaidAccountLinkRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.SnapshotRepository
import net.stewart.finance.db.TargetAllocationRepository
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.EntrySource
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.MarketSource
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.RateSource
import net.stewart.finance.domain.SecurityType
import net.stewart.finance.domain.TaxTreatment
import net.stewart.finance.feeds.DailyBar

/**
 * The canonical sample portfolio for UI test harnesses
 * (docs/design/ui-testing.md). Every date is computed relative to the
 * clock so date-sensitive screens find data where they look: the tax
 * report's previous-calendar-year default sees a sale, sparklines see
 * six months of prices, and the MTM ledger's default year follows its
 * last mark. Seeding goes through the same repositories and services
 * production uses - invariants hold by construction.
 */
class SampleSeeder(private val dataSource: DataSource) {

    private val brokers = BrokerRepository(dataSource)
    private val accounts = AccountRepository(dataSource)
    private val securities = SecurityRepository(dataSource)
    private val classifications = ClassificationRepository(dataSource)
    private val privatePrices = PrivatePriceRepository(dataSource)
    private val marketPrices = MarketPriceRepository(dataSource)
    private val lots = LotRepository(dataSource)
    private val sales = SaleRepository(dataSource)
    private val holdings = HoldingRepository(dataSource)
    private val targets = TargetAllocationRepository(dataSource)
    private val fx = FxRepository(dataSource)
    private val marks = MtmMarkRepository(dataSource)
    private val snapshots = SnapshotRepository(dataSource)
    private val links = PlaidAccountLinkRepository(dataSource)
    private val mtm = MtmService(
        lots, sales, marks, fx, ReportingCurrency(fx),
        // The seeder records marks with explicit figures - no price
        // history needed.
        history = { emptyList() },
    )

    /** Domain tables only; users, sessions, FX, and CPI survive. */
    fun reset() {
        val order = listOf(
            "mtm_marks", "sale_allocations", "sales", "purchase_lots", "holdings",
            "snapshot_uploads", "plaid_account_links", "security_classifications",
            "target_allocations", "private_prices", "market_prices",
            "securities", "accounts", "brokers",
        )
        dataSource.connection.use { conn ->
            conn.createStatement().use { statement ->
                order.forEach { statement.executeUpdate("DELETE FROM $it") }
            }
        }
    }

    fun seed(portfolioId: PortfolioId): Map<String, Long> {
        val ids = linkedMapOf<String, Long>()
        val today = LocalDate.now()
        val lastYear = today.year - 1

        // FX (MANUAL rows; MERGE keeps re-seeding idempotent). The
        // EUFUND story needs purchase-date and both year-end rates,
        // plus a recent rate for current-value conversions.
        val eufundBought = LocalDate.of(lastYear - 2, 3, 1)
        fx.upsert(CurrencyUnit.EUR, CurrencyUnit.USD, eufundBought, BigDecimal("1.10000000"), RateSource.MANUAL)
        fx.upsert(CurrencyUnit.EUR, CurrencyUnit.USD, LocalDate.of(lastYear - 1, 12, 31), BigDecimal("1.05000000"), RateSource.MANUAL)
        fx.upsert(CurrencyUnit.EUR, CurrencyUnit.USD, LocalDate.of(lastYear, 12, 31), BigDecimal("1.08000000"), RateSource.MANUAL)
        fx.upsert(CurrencyUnit.EUR, CurrencyUnit.USD, today.minusDays(1), BigDecimal("1.16000000"), RateSource.MANUAL)

        // Brokers: two visible, one hidden (show-hidden toggles).
        val vanguard = brokers.create(portfolioId, "Vanguard")
        val euroBank = brokers.create(portfolioId, "EuroBank")
        val oldBroker = brokers.create(portfolioId, "Old Broker")
        brokers.setHidden(oldBroker, portfolioId, true)
        ids["broker.vanguard"] = vanguard.value
        ids["broker.eurobank"] = euroBank.value
        ids["broker.old"] = oldBroker.value

        // Accounts: USD taxable, USD tax-deferred, EUR taxable, and a
        // hidden empty one.
        val brokerage = accounts.create(vanguard, "Brokerage", "X-1", CurrencyUnit.USD, taxDeferred = false)
        val roth = accounts.create(vanguard, "Roth IRA", "X-2", CurrencyUnit.USD, taxDeferred = true)
        val eur = accounts.create(euroBank, "EUR Brokerage", "X-3", CurrencyUnit.EUR, taxDeferred = false)
        val closed = accounts.create(vanguard, "Closed Account", "X-4", CurrencyUnit.USD, taxDeferred = false)
        accounts.setHidden(closed, true)
        accounts.updateSweep(brokerage, Money.of("500.0000", CurrencyUnit.USD), EntrySource.MANUAL, today)
        accounts.updateSweep(eur, Money.of("250.0000", CurrencyUnit.EUR), EntrySource.MANUAL, today)
        accounts.updateSweep(roth, Money.of("55.2500", CurrencyUnit.USD), EntrySource.PLAID, today.minusDays(3))
        ids["account.brokerage"] = brokerage.value
        ids["account.roth"] = roth.value
        ids["account.eur"] = eur.value
        ids["account.closed"] = closed.value

        // Securities. VTI: MARKET locus with pinned synthetic bars - 
        // fetched_at is now, so MarketData treats it fresh and no
        // provider is ever contacted.
        val vti = securities.create(portfolioId, "VTI", CurrencyUnit.USD)
        securities.updateProfile(
            vti, "Total Market ETF", SecurityType.ETF, PricingLocus.MARKET,
            TaxTreatment.LOTS, Fraction.of("0.0003"),
        )
        marketPrices.upsertBars(
            vti,
            (0 until 220).map { i ->
                val date = today.minusDays((219 - i).toLong())
                // Gentle deterministic uptrend: 180.00 -> 201.90.
                val close = BigDecimal("180.00").add(BigDecimal("0.10").multiply(BigDecimal(i)))
                DailyBar(
                    date = date, open = close, high = close, low = close,
                    close = close, adjustedClose = close,
                    dividend = BigDecimal.ZERO, splitCoefficient = BigDecimal.ONE,
                    volume = 1000L,
                )
            },
            MarketSource.TIINGO,
        )
        classifications.replace(vti, net.stewart.finance.domain.ClassificationKind.ASSET_CLASS, mapOf("US Stock" to Fraction.ONE), today.minusDays(30))

        val bondx = securities.create(portfolioId, "BONDX", CurrencyUnit.USD)
        securities.updateProfile(
            bondx, "Aggregate Bond Fund", SecurityType.MUTUAL_FUND, PricingLocus.MANUAL,
            TaxTreatment.LOTS, Fraction.of("0.0005"),
        )
        privatePrices.add(bondx, today.minusDays(120), Money.of("10.0000", CurrencyUnit.USD))
        privatePrices.add(bondx, today.minusDays(2), Money.of("10.5000", CurrencyUnit.USD))
        classifications.replace(bondx, net.stewart.finance.domain.ClassificationKind.ASSET_CLASS, mapOf("Bond" to Fraction.ONE), today.minusDays(30))

        val gold = securities.create(portfolioId, "GOLD", CurrencyUnit.USD)
        securities.updateProfile(
            gold, "Gold coins in a vault", SecurityType.PRIVATE, PricingLocus.MANUAL,
            TaxTreatment.LOTS, null,
        )
        privatePrices.add(gold, today.minusDays(90), Money.of("3100.0000", CurrencyUnit.USD))
        privatePrices.add(gold, today.minusDays(5), Money.of("3358.5000", CurrencyUnit.USD))
        classifications.replace(gold, net.stewart.finance.domain.ClassificationKind.ASSET_CLASS, mapOf("Other" to Fraction.ONE), today.minusDays(400))

        val eufund = securities.create(portfolioId, "EUFUND", CurrencyUnit.EUR)
        securities.updateProfile(
            eufund, "European Index Fund", SecurityType.MUTUAL_FUND, PricingLocus.MANUAL,
            TaxTreatment.MARK_TO_MARKET, Fraction.of("0.0012"),
        )
        privatePrices.add(eufund, LocalDate.of(lastYear - 1, 12, 30), Money.of("95.0000", CurrencyUnit.EUR))
        privatePrices.add(eufund, LocalDate.of(lastYear, 12, 30), Money.of("100.0000", CurrencyUnit.EUR))
        privatePrices.add(eufund, today.minusDays(7), Money.of("104.0000", CurrencyUnit.EUR))
        classifications.replace(eufund, net.stewart.finance.domain.ClassificationKind.ASSET_CLASS, mapOf("Non US Stock" to Fraction.ONE), today.minusDays(30))

        // SOLO: priced, visible, never held - the empty-lot-ledger state
        // (lot details, hide-security) and the single-close sparkline.
        val solo = securities.create(portfolioId, "SOLO", CurrencyUnit.USD)
        securities.updateProfile(solo, "Priced, never held", SecurityType.STOCK, PricingLocus.MANUAL, TaxTreatment.LOTS, null)
        privatePrices.add(solo, today.minusDays(1), Money.of("42.0000", CurrencyUnit.USD))

        // VTI-TR: the 401(k) trust class of the same index - no ticker,
        // mirrors VTI, priced by four sparse "statements" at roughly
        // 0.55x VTI's level, so the two-axis chart has something to align.
        val vtiTr = securities.create(portfolioId, "VTI-TR", CurrencyUnit.USD)
        securities.updateProfile(
            vtiTr, "Inst Tot Stk Mkt Ix Tr", SecurityType.COLLECTIVE_TRUST, PricingLocus.MANUAL,
            TaxTreatment.LOTS, Fraction.of("0.0001"),
            marketTicker = null, cusip = "922908769", isin = null, mirrorsSecurityId = vti,
        )
        for (daysAgo in listOf(200L, 130L, 60L, 4L)) {
            // VTI's synthetic close on that day is 180 + 0.10 * (219 - daysAgo).
            val vtiClose = BigDecimal("180.00").add(BigDecimal("0.10").multiply(BigDecimal(219 - daysAgo)))
            val trustPrice = vtiClose.multiply(BigDecimal("0.55")).setScale(4, java.math.RoundingMode.HALF_UP)
            privatePrices.upsert(vtiTr, today.minusDays(daysAgo), Money.of(trustPrice, CurrencyUnit.USD), "plaid")
        }
        classifications.replace(vtiTr, net.stewart.finance.domain.ClassificationKind.ASSET_CLASS, mapOf("US Stock" to Fraction.ONE), today.minusDays(30))

        val ghost = securities.create(portfolioId, "GHOST", CurrencyUnit.USD)
        securities.updateProfile(ghost, "Hidden test security", SecurityType.STOCK, PricingLocus.MANUAL, TaxTreatment.LOTS, null)
        securities.setHidden(ghost, true)

        ids["security.vti"] = vti.value
        ids["security.bondx"] = bondx.value
        ids["security.gold"] = gold.value
        ids["security.eufund"] = eufund.value
        ids["security.solo"] = solo.value
        ids["security.vtiTr"] = vtiTr.value
        ids["security.ghost"] = ghost.value

        // Taxable lots and sales. The previous-calendar-year sale is
        // what the tax report's default range shows. Documented gains
        // (ui-testing.md): LT $233.60 + ST $35.40 on the lastYear sale.
        val vtiLt = lots.create(
            brokerage, vti, LocalDate.of(lastYear - 1, 3, 1),
            Quantity.of("30"), Money.of("150.0000", CurrencyUnit.USD), Money.of("5.0000", CurrencyUnit.USD),
        )
        val vtiSt = lots.create(
            brokerage, vti, LocalDate.of(lastYear, 1, 20),
            Quantity.of("20"), Money.of("180.0000", CurrencyUnit.USD), Money.of("5.0000", CurrencyUnit.USD),
        )
        val saleLastYear = sales.create(
            brokerage, vti, LocalDate.of(lastYear, 6, 15),
            Money.of("190.0000", CurrencyUnit.USD), Money.of("9.0000", CurrencyUnit.USD),
            listOf(vtiLt to Quantity.of("6"), vtiSt to Quantity.of("4")),
        )
        val saleThisYear = sales.create(
            brokerage, vti, today.minusDays(30),
            Money.of("200.0000", CurrencyUnit.USD), Money.zero(CurrencyUnit.USD),
            listOf(vtiLt to Quantity.of("5")),
        )
        val bondxLot = lots.create(
            brokerage, bondx, today.minusDays(100),
            Quantity.of("100"), Money.of("10.0000", CurrencyUnit.USD), Money.zero(CurrencyUnit.USD),
        )
        ids["lot.vti_lt"] = vtiLt.value
        ids["lot.vti_st"] = vtiSt.value
        ids["lot.bondx"] = bondxLot.value
        ids["sale.last_year"] = saleLastYear.value
        ids["sale.this_year"] = saleThisYear.value

        // EUFUND: one EUR lot (100 @ EUR 90 + EUR 10 = EUR 9010 cost;
        // x 1.10 = USD 9911 floor) and two year-end marks.
        ids["lot.eufund"] = lots.create(
            eur, eufund, eufundBought,
            Quantity.of("100"), Money.of("90.0000", CurrencyUnit.EUR), Money.of("10.0000", CurrencyUnit.EUR),
        ).value
        val eufundRow = checkNotNull(securities.find(eufund, portfolioId))
        mtm.record(
            portfolioId, eufundRow, lastYear - 1, LocalDate.of(lastYear - 1, 12, 31),
            Quantity.of("100"), Money.of("9500.0000", CurrencyUnit.EUR), BigDecimal("1.05000000"),
        )
        mtm.record(
            portfolioId, eufundRow, lastYear, LocalDate.of(lastYear, 12, 31),
            Quantity.of("100"), Money.of("10000.0000", CurrencyUnit.EUR), BigDecimal("1.08000000"),
        )

        // Tax-deferred holdings with both provenance kinds.
        holdings.upsert(roth, vti, Quantity.of("12"), EntrySource.MANUAL, today.minusDays(10))
        holdings.upsert(roth, gold, Quantity.of("5"), EntrySource.PLAID, today.minusDays(3))

        // Target allocation (percent: 10/40/20/20/10).
        targets.replace(
            portfolioId,
            mapOf(
                "Cash" to Fraction.of("0.1"),
                "US Stock" to Fraction.of("0.4"),
                "Non US Stock" to Fraction.of("0.2"),
                "Bond" to Fraction.of("0.2"),
                "Other" to Fraction.of("0.1"),
            ),
        )

        // One archived, unprocessed bankferry snapshot with its Roth
        // link, so the Imports screen has every state reachable.
        val snapshotBytes = sampleSnapshot(today.minusDays(3)).toByteArray()
        val snapshotId = snapshots.create(
            portfolioId, "vanguard-sample.pb", snapshotBytes,
            schemaVersion = 1, asOf = today.minusDays(3),
        )
        links.link("ref-roth", roth)
        ids["snapshot.sample"] = snapshotId.value

        return ids
    }

    private fun sampleSnapshot(asOf: LocalDate): InvestmentsSnapshot {
        fun decimal(v: String) = net.stewart.bankferry.proto.Decimal.newBuilder().setValue(v).build()
        fun money(v: String) = net.stewart.bankferry.proto.Money.newBuilder()
            .setAmount(decimal(v)).setCurrencyCode("USD").build()
        return InvestmentsSnapshot.newBuilder()
            .setSchemaVersion(1)
            .setAsOf(
                net.stewart.bankferry.proto.Date.newBuilder()
                    .setYear(asOf.year).setMonth(asOf.monthValue).setDay(asOf.dayOfMonth)
            )
            .addItems(
                net.stewart.bankferry.proto.ItemSnapshot.newBuilder()
                    .setInstitutionEntry("Vanguard")
                    .setItemRef("item-sample")
                    .addAccounts(
                        net.stewart.bankferry.proto.Account.newBuilder()
                            .setAccountRef("ref-roth")
                            .setName("Roth IRA").setMask("5678")
                            .setType("investment").setSubtype("roth")
                            .setCashBalance(money("55.2500"))
                            .addHoldings(
                                net.stewart.bankferry.proto.Holding.newBuilder()
                                    .setSecurity(
                                        net.stewart.bankferry.proto.SecurityRef.newBuilder()
                                            .setTicker("VTI").setName("Total Market ETF")
                                            .setCurrencyCode("USD")
                                    )
                                    .setQuantity(decimal("12"))
                                    .setInstitutionValue(money("2422.8000"))
                            )
                    )
            )
            .build()
    }
}
