package net.stewart.finance

import io.grpc.Context
import io.grpc.Status
import io.grpc.StatusException
import java.time.LocalDate
import kotlinx.coroutines.runBlocking
import net.stewart.armeria.auth.GRPC_AUTH_USER_KEY
import net.stewart.finance.auth.FinanceUser
import net.stewart.finance.auth.FinanceUserRepository
import net.stewart.finance.db.ClassificationRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.proto.AddPrivatePriceRequest
import net.stewart.finance.proto.AddSecurityRequest
import net.stewart.finance.proto.Date
import net.stewart.finance.proto.Decimal
import net.stewart.finance.proto.DeletePrivatePriceRequest
import net.stewart.finance.proto.GetSecurityDetailsRequest
import net.stewart.finance.proto.ListPrivatePricesRequest
import net.stewart.finance.proto.ListSecuritiesRequest
import net.stewart.finance.proto.PricingLocus
import net.stewart.finance.proto.SecurityType
import net.stewart.finance.proto.SetClassificationRequest
import net.stewart.finance.proto.SetSecurityHiddenRequest
import net.stewart.finance.proto.UpdatePrivatePriceRequest
import net.stewart.finance.proto.UpdateSecurityProfileRequest
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

private fun date(y: Int, m: Int, d: Int): Date =
    Date.newBuilder().setYear(y).setMonth(m).setDay(d).build()

private fun decimal(v: String): Decimal = Decimal.newBuilder().setValue(v).build()

class SecurityServiceTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()

        // Companion-level lazies: JUnit creates a fresh test-class
        // instance per method, but the user must be created once.
        private val users by lazy { FinanceUserRepository(db.dataSource) }
        private fun pricingNoProviders(): net.stewart.finance.api.PricingService {
            val marketRepo = net.stewart.finance.db.MarketPriceRepository(db.dataSource)
            return net.stewart.finance.api.PricingService(
                PrivatePriceRepository(db.dataSource), marketRepo,
                net.stewart.finance.feeds.MarketData(marketRepo, emptyList()),
            )
        }
        private fun mtmService(pricing: net.stewart.finance.api.PricingService) =
            net.stewart.finance.api.MtmService(
                net.stewart.finance.db.LotRepository(db.dataSource),
                net.stewart.finance.db.SaleRepository(db.dataSource),
                net.stewart.finance.db.MtmMarkRepository(db.dataSource),
                net.stewart.finance.db.FxRepository(db.dataSource),
                net.stewart.finance.api.ReportingCurrency(net.stewart.finance.db.FxRepository(db.dataSource)),
                history = { pricing.history(it) },
            )
        private val service by lazy {
            val pricing = pricingNoProviders()
            SecurityGrpcService(
                PortfolioRepository(db.dataSource),
                SecurityRepository(db.dataSource),
                ClassificationRepository(db.dataSource),
                PrivatePriceRepository(db.dataSource),
                net.stewart.finance.db.AssetClassRepository(db.dataSource),
                pricing,
                mtmService(pricing),
            )
        }
        private val jeff by lazy { users.createUser("jeff", "hash", "Jeff") }
    }

    private fun <T> call(block: suspend () -> T): T {
        val ctx = Context.current().withValue(GRPC_AUTH_USER_KEY, jeff as net.stewart.auth.AuthUser)
        val prev = ctx.attach()
        try {
            return runBlocking { block() }
        } finally {
            ctx.detach(prev)
        }
    }

    private fun statusOf(block: suspend () -> Unit): Status.Code = try {
        call(block)
        error("expected a StatusException")
    } catch (e: StatusException) {
        e.status.code
    }

    @Test
    fun `security lifecycle - profile, classification, private prices, details`() {
        // Add by ticker only (spec sec. 9.18); duplicates rejected.
        val added = call {
            service.addSecurity(
                AddSecurityRequest.newBuilder().setTicker("TRUST-A").setCurrencyCode("USD").build()
            )
        }.security
        assertEquals(SecurityType.SECURITY_TYPE_UNSPECIFIED, added.securityType)
        assertEquals(PricingLocus.MANUAL, added.pricingLocus)
        assertEquals(
            Status.Code.ALREADY_EXISTS,
            statusOf {
                service.addSecurity(
                    AddSecurityRequest.newBuilder().setTicker("TRUST-A").setCurrencyCode("USD").build()
                )
            },
        )
        val id = added.securityId

        // Profile edit: description, type, expense ratio.
        call {
            service.updateSecurityProfile(
                UpdateSecurityProfileRequest.newBuilder()
                    .setSecurityId(id)
                    .setDescription("401k trust fund A")
                    .setSecurityType(SecurityType.PRIVATE_INVESTMENT)
                    .setPricingLocus(PricingLocus.MANUAL)
                    .setNetExpenseRatio(decimal("0.004"))
                    .build()
            )
        }

        // Classification: must sum to 1, keys must be real classes.
        assertEquals(
            Status.Code.INVALID_ARGUMENT,
            statusOf {
                service.setClassification(
                    SetClassificationRequest.newBuilder()
                        .setSecurityId(id).setKind("ASSET_CLASS")
                        .putWeights("Other", decimal("0.5"))
                        .setAsOf(date(2026, 8, 1)).build()
                )
            },
        )
        assertEquals(
            Status.Code.INVALID_ARGUMENT,
            statusOf {
                service.setClassification(
                    SetClassificationRequest.newBuilder()
                        .setSecurityId(id).setKind("ASSET_CLASS")
                        .putWeights("Commodities", decimal("1"))
                        .setAsOf(date(2026, 8, 1)).build()
                )
            },
        )
        // Unknown kinds cannot reach the database.
        assertEquals(
            Status.Code.INVALID_ARGUMENT,
            statusOf {
                service.setClassification(
                    SetClassificationRequest.newBuilder()
                        .setSecurityId(id).setKind("ASTROLOGY")
                        .putWeights("Other", decimal("1"))
                        .setAsOf(date(2026, 8, 1)).build()
                )
            },
        )
        call {
            service.setClassification(
                SetClassificationRequest.newBuilder()
                    .setSecurityId(id).setKind("ASSET_CLASS")
                    .putWeights("Bond", decimal("0.6"))
                    .putWeights("Other", decimal("0.4"))
                    .setAsOf(date(2026, 8, 1)).build()
            )
        }

        // Private prices: CRUD, duplicate-date rejection, newest first.
        val p1 = call {
            service.addPrivatePrice(
                AddPrivatePriceRequest.newBuilder()
                    .setSecurityId(id).setDate(date(2026, 7, 1)).setPrice(decimal("100.50")).build()
            )
        }.priceId
        call {
            service.addPrivatePrice(
                AddPrivatePriceRequest.newBuilder()
                    .setSecurityId(id).setDate(date(2026, 8, 1)).setPrice(decimal("101.25")).build()
            )
        }
        assertEquals(
            Status.Code.ALREADY_EXISTS,
            statusOf {
                service.addPrivatePrice(
                    AddPrivatePriceRequest.newBuilder()
                        .setSecurityId(id).setDate(date(2026, 8, 1)).setPrice(decimal("999")).build()
                )
            },
        )
        call {
            service.updatePrivatePrice(
                UpdatePrivatePriceRequest.newBuilder()
                    .setPriceId(p1).setDate(date(2026, 7, 2)).setPrice(decimal("100.75")).build()
            )
        }
        val priceList = call {
            service.listPrivatePrices(ListPrivatePricesRequest.newBuilder().setSecurityId(id).build())
        }
        assertEquals(listOf("$101.25", "$100.75"), priceList.pricesList.map { it.price.display })

        // Details: profile round-trips, history ascending, adjusted = close.
        val details = call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(id).build())
        }
        assertEquals("401k trust fund A", details.security.description)
        assertEquals(SecurityType.PRIVATE_INVESTMENT, details.security.securityType)
        assertEquals("0.4%", details.security.netExpenseRatio.display)
        val classification = details.security.classificationsList.single()
        assertEquals("ASSET_CLASS", classification.kind)
        assertEquals("60%", classification.weightsMap.getValue("Bond").display)
        assertTrue(!classification.refreshSuggested)
        // Wire decimals carry the canonical scale (money = 4).
        assertEquals(listOf("100.7500", "101.2500"), details.priceHistoryList.map { it.close.value })
        assertEquals(details.priceHistoryList[0].close, details.priceHistoryList[0].adjustedClose)

        // Sparklines ride the list response (no N+1).
        val listing = call { service.listSecurities(ListSecuritiesRequest.getDefaultInstance()) }
        val trustA = listing.securitiesList.single { it.ticker == "TRUST-A" }
        assertEquals(2, trustA.sparkline.adjustedClosesCount)

        // Inflation toggle needs a seeded CPI series.
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf {
                service.getSecurityDetails(
                    GetSecurityDetailsRequest.newBuilder().setSecurityId(id).setInflationAdjusted(true).build()
                )
            },
        )

        // Cleanup path: delete a price.
        call {
            service.deletePrivatePrice(DeletePrivatePriceRequest.newBuilder().setPriceId(p1).build())
        }
        assertEquals(
            1,
            call {
                service.listPrivatePrices(ListPrivatePricesRequest.newBuilder().setSecurityId(id).build())
            }.pricesCount,
        )
    }

    @Test
    fun `a trust fund is added with its institution identifiers and no market ticker`() {
        val trust = call {
            service.addSecurity(
                AddSecurityRequest.newBuilder()
                    .setTicker("vbtix-tr").setCurrencyCode("USD")
                    .setDescription("Inst Tot Bd Mkt Ix Tr")
                    .setSecurityType(SecurityType.COLLECTIVE_TRUST)
                    .setPricingLocus(PricingLocus.MANUAL)
                    .setCusip("922908769")
                    .build()
            )
        }.security
        assertEquals("VBTIX-TR", trust.ticker)
        assertEquals("", trust.marketTicker)
        assertEquals("922908769", trust.cusip)
        assertEquals(SecurityType.COLLECTIVE_TRUST, trust.securityType)
        assertEquals(PricingLocus.MANUAL, trust.pricingLocus)
        assertEquals("Inst Tot Bd Mkt Ix Tr", trust.description)

        // Symbols are letters, digits, '.', '-' only; identifiers are checked.
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf {
            service.addSecurity(AddSecurityRequest.newBuilder().setTicker("BAD SYM").setCurrencyCode("USD").build())
        })
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf {
            service.addSecurity(AddSecurityRequest.newBuilder().setTicker("X1").setCurrencyCode("USD").setCusip("123").build())
        })

        // A pre-V010 client updating the profile leaves the identifiers alone.
        call {
            service.updateSecurityProfile(
                UpdateSecurityProfileRequest.newBuilder()
                    .setSecurityId(trust.securityId)
                    .setDescription("Total Bond Market Index Trust")
                    .setSecurityType(SecurityType.COLLECTIVE_TRUST)
                    .setPricingLocus(PricingLocus.MANUAL)
                    .build()
            )
        }
        val kept = call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(trust.securityId).build())
        }.security
        assertEquals("922908769", kept.cusip)
        assertEquals("Total Bond Market Index Trust", kept.description)

        // Sending the field clears it.
        call {
            service.updateSecurityProfile(
                UpdateSecurityProfileRequest.newBuilder()
                    .setSecurityId(trust.securityId)
                    .setDescription("Total Bond Market Index Trust")
                    .setSecurityType(SecurityType.COLLECTIVE_TRUST)
                    .setPricingLocus(PricingLocus.MANUAL)
                    .setCusip("")
                    .build()
            )
        }
        assertEquals("", call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(trust.securityId).build())
        }.security.cusip)
    }

    @Test
    fun `market locus carries a provider symbol, defaulting to the symbol itself`() {
        val fund = call {
            service.addSecurity(AddSecurityRequest.newBuilder().setTicker("VBTIX").setCurrencyCode("USD").build())
        }.security
        assertEquals("", fund.marketTicker)
        // Flipping to MARKET with nothing sent: the symbol is the provider symbol.
        call {
            service.updateSecurityProfile(
                UpdateSecurityProfileRequest.newBuilder()
                    .setSecurityId(fund.securityId).setSecurityType(SecurityType.MUTUAL_FUND)
                    .setPricingLocus(PricingLocus.MARKET).build()
            )
        }
        val market = call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(fund.securityId).build())
        }.security
        assertEquals("VBTIX", market.marketTicker)
        // An explicit provider symbol that differs from the local one.
        call {
            service.updateSecurityProfile(
                UpdateSecurityProfileRequest.newBuilder()
                    .setSecurityId(fund.securityId).setSecurityType(SecurityType.MUTUAL_FUND)
                    .setPricingLocus(PricingLocus.MARKET).setMarketTicker("vbtix.us").build()
            )
        }
        assertEquals("VBTIX.US", call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(fund.securityId).build())
        }.security.marketTicker)
        // Back to MANUAL drops it: nothing would use it.
        call {
            service.updateSecurityProfile(
                UpdateSecurityProfileRequest.newBuilder()
                    .setSecurityId(fund.securityId).setSecurityType(SecurityType.MUTUAL_FUND)
                    .setPricingLocus(PricingLocus.MANUAL).build()
            )
        }
        assertEquals("", call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(fund.securityId).build())
        }.security.marketTicker)
    }

    @Test
    fun `a trust mirrors one public fund - same currency, one hop, no self`() {
        val fund = call {
            service.addSecurity(AddSecurityRequest.newBuilder().setTicker("MIRFUND").setCurrencyCode("USD").build())
        }.security
        val trust = call {
            service.addSecurity(
                AddSecurityRequest.newBuilder().setTicker("MIRFUND-TR").setCurrencyCode("USD")
                    .setSecurityType(SecurityType.COLLECTIVE_TRUST).build()
            )
        }.security
        val euro = call {
            service.addSecurity(AddSecurityRequest.newBuilder().setTicker("MIRFUND-EU").setCurrencyCode("EUR").build())
        }.security
        suspend fun mirror(id: Long, target: Long) = service.updateSecurityProfile(
            UpdateSecurityProfileRequest.newBuilder()
                .setSecurityId(id).setSecurityType(SecurityType.COLLECTIVE_TRUST)
                .setPricingLocus(PricingLocus.MANUAL).setMirrorsSecurityId(target).build()
        )
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf { mirror(trust.securityId, trust.securityId) })
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf { mirror(trust.securityId, euro.securityId) })
        assertEquals(Status.Code.NOT_FOUND, statusOf { mirror(trust.securityId, 999_999) })
        call { mirror(trust.securityId, fund.securityId) }
        val profile = call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(trust.securityId).build())
        }.security
        assertEquals(fund.securityId, profile.mirrorsSecurityId)
        assertEquals("MIRFUND", profile.mirrorsTicker)
        // No chains: the fund cannot mirror something while it is mirrored,
        // and nothing can mirror the trust.
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf { mirror(fund.securityId, euro.securityId) })
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf { mirror(euro.securityId, trust.securityId) })
        // 0 clears.
        call { mirror(trust.securityId, 0) }
        assertEquals(0L, call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(trust.securityId).build())
        }.security.mirrorsSecurityId)
    }

    @Test
    fun `a fat-fingered symbol can be renamed - clashes and bad symbols are refused`() {
        val typo = call {
            service.addSecurity(AddSecurityRequest.newBuilder().setTicker("VBTXI-TR").setCurrencyCode("USD").build())
        }.security
        val other = call {
            service.addSecurity(AddSecurityRequest.newBuilder().setTicker("RENAME-OTHER").setCurrencyCode("USD").build())
        }.security
        suspend fun rename(to: String) = service.updateSecurityProfile(
            UpdateSecurityProfileRequest.newBuilder()
                .setSecurityId(typo.securityId).setSecurityType(SecurityType.COLLECTIVE_TRUST)
                .setPricingLocus(PricingLocus.MANUAL).setTicker(to).build()
        )
        assertEquals(Status.Code.ALREADY_EXISTS, statusOf { rename("rename-other") })
        assertEquals(Status.Code.INVALID_ARGUMENT, statusOf { rename("bad symbol") })
        call { rename("rename-fixed") }
        val fixed = call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(typo.securityId).build())
        }.security
        assertEquals("RENAME-FIXED", fixed.ticker)
        assertEquals(typo.securityId, fixed.securityId)
        // An older client that does not send the field leaves it alone.
        call {
            service.updateSecurityProfile(
                UpdateSecurityProfileRequest.newBuilder()
                    .setSecurityId(typo.securityId).setSecurityType(SecurityType.COLLECTIVE_TRUST)
                    .setPricingLocus(PricingLocus.MANUAL).build()
            )
        }
        assertEquals("RENAME-FIXED", call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(typo.securityId).build())
        }.security.ticker)
        assertEquals("RENAME-OTHER", call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(other.securityId).build())
        }.security.ticker)
    }

    @Test
    fun `stale classifications suggest a refresh`() {
        val id = call {
            service.addSecurity(
                AddSecurityRequest.newBuilder().setTicker("OLDMIX").setCurrencyCode("USD").build()
            )
        }.security.securityId
        call {
            service.setClassification(
                SetClassificationRequest.newBuilder()
                    .setSecurityId(id).setKind("ASSET_CLASS")
                    .putWeights("Other", decimal("1"))
                    .setAsOf(date(2024, 1, 1)).build()
            )
        }
        val details = call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(id).build())
        }
        assertTrue(details.security.classificationsList.single().refreshSuggested)
    }

    @Test
    fun `market-locus securities reject manual prices and indicators come from history`() {
        val marketId = call {
            service.addSecurity(
                AddSecurityRequest.newBuilder().setTicker("VTI").setCurrencyCode("USD").build()
            )
        }.security.securityId
        call {
            service.updateSecurityProfile(
                UpdateSecurityProfileRequest.newBuilder()
                    .setSecurityId(marketId).setDescription("Total market")
                    .setSecurityType(SecurityType.ETF)
                    .setPricingLocus(PricingLocus.MARKET)
                    .build()
            )
        }
        assertEquals(
            Status.Code.FAILED_PRECONDITION,
            statusOf {
                service.addPrivatePrice(
                    AddPrivatePriceRequest.newBuilder()
                        .setSecurityId(marketId).setDate(date(2026, 8, 1)).setPrice(decimal("100")).build()
                )
            },
        )

        // A manual security with 25 price points gets 20-window indicators.
        val trustId = call {
            service.addSecurity(
                AddSecurityRequest.newBuilder().setTicker("TRUST-B").setCurrencyCode("USD").build()
            )
        }.security.securityId
        db.dataSource.connection.use { conn ->
            conn.prepareStatement(
                "INSERT INTO private_prices (security_id, price_date, price) VALUES (?, ?, ?)"
            ).use { stmt ->
                var day = LocalDate.parse("2026-06-01")
                repeat(25) { i ->
                    stmt.setLong(1, trustId)
                    stmt.setObject(2, day)
                    stmt.setBigDecimal(3, java.math.BigDecimal(100 + i))
                    stmt.addBatch()
                    day = day.plusDays(1)
                }
                stmt.executeBatch()
            }
        }
        val details = call {
            service.getSecurityDetails(GetSecurityDetailsRequest.newBuilder().setSecurityId(trustId).build())
        }
        assertEquals(25, details.priceHistoryCount)
        assertEquals(6, details.indicators.smaCount)      // 25 - 20 + 1
        assertEquals(6, details.indicators.emaCount)
        assertEquals(6, details.indicators.bollingerCount)
    }

    @Test
    fun `flat CPI leaves adjusted history equal to nominal`() {
        val flat = net.stewart.finance.rules.CpiSeries(
            (0L..23L).associate {
                java.time.YearMonth.parse("2025-01").plusMonths(it) to java.math.BigDecimal("100")
            }
        )
        val inflationPricing = pricingNoProviders()
        val inflationService = SecurityGrpcService(
            PortfolioRepository(db.dataSource),
            SecurityRepository(db.dataSource),
            ClassificationRepository(db.dataSource),
            PrivatePriceRepository(db.dataSource),
            net.stewart.finance.db.AssetClassRepository(db.dataSource),
            inflationPricing,
            mtmService(inflationPricing),
            cpiSeries = { flat },
        )
        val id = call {
            service.addSecurity(
                AddSecurityRequest.newBuilder().setTicker("FLATCPI").setCurrencyCode("USD").build()
            )
        }.security.securityId
        call {
            service.addPrivatePrice(
                AddPrivatePriceRequest.newBuilder()
                    .setSecurityId(id).setDate(date(2026, 6, 1)).setPrice(decimal("50")).build()
            )
        }
        val adjusted = call {
            inflationService.getSecurityDetails(
                GetSecurityDetailsRequest.newBuilder().setSecurityId(id).setInflationAdjusted(true).build()
            )
        }
        assertEquals(listOf("50.0000"), adjusted.priceHistoryList.map { it.close.value })
    }

    @Test
    fun `hide guard and hidden listing`() {
        val id = call {
            service.addSecurity(
                AddSecurityRequest.newBuilder().setTicker("HIDEME").setCurrencyCode("USD").build()
            )
        }.security.securityId
        call {
            service.setSecurityHidden(
                SetSecurityHiddenRequest.newBuilder().setSecurityId(id).setHidden(true).build()
            )
        }
        val visible = call { service.listSecurities(ListSecuritiesRequest.getDefaultInstance()) }
        assertTrue(visible.securitiesList.none { it.ticker == "HIDEME" })
        val all = call {
            service.listSecurities(ListSecuritiesRequest.newBuilder().setIncludeHidden(true).build())
        }
        assertTrue(all.securitiesList.any { it.ticker == "HIDEME" })
        call {
            service.setSecurityHidden(
                SetSecurityHiddenRequest.newBuilder().setSecurityId(id).setHidden(false).build()
            )
        }
    }
}
