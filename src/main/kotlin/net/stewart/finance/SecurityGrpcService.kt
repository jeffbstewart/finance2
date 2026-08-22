package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import java.math.BigDecimal
import java.sql.SQLException
import java.time.DateTimeException
import java.time.LocalDate
import net.stewart.armeria.auth.currentAuthUser
import net.stewart.finance.api.MtmService
import net.stewart.finance.api.PricingService
import net.stewart.finance.api.toFormatted
import net.stewart.finance.api.toFormattedDate
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
import net.stewart.finance.domain.MtmMarkId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.SecurityType
import net.stewart.finance.domain.TaxTreatment
import net.stewart.finance.domain.UserId
import net.stewart.finance.rules.ClosePoint
import net.stewart.finance.rules.CpiSeries
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
import net.stewart.finance.proto.DeleteMtmMarkRequest
import net.stewart.finance.proto.DeleteMtmMarkResponse
import net.stewart.finance.proto.ListMtmMarksRequest
import net.stewart.finance.proto.ListMtmMarksResponse
import net.stewart.finance.proto.ListSecuritiesRequest
import net.stewart.finance.proto.ListSecuritiesResponse
import net.stewart.finance.proto.MtmMark as MtmMarkProto
import net.stewart.finance.proto.RecordMtmMarkRequest
import net.stewart.finance.proto.RecordMtmMarkResponse
import net.stewart.finance.proto.SuggestMtmMarkRequest
import net.stewart.finance.proto.SuggestMtmMarkResponse
import net.stewart.finance.proto.UpdateMtmMarkRequest
import net.stewart.finance.proto.UpdateMtmMarkResponse
import net.stewart.finance.proto.PricePoint
import net.stewart.finance.proto.PricingLocus as PricingLocusProto
import net.stewart.finance.proto.PrivatePriceRow
import net.stewart.finance.proto.SecurityListing
import net.stewart.finance.proto.SecurityProfile
import net.stewart.finance.proto.SecurityServiceGrpcKt
import net.stewart.finance.proto.SecurityType as SecurityTypeProto
import net.stewart.finance.proto.TaxTreatment as TaxTreatmentProto
import net.stewart.finance.proto.SetClassificationRequest
import net.stewart.finance.proto.SetClassificationResponse
import net.stewart.finance.proto.SetSecurityHiddenRequest
import net.stewart.finance.proto.SetSecurityHiddenResponse
import net.stewart.finance.proto.Sparkline
import net.stewart.finance.proto.UpdatePrivatePriceRequest
import net.stewart.finance.proto.UpdatePrivatePriceResponse
import net.stewart.finance.proto.UpdateSecurityProfileRequest
import net.stewart.finance.proto.UpdateSecurityProfileResponse

/** Sum-to-one tolerance for classification weights (spec sec. 5.9). */
private val WEIGHT_SUM_TOLERANCE = Fraction.of("0.0001")

private const val SPARKLINE_MONTHS = 6L

