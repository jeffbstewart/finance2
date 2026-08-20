package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import java.math.BigDecimal
import java.sql.SQLException
import java.time.DateTimeException
import java.time.LocalDate
import net.stewart.armeria.auth.currentAuthUser
import net.stewart.finance.api.toFormatted
import net.stewart.finance.api.toFormattedPercent
import net.stewart.finance.api.toLocalDate
import net.stewart.finance.api.toProto
import net.stewart.finance.db.AssetClassRepository
import net.stewart.finance.db.ClassificationRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.domain.ClassificationKind
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PriceId
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.SecurityType
import net.stewart.finance.domain.UserId
import net.stewart.finance.rules.ClosePoint
import net.stewart.finance.rules.bollingerBands
import net.stewart.finance.rules.ema
import net.stewart.finance.rules.sma
import net.stewart.finance.proto.AddPrivatePriceRequest
import net.stewart.finance.proto.AddPrivatePriceResponse
import net.stewart.finance.proto.AddSecurityRequest
import net.stewart.finance.proto.AddSecurityResponse
import net.stewart.finance.proto.BollingerPoint
import net.stewart.finance.proto.ClassificationSet
import net.stewart.finance.proto.DeletePrivatePriceRequest
import net.stewart.finance.proto.DeletePrivatePriceResponse
import net.stewart.finance.proto.GetSecurityDetailsRequest
import net.stewart.finance.proto.GetSecurityDetailsResponse
import net.stewart.finance.proto.IndicatorPoint
import net.stewart.finance.proto.ListPrivatePricesRequest
import net.stewart.finance.proto.ListPrivatePricesResponse
import net.stewart.finance.proto.ListSecuritiesRequest
import net.stewart.finance.proto.ListSecuritiesResponse
import net.stewart.finance.proto.PricePoint
import net.stewart.finance.proto.PricingLocus as PricingLocusProto
import net.stewart.finance.proto.PrivatePriceRow
import net.stewart.finance.proto.SecurityListing
import net.stewart.finance.proto.SecurityProfile
import net.stewart.finance.proto.SecurityServiceGrpcKt
import net.stewart.finance.proto.SecurityType as SecurityTypeProto
import net.stewart.finance.proto.SetClassificationRequest
import net.stewart.finance.proto.SetClassificationResponse
import net.stewart.finance.proto.SetSecurityHiddenRequest
import net.stewart.finance.proto.SetSecurityHiddenResponse
import net.stewart.finance.proto.Sparkline
import net.stewart.finance.proto.UpdatePrivatePriceRequest
import net.stewart.finance.proto.UpdatePrivatePriceResponse
import net.stewart.finance.proto.UpdateSecurityProfileRequest
import net.stewart.finance.proto.UpdateSecurityProfileResponse

/** Sum-to-one tolerance for classification weights (spec §5.9). */
private val WEIGHT_SUM_TOLERANCE = Fraction.of("0.0001")

private const val SPARKLINE_MONTHS = 6L

/**
 * SecurityService (spec §7 "Securities & prices", §9.10–§9.12,
 * §9.17–§9.18) at the build-scope §4 launch scope. Price history and
 * sparklines come from private_prices for MANUAL-locus securities;
 * MARKET-locus history stays empty until the price-source module
 * lands (Phase 4/5). Inflation-adjusted presentation waits on the CPI
 * wiring.
 */
