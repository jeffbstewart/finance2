package net.stewart.finance.api

import io.grpc.Status
import io.grpc.StatusException
import java.time.LocalDate
import net.stewart.finance.db.MarketPriceRepository
import net.stewart.finance.db.PrivatePriceRepository
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.feeds.MarketData
import net.stewart.finance.feeds.PriceSourceException

/**
 * The one place services get prices (spec §5.6's public/private
 * split): MANUAL-locus securities price from hand-entered
 * private_prices; MARKET-locus from provider bars, refreshed through
 * [MarketData] when stale. Provider failure surfaces as UNAVAILABLE —
 * a request needing a price it cannot get fails (spec §5.2).
 */
class PricingService(
    private val privatePrices: PrivatePriceRepository,
    private val marketPrices: MarketPriceRepository,
    private val marketData: MarketData,
) {
    data class HistoryPoint(
        val date: LocalDate,
        val close: Money,
        val adjustedClose: Money,
    )

    /** Latest price per security; MARKET securities refresh first. */
    fun latestBySecurity(
        portfolioId: PortfolioId,
        securities: Collection<SecurityRow>,
    ): Map<SecurityId, Money> {
        securities.filter { it.pricingLocus == PricingLocus.MARKET }.forEach { ensureFresh(it) }
        return privatePrices.latestBySecurity(portfolioId) +
            marketPrices.latestBySecurity(portfolioId)
    }

    /** Date-ascending adjusted closes since [since], for sparklines. */
    fun sparklines(portfolioId: PortfolioId, since: LocalDate): Map<SecurityId, List<Money>> {
        val combined = linkedMapOf<SecurityId, List<Money>>()
        combined.putAll(privatePrices.recentBySecurity(portfolioId, since))
        combined.putAll(marketPrices.recentAdjustedBySecurity(portfolioId, since))
        return combined
    }

    /** Full date-ascending history; adjusted = raw for MANUAL (spec §5.6). */
    fun history(security: SecurityRow): List<HistoryPoint> = when (security.pricingLocus) {
        PricingLocus.MANUAL ->
            privatePrices.history(security.id).map { HistoryPoint(it.date, it.price, it.price) }
        PricingLocus.MARKET -> {
            ensureFresh(security)
            marketPrices.history(security.id).map { HistoryPoint(it.date, it.close, it.adjustedClose) }
        }
    }

    private fun ensureFresh(security: SecurityRow) {
        try {
            marketData.ensureFresh(security)
        } catch (e: PriceSourceException) {
            throw StatusException(
                Status.UNAVAILABLE.withDescription(
                    e.message ?: "market data providers are unavailable"
                )
            )
        }
    }
}