/**
 * SecurityService (spec sec. 7 "Securities & prices", sec. 9.10-sec. 9.12,
 * sec. 9.17-sec. 9.18) at the build-scope sec. 4 launch scope. Price history and
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
    private val pricing: PricingService,
    private val mtm: MtmService,
    /** The persisted CPI series, or null while unseeded (degraded mode). */
    private val cpiSeries: () -> CpiSeries? = { null },
    /** Days after which a classification set suggests a refresh (build-scope sec. 4). */
    private val classificationRefreshDays: Long = 365,
) : SecurityServiceGrpcKt.SecurityServiceCoroutineImplBase() {

    override suspend fun listSecurities(request: ListSecuritiesRequest): ListSecuritiesResponse {
        val portfolioId = portfolio()
        val sparklines = pricing.sparklines(portfolioId, LocalDate.now().minusMonths(SPARKLINE_MONTHS))
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
                    .setMarketTicker(row.marketTicker ?: "")
                    .setSecurityType(row.securityType.toProto())
                    .setPricingLocus(row.pricingLocus.toProto())
            )
        }
        return builder.build()
    }

    override suspend fun addSecurity(request: AddSecurityRequest): AddSecurityResponse {
        val portfolioId = portfolio()
        val ticker = symbolOf(request.ticker)
        val currency = try {
            CurrencyUnit.parse(request.currencyCode)
        } catch (e: IllegalArgumentException) {
            throw invalid("unknown currency code \"${request.currencyCode}\"")
        }
        // Validate the optional profile before anything is written.
        val locus = when (request.pricingLocus) {
            PricingLocusProto.PRICING_LOCUS_UNSPECIFIED, PricingLocusProto.MANUAL -> PricingLocus.MANUAL
            PricingLocusProto.MARKET -> PricingLocus.MARKET
            else -> throw invalid("pricing locus must be MARKET or MANUAL")
        }
        val type = securityTypeOf(request.securityType)
        val marketTicker = marketTickerOf(request.marketTicker, locus, ticker)
        val cusip = cusipOf(request.cusip)
        val isin = isinOf(request.isin)
        val id = try {
            securities.create(portfolioId, ticker, currency)
        } catch (e: SQLException) {
            throw StatusException(
                Status.ALREADY_EXISTS.withDescription("a security with ticker \"$ticker\" already exists")
            )
        }
        securities.updateProfile(
            id, request.description.trim(), type, locus, TaxTreatment.LOTS, null,
            marketTicker, cusip, isin, null,
        )
        val row = checkNotNull(securities.find(id, portfolioId))
        return AddSecurityResponse.newBuilder().setSecurity(row.toProfile()).build()
    }

    /** The symbol: upper-cased, 1-32 of A-Z, 0-9, '.', '-'. A trust's
     *  made-up symbol and a real ticker obey the same rule. */
    private fun symbolOf(raw: String): String {
        val ticker = raw.trim().uppercase()
        if (ticker.isEmpty()) throw invalid("ticker is required")
        if (ticker.length > 32) throw invalid("ticker exceeds 32 characters")
        if (!SYMBOL.matches(ticker)) throw invalid("ticker \"$ticker\" may use only letters, digits, '.', and '-'")
        return ticker
    }

    private fun securityTypeOf(type: SecurityTypeProto): SecurityType = when (type) {
        SecurityTypeProto.SECURITY_TYPE_UNSPECIFIED -> SecurityType.UNKNOWN
        SecurityTypeProto.STOCK -> SecurityType.STOCK
        SecurityTypeProto.ETF -> SecurityType.ETF
        SecurityTypeProto.MUTUAL_FUND -> SecurityType.MUTUAL_FUND
        SecurityTypeProto.PRIVATE_INVESTMENT -> SecurityType.PRIVATE
        SecurityTypeProto.COLLECTIVE_TRUST -> SecurityType.COLLECTIVE_TRUST
        else -> throw invalid("unknown security type")
    }

    /** MARKET locus needs a provider symbol; blank means the symbol
     *  itself. MANUAL locus never carries one (nothing would use it). */
    private fun marketTickerOf(raw: String, locus: PricingLocus, symbol: String): String? {
        if (locus != PricingLocus.MARKET) return null
        val ticker = raw.trim().uppercase().ifEmpty { symbol }
        if (ticker.length > 32) throw invalid("market ticker exceeds 32 characters")
        if (!SYMBOL.matches(ticker)) throw invalid("market ticker \"$ticker\" may use only letters, digits, '.', and '-'")
        return ticker
    }

    private fun cusipOf(raw: String): String? {
        val cusip = raw.trim().uppercase()
        if (cusip.isEmpty()) return null
        if (!CUSIP.matches(cusip)) throw invalid("CUSIP \"$cusip\" must be 9 letters or digits")
        return cusip
    }

    private fun isinOf(raw: String): String? {
        val isin = raw.trim().uppercase()
        if (isin.isEmpty()) return null
        if (!ISIN.matches(isin)) throw invalid("ISIN \"$isin\" must be 2 letters, 9 letters or digits, and a check digit")
        return isin
    }

    /** A mirror must be another security of this portfolio, in the same
     *  currency, and not itself a mirror (one hop, no chains). */
    private fun mirrorOf(raw: Long, row: SecurityRow): SecurityId? {
        if (raw == 0L) return null
        val target = securities.find(SecurityId(raw), portfolio())
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no security $raw to mirror"))
        if (target.id == row.id) throw invalid("${row.ticker} cannot mirror itself")
        if (target.mirrorsSecurityId != null) {
            throw invalid("${target.ticker} is itself a mirror of another security; mirror that one instead")
        }
        if (target.currency != row.currency) {
            throw invalid("${target.ticker} is ${target.currency} but ${row.ticker} is ${row.currency}")
        }
        return target.id
    }

    override suspend fun getSecurityDetails(request: GetSecurityDetailsRequest): GetSecurityDetailsResponse {
        val row = findSecurity(request.securityId)
        // MANUAL locus: hand-entered history (adjusted = raw); MARKET
        // locus: persisted provider bars, refreshed when stale.
        val raw = pricing.history(row)
        // Constant-dollar presentation (spec sec. 5.7): both series convert
        // to today's dollars; the chart and the indicators use the same
        // adjusted series -- one consistent direction.
        val points = if (!request.inflationAdjusted) raw else {
            val cpi = cpiSeries() ?: throw StatusException(
                Status.FAILED_PRECONDITION.withDescription("CPI data is not loaded yet")
            )
            val today = LocalDate.now()
            try {
                raw.map {
                    PricingService.HistoryPoint(
                        it.date,
                        cpi.convert(it.close, it.date, today),
                        cpi.convert(it.adjustedClose, it.date, today),
                    )
                }
            } catch (e: IllegalArgumentException) {
                throw StatusException(
                    Status.FAILED_PRECONDITION.withDescription(e.message ?: "CPI coverage error")
                )
            }
        }
        val builder = GetSecurityDetailsResponse.newBuilder().setSecurity(row.toProfile())
        for (point in points) {
            builder.addPriceHistory(
                PricePoint.newBuilder()
                    .setDate(point.date.toProto())
                    .setClose(point.close.toProto().amount)
                    .setAdjustedClose(point.adjustedClose.toProto().amount)
            )
        }
        // Indicators run over the adjusted-close series (spec sec. 5.8).
        val history = points.map { ClosePoint(it.date, it.adjustedClose) }
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
        val type = securityTypeOf(request.securityType)
        val treatment = when (request.taxTreatment) {
            // Absent on the wire keeps the stored default (LOTS) - 
            // pre-sec. 11 clients never sent the field.
            TaxTreatmentProto.TAX_TREATMENT_UNSPECIFIED, TaxTreatmentProto.LOTS -> TaxTreatment.LOTS
            TaxTreatmentProto.MARK_TO_MARKET -> TaxTreatment.MARK_TO_MARKET
            else -> throw invalid("unknown tax treatment")
        }
        // Guard (build-scope sec. 11): the election cannot be reverted
        // while its marks exist - the ledger would silently lose its
        // meaning.
        if (row.taxTreatment == TaxTreatment.MARK_TO_MARKET &&
            treatment == TaxTreatment.LOTS && mtmMarksExist(row)
        ) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "${row.ticker} has recorded mark-to-market marks; delete them before reverting to lot treatment"
                )
            )
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
        // Presence-tracked fields: absent keeps the stored value.
        val marketTicker = marketTickerOf(
            if (request.hasMarketTicker()) request.marketTicker else (row.marketTicker ?: ""),
            locus, row.ticker,
        )
        val cusip = if (request.hasCusip()) cusipOf(request.cusip) else row.cusip
        val isin = if (request.hasIsin()) isinOf(request.isin) else row.isin
        val mirrors = if (request.hasMirrorsSecurityId()) mirrorOf(request.mirrorsSecurityId, row) else row.mirrorsSecurityId
        if (mirrors != null && securities.isMirrored(row.id)) {
            throw invalid("${row.ticker} is mirrored by another security and cannot mirror one itself")
        }
        securities.updateProfile(
            row.id, request.description.trim(), type, locus, treatment, ratio,
            marketTicker, cusip, isin, mirrors,
        )
        return UpdateSecurityProfileResponse.getDefaultInstance()
    }

    private fun mtmMarksExist(row: SecurityRow): Boolean = mtm.listForSecurity(row).isNotEmpty()

    override suspend fun setSecurityHidden(request: SetSecurityHiddenRequest): SetSecurityHiddenResponse {
        val row = findSecurity(request.securityId)
        // Guard rail (sec. 5.9): hiding requires no open lots - approximated
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
                "unknown classification kind \"${request.kind}\" - known: " +
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
        // Weights must sum to 1 (+/-0.0001) - spec sec. 5.9.
        val sum = weights.values.fold(Fraction.ZERO) { acc, w -> acc + w }
        if ((sum - Fraction.ONE).abs() > WEIGHT_SUM_TOLERANCE) {
            throw invalid("weights sum to $sum; they must sum to 1 (+/-0.0001)")
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
                    .setSource(price.source)
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

    override suspend fun listMtmMarks(request: ListMtmMarksRequest): ListMtmMarksResponse {
        val row = findSecurity(request.securityId)
        val builder = ListMtmMarksResponse.newBuilder()
            .setAcquisitionCostUsd(mtm.acquisitionCostUsd(portfolio(), row).toFormatted())
        for (mark in mtm.listForSecurity(row)) {
            builder.addMarks(mark.toProto(mark.id.value))
        }
        return builder.build()
    }

    override suspend fun suggestMtmMark(request: SuggestMtmMarkRequest): SuggestMtmMarkResponse {
        val row = findSecurity(request.securityId)
        val taxYear = validTaxYear(request.taxYear)
        val suggestion = mtm.suggest(portfolio(), row, taxYear)
        val builder = SuggestMtmMarkResponse.newBuilder().addAllNotes(suggestion.notes)
        val preview = suggestion.computed?.toProto(markId = 0)
            ?: MtmMarkProto.newBuilder()
                .setTaxYear(taxYear)
                .setMarkDate(suggestion.markDate.toFormattedDate())
                .setQuantity(suggestion.quantity.toFormatted())
                .apply {
                    suggestion.fmvLocal?.let { setFmvLocal(it.toFormatted()) }
                    suggestion.fxRate?.let { setFxRate(it.toFormattedRate()) }
                }
                .build()
        return builder.setPreview(preview).build()
    }

    override suspend fun recordMtmMark(request: RecordMtmMarkRequest): RecordMtmMarkResponse {
        val row = findSecurity(request.securityId)
        val taxYear = validTaxYear(request.taxYear)
        val markDate = try {
            request.markDate.toLocalDate()
        } catch (e: DateTimeException) {
            throw invalid("mark date is not a valid date")
        }
        val recorded = mtm.record(
            portfolio(), row, taxYear, markDate,
            parseMarkQuantity(request.quantity.value),
            parseMarkFmv(request.fmvLocal.value, row),
            parseMarkFxRate(request.fxRate.value),
        )
        return RecordMtmMarkResponse.newBuilder()
            .setMark(recorded.toProto(recorded.id.value))
            .build()
    }

    override suspend fun updateMtmMark(request: UpdateMtmMarkRequest): UpdateMtmMarkResponse {
        if (request.markId <= 0) throw invalid("mark id is required")
        val portfolioId = portfolio()
        val markId = MtmMarkId(request.markId)
        val row = securityOfMark(markId)
        val markDate = try {
            request.markDate.toLocalDate()
        } catch (e: DateTimeException) {
            throw invalid("mark date is not a valid date")
        }
        val updated = mtm.update(
            portfolioId, row, markId, markDate,
            parseMarkQuantity(request.quantity.value),
            parseMarkFmv(request.fmvLocal.value, row),
            parseMarkFxRate(request.fxRate.value),
        )
        return UpdateMtmMarkResponse.newBuilder()
            .setMark(updated.toProto(updated.id.value))
            .build()
    }

    private fun securityOfMark(markId: MtmMarkId): SecurityRow {
        val securityId = mtm.markSecurityId(portfolio(), markId)
        return findSecurity(securityId.value)
    }

    private fun parseMarkQuantity(raw: String): Quantity = try {
        Quantity.of(raw.trim())
    } catch (e: Exception) {
        throw invalid("quantity is not a valid share count: \"$raw\"")
    }

    private fun parseMarkFmv(raw: String, security: SecurityRow): Money = try {
        Money.of(raw.trim(), security.currency)
    } catch (e: Exception) {
        throw invalid("FMV is not a valid amount: \"$raw\"")
    }

    private fun parseMarkFxRate(raw: String): BigDecimal = try {
        BigDecimal(raw.trim())
    } catch (e: Exception) {
        throw invalid("FX rate is not a valid decimal: \"$raw\"")
    }

    override suspend fun deleteMtmMark(request: DeleteMtmMarkRequest): DeleteMtmMarkResponse {
        if (request.markId <= 0) throw invalid("mark id is required")
        mtm.delete(portfolio(), MtmMarkId(request.markId))
        return DeleteMtmMarkResponse.getDefaultInstance()
    }

    private fun validTaxYear(raw: Int): Int {
        if (raw < 1900 || raw > 2200) throw invalid("tax year $raw is out of range")
        return raw
    }

    private fun net.stewart.finance.db.MtmMarkRecord.toProto(markId: Long): MtmMarkProto =
        MtmMarkProto.newBuilder()
            .setMarkId(markId)
            .setTaxYear(taxYear)
            .setMarkDate(markDate.toFormattedDate())
            .setQuantity(quantity.toFormatted())
            .setFmvLocal(fmvLocal.toFormatted())
            .setFxRate(fxRate.toFormattedRate())
            .setFmvUsd(fmvUsd.toFormatted())
            .setBasisBefore(basisBeforeUsd.toFormatted())
            .setBasisAfter(basisAfterUsd.toFormatted())
            .setOrdinaryIncome(ordinaryIncomeUsd.toFormatted())
            .build()

    private fun BigDecimal.toFormattedRate(): net.stewart.finance.proto.FormattedDecimal =
        net.stewart.finance.proto.FormattedDecimal.newBuilder()
            .setExact(net.stewart.finance.proto.Decimal.newBuilder().setValue(toPlainString()))
            .setDisplay(stripTrailingZeros().toPlainString())
            .setSortKey(toDouble())
            .build()

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
            .setTaxTreatment(taxTreatment.toProto())
            .setHidden(hidden)
        netExpenseRatio?.let { builder.setNetExpenseRatio(it.toFormattedPercent()) }
        marketTicker?.let { builder.setMarketTicker(it) }
        cusip?.let { builder.setCusip(it) }
        isin?.let { builder.setIsin(it) }
        mirrorsSecurityId?.let { mirror ->
            builder.setMirrorsSecurityId(mirror.value)
            securities.find(mirror, portfolio())?.let { builder.setMirrorsTicker(it.ticker) }
        }
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

    private companion object {
        val SYMBOL = Regex("[A-Z0-9.-]{1,32}")
        val CUSIP = Regex("[A-Z0-9]{9}")
        val ISIN = Regex("[A-Z]{2}[A-Z0-9]{9}[0-9]")
    }

    private fun findSecurity(raw: Long): SecurityRow {
        if (raw <= 0) throw invalid("security id is required")
        return securities.find(SecurityId(raw), portfolio())
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no security $raw"))
    }

    private fun manualSecurity(raw: Long): SecurityRow {
        val row = findSecurity(raw)
        // Spec sec. 5.6: manual price CRUD is rejected for MARKET-locus
        // securities - their prices come from the provider.
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