class SecurityGrpcService(
    private val portfolios: PortfolioRepository,
    private val securities: SecurityRepository,
    private val classifications: ClassificationRepository,
    private val prices: PrivatePriceRepository,
    private val assetClasses: AssetClassRepository,
    /** Days after which a classification set suggests a refresh (build-scope §4). */
    private val classificationRefreshDays: Long = 365,
) : SecurityServiceGrpcKt.SecurityServiceCoroutineImplBase() {

    override suspend fun listSecurities(request: ListSecuritiesRequest): ListSecuritiesResponse {
        val portfolioId = portfolio()
        val sparklines = prices.recentBySecurity(portfolioId, LocalDate.now().minusMonths(SPARKLINE_MONTHS))
        val builder = ListSecuritiesResponse.newBuilder()
        for (row in securities.list(portfolioId, request.includeHidden)) {
            val closes = sparklines[row.id].orEmpty()
            builder.addSecurities(
                SecurityListing.newBuilder()
                    .setSecurityId(row.id.value)
                    .setTicker(row.ticker)
                    .setDescription(row.description)
                    .setSparkline(
                        Sparkline.newBuilder().addAllAdjustedCloses(closes.map { it.toProto().amount })
                    )
                    .setHidden(row.hidden)
            )
        }
        return builder.build()
    }

    override suspend fun addSecurity(request: AddSecurityRequest): AddSecurityResponse {
        val portfolioId = portfolio()
        val ticker = request.ticker.trim()
        if (ticker.isEmpty()) throw invalid("ticker is required")
        if (ticker.length > 32) throw invalid("ticker exceeds 32 characters")
        val currency = try {
            CurrencyUnit.parse(request.currencyCode)
        } catch (e: IllegalArgumentException) {
            throw invalid("unknown currency code \"${request.currencyCode}\"")
        }
        val id = try {
            securities.create(portfolioId, ticker, currency)
        } catch (e: SQLException) {
            throw StatusException(
                Status.ALREADY_EXISTS.withDescription("a security with ticker \"$ticker\" already exists")
            )
        }
        val row = checkNotNull(securities.find(id, portfolioId))
        return AddSecurityResponse.newBuilder().setSecurity(row.toProfile()).build()
    }

    override suspend fun getSecurityDetails(request: GetSecurityDetailsRequest): GetSecurityDetailsResponse {
        if (request.inflationAdjusted) {
            throw StatusException(
                Status.UNIMPLEMENTED.withDescription(
                    "inflation-adjusted presentation arrives with the CPI wiring"
                )
            )
        }
        val row = findSecurity(request.securityId)
        // MANUAL locus: the hand-entered history is the history.
        // MARKET locus: empty until the price-source module (Phase 4/5).
        val history = if (row.pricingLocus == PricingLocus.MANUAL) {
            prices.history(row.id).map { ClosePoint(it.date, it.price) }
        } else {
            emptyList()
        }
        val builder = GetSecurityDetailsResponse.newBuilder().setSecurity(row.toProfile())
        for (point in history) {
            builder.addPriceHistory(
                PricePoint.newBuilder()
                    .setDate(point.date.toProto())
                    .setClose(point.close.toProto().amount)
                    .setAdjustedClose(point.close.toProto().amount)
            )
        }
        val indicators = builder.indicatorsBuilder
        for (p in sma(history)) {
            indicators.addSma(IndicatorPoint.newBuilder().setDate(p.date.toProto()).setValue(p.value.toProto().amount))
        }
        for (p in ema(history)) {
            indicators.addEma(IndicatorPoint.newBuilder().setDate(p.date.toProto()).setValue(p.value.toProto().amount))
        }
        for (p in bollingerBands(history)) {
            indicators.addBollinger(
                BollingerPoint.newBuilder()
                    .setDate(p.date.toProto())
                    .setMean(p.mean.toProto().amount)
                    .setUpper(p.upper.toProto().amount)
                    .setLower(p.lower.toProto().amount)
            )
        }
        return builder.build()
    }

    override suspend fun updateSecurityProfile(request: UpdateSecurityProfileRequest): UpdateSecurityProfileResponse {
        val row = findSecurity(request.securityId)
        val locus = when (request.pricingLocus) {
            PricingLocusProto.MARKET -> PricingLocus.MARKET
            PricingLocusProto.MANUAL -> PricingLocus.MANUAL
            else -> throw invalid("pricing locus must be MARKET or MANUAL")
        }
        val type = when (request.securityType) {
            SecurityTypeProto.SECURITY_TYPE_UNSPECIFIED -> SecurityType.UNKNOWN
            SecurityTypeProto.STOCK -> SecurityType.STOCK
            SecurityTypeProto.ETF -> SecurityType.ETF
            SecurityTypeProto.MUTUAL_FUND -> SecurityType.MUTUAL_FUND
            SecurityTypeProto.PRIVATE_INVESTMENT -> SecurityType.PRIVATE
            else -> throw invalid("unknown security type")
        }
        val ratio = request.netExpenseRatio.value.trim().let { raw ->
            if (raw.isEmpty()) null else try {
                Fraction.of(raw).also {
                    if (it.signum() < 0) throw invalid("expense ratio must not be negative")
                }
            } catch (e: ArithmeticException) {
                throw invalid("expense ratio is not a valid fraction: \"$raw\"")
            } catch (e: NumberFormatException) {
                throw invalid("expense ratio is not a valid fraction: \"$raw\"")
            }
        }
        securities.updateProfile(row.id, request.description.trim(), type, locus, ratio)
        return UpdateSecurityProfileResponse.getDefaultInstance()
    }

    override suspend fun setSecurityHidden(request: SetSecurityHiddenRequest): SetSecurityHiddenResponse {
        val row = findSecurity(request.securityId)
        // Guard rail (§5.9): hiding requires no open lots — approximated
        // as no lots/holdings at all until valuation lands (stricter,
        // never looser).
        if (request.hidden && securities.hasPositions(row.id)) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription("the security still has positions")
            )
        }
        securities.setHidden(row.id, request.hidden)
        return SetSecurityHiddenResponse.getDefaultInstance()
    }

    override suspend fun setClassification(request: SetClassificationRequest): SetClassificationResponse {
        val row = findSecurity(request.securityId)
        val kind = ClassificationKind.entries.firstOrNull { it.name == request.kind.trim().uppercase() }
            ?: throw invalid(
                "unknown classification kind \"${request.kind}\" — known: " +
                    ClassificationKind.entries.joinToString { it.name }
            )
        if (request.weightsMap.isEmpty()) throw invalid("at least one weight is required")
        val asOf = try {
            request.asOf.toLocalDate()
        } catch (e: DateTimeException) {
            throw invalid("as_of is not a valid date")
        }
        val weights = request.weightsMap.mapValues { (key, decimal) ->
            val fraction = try {
                Fraction.of(decimal.value)
            } catch (e: Exception) {
                throw invalid("weight for \"$key\" is not a valid fraction: \"${decimal.value}\"")
            }
            if (fraction.signum() < 0) throw invalid("weight for \"$key\" must not be negative")
            fraction
        }
        if (kind == ClassificationKind.ASSET_CLASS) {
            val known = assetClasses.names()
            weights.keys.firstOrNull { it !in known }?.let {
                throw invalid("unknown asset class \"$it\"")
            }
        }
        // Weights must sum to 1 (±0.0001) — spec §5.9.
        val sum = weights.values.fold(Fraction.ZERO) { acc, w -> acc + w }
        if ((sum - Fraction.ONE).abs() > WEIGHT_SUM_TOLERANCE) {
            throw invalid("weights sum to $sum; they must sum to 1 (±0.0001)")
        }
        classifications.replace(row.id, kind, weights, asOf)
        return SetClassificationResponse.getDefaultInstance()
    }

    override suspend fun listPrivatePrices(request: ListPrivatePricesRequest): ListPrivatePricesResponse {
        val row = findSecurity(request.securityId)
        val builder = ListPrivatePricesResponse.newBuilder()
        for (price in prices.list(row.id)) {
            builder.addPrices(
                PrivatePriceRow.newBuilder()
                    .setPriceId(price.id.value)
                    .setDate(
                        net.stewart.finance.proto.FormattedDate.newBuilder()
                            .setExact(price.date.toProto())
                            .setDisplay(price.date.toString())
                            .setSortKey((price.date.year * 10000 + price.date.monthValue * 100 + price.date.dayOfMonth).toDouble())
                    )
                    .setPrice(price.price.toFormatted())
            )
        }
        return builder.build()
    }

    override suspend fun addPrivatePrice(request: AddPrivatePriceRequest): AddPrivatePriceResponse {
        val row = manualSecurity(request.securityId)
        val (date, price) = parseDatePrice(request.date, request.price.value, row)
        val id = try {
            prices.add(row.id, date, price)
        } catch (e: SQLException) {
            throw duplicateDate(date)
        }
        return AddPrivatePriceResponse.newBuilder().setPriceId(id.value).build()
    }

    override suspend fun updatePrivatePrice(request: UpdatePrivatePriceRequest): UpdatePrivatePriceResponse {
        val portfolioId = portfolio()
        val existing = prices.find(priceId(request.priceId), portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no price ${request.priceId}"))
        val security = checkNotNull(securities.find(existing.securityId, portfolioId))
        val (date, price) = parseDatePrice(request.date, request.price.value, security)
        try {
            prices.update(existing.id, date, price)
        } catch (e: SQLException) {
            throw duplicateDate(date)
        }
        return UpdatePrivatePriceResponse.getDefaultInstance()
    }

    override suspend fun deletePrivatePrice(request: DeletePrivatePriceRequest): DeletePrivatePriceResponse {
        val existing = prices.find(priceId(request.priceId), portfolio())
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no price ${request.priceId}"))
        prices.delete(existing.id)
        return DeletePrivatePriceResponse.getDefaultInstance()
    }

    private fun parseDatePrice(
        dateProto: net.stewart.finance.proto.Date,
        rawPrice: String,
        security: SecurityRow,
    ): Pair<LocalDate, Money> {
        val date = try {
            dateProto.toLocalDate()
        } catch (e: DateTimeException) {
            throw invalid("date is not a valid date")
        }
        val price = try {
            Money.of(rawPrice, security.currency)
        } catch (e: Exception) {
            throw invalid("price is not a valid amount: \"$rawPrice\"")
        }
        if (price.signum() < 0) throw invalid("price must not be negative")
        return date to price
    }

    private fun SecurityRow.toProfile(): SecurityProfile {
        val today = LocalDate.now()
        val builder = SecurityProfile.newBuilder()
            .setSecurityId(id.value)
            .setTicker(ticker)
            .setDescription(description)
            .setCurrencyCode(currency.code)
            .setSecurityType(securityType.toProto())
            .setPricingLocus(pricingLocus.toProto())
            .setHidden(hidden)
        netExpenseRatio?.let { builder.setNetExpenseRatio(it.toFormattedPercent()) }
        for (set in classifications.setsFor(id)) {
            val setBuilder = ClassificationSet.newBuilder()
                .setKind(set.kind.name)
                .setAsOf(set.asOf.toProto())
                .setRefreshSuggested(set.asOf.plusDays(classificationRefreshDays) < today)
            for ((key, weight) in set.weights) {
                setBuilder.putWeights(key, weight.toFormattedPercent())
            }
            builder.addClassifications(setBuilder)
        }
        return builder.build()
    }

    private fun findSecurity(raw: Long): SecurityRow {
        if (raw <= 0) throw invalid("security id is required")
        return securities.find(SecurityId(raw), portfolio())
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no security $raw"))
    }

    private fun manualSecurity(raw: Long): SecurityRow {
        val row = findSecurity(raw)
        // Spec §5.6: manual price CRUD is rejected for MARKET-locus
        // securities — their prices come from the provider.
        if (row.pricingLocus != PricingLocus.MANUAL) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "${row.ticker} is market-priced; manual price entries apply only to MANUAL-locus securities"
                )
            )
        }
        return row
    }

    private fun priceId(raw: Long): PriceId =
        if (raw > 0) PriceId(raw) else throw invalid("price id is required")

    private fun portfolio(): PortfolioId =
        portfolios.portfolioFor(UserId(currentAuthUser().id))

    private fun invalid(message: String) =
        StatusException(Status.INVALID_ARGUMENT.withDescription(message))

    private fun duplicateDate(date: LocalDate) =
        StatusException(Status.ALREADY_EXISTS.withDescription("a price for $date already exists"))
}
