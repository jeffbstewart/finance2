package net.stewart.finance.feeds

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.ConcurrentHashMap
import net.stewart.finance.db.MarketPriceRepository
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.domain.PricingLocus
import org.slf4j.LoggerFactory

/** How far back the "recent" fetch depth reaches (spec §6.1: ~1 month,
 *  with margin for downtime). */
private const val RECENT_DAYS = 45L

/**
 * The market-data module of spec §6.1, minus the daemon: DB-persisted
 * caching with a multi-hour TTL, per-security request coalescing,
 * gentle per-provider request spacing, and typed-quota failover
 * through the Decision 4 provider chain (Tiingo, then EODHD).
 *
 * With no providers configured (no API keys in .env) the module is
 * dormant: nothing fetches, MARKET securities simply have whatever
 * bars the table already holds.
 */
class MarketData(
    private val repo: MarketPriceRepository,
    private val sources: List<PriceSource>,
    private val ttl: Duration = Duration.ofHours(12),
    private val requestSpacing: Duration = Duration.ofMillis(1200),
) {
    private val log = LoggerFactory.getLogger(MarketData::class.java)
    private val perSecurityLocks = ConcurrentHashMap<Long, Any>()
    private val lastRequestAt = ConcurrentHashMap<MarketSourceKey, Long>()

    private data class MarketSourceKey(val name: String)

    /**
     * Ensures the security's bars are fresh (fetched within [ttl]).
     * First-ever fetch pulls full history; later ones pull the recent
     * window. Concurrent callers for the same security coalesce onto
     * one upstream fetch. No-op for MANUAL-locus securities and when
     * no provider is configured.
     */
    fun ensureFresh(security: SecurityRow) {
        if (security.pricingLocus != PricingLocus.MARKET || sources.isEmpty()) return
        if (isFresh(security)) return
        val lock = perSecurityLocks.computeIfAbsent(security.id.value) { Any() }
        synchronized(lock) {
            if (isFresh(security)) return // a coalesced caller already fetched
            val startDate = if (repo.hasAny(security.id)) {
                LocalDate.now().minusDays(RECENT_DAYS)
            } else {
                null // full history on first acquaintance
            }
            var lastFailure: Exception? = null
            for (source in sources) {
                try {
                    space(source)
                    val bars = source.dailyBars(security.ticker, startDate)
                    repo.upsertBars(security.id, bars, source.id)
                    log.info(
                        "{}: {} bars for {} from {}",
                        source.id, bars.size, security.ticker, startDate ?: "inception"
                    )
                    return
                } catch (e: QuotaExceededException) {
                    log.warn("{} quota exceeded for {}; trying next provider", source.id, security.ticker)
                    lastFailure = e
                } catch (e: PriceSourceException) {
                    log.warn("{} failed for {}; trying next provider", source.id, security.ticker, e)
                    lastFailure = e
                }
            }
            throw PriceSourceException(
                "every provider failed for ${security.ticker}", lastFailure
            )
        }
    }

    /** Background prefetch: best-effort freshness for every given security. */
    fun refreshAll(securities: List<SecurityRow>) {
        for (security in securities) {
            runCatching { ensureFresh(security) }
                .onFailure { log.warn("prefetch failed for {}", security.ticker, it) }
        }
    }

    private fun isFresh(security: SecurityRow): Boolean {
        val fetchedAt = repo.lastFetchedAt(security.id) ?: return false
        return fetchedAt.isAfter(Instant.now().minus(ttl))
    }

    /** Minimal provider courtesy: successive requests to one provider
     *  are spaced by [requestSpacing] (spec §6.1 rate limiting — the
     *  cache keeps volume so low that spacing is all that is needed). */
    private fun space(source: PriceSource) {
        val key = MarketSourceKey(source.id.name)
        val now = System.currentTimeMillis()
        val previous = lastRequestAt.put(key, now) ?: return
        val wait = requestSpacing.toMillis() - (now - previous)
        if (wait > 0) {
            Thread.sleep(wait)
            lastRequestAt[key] = System.currentTimeMillis()
        }
    }
}
