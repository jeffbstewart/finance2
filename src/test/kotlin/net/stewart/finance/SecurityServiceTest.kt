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
        private val service by lazy {
            SecurityGrpcService(
                PortfolioRepository(db.dataSource),
                SecurityRepository(db.dataSource),
                ClassificationRepository(db.dataSource),
                PrivatePriceRepository(db.dataSource),
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
        // Add by ticker only (spec §9.18); duplicates rejected.
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

        // Inflation toggle awaits CPI wiring.
        assertEquals(
            Status.Code.UNIMPLEMENTED,
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
        assertEquals(6, details.indicators.smaCount)      // 25 − 20 + 1
        assertEquals(6, details.indicators.emaCount)
        assertEquals(6, details.indicators.bollingerCount)
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
