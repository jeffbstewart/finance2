package net.stewart.finance.feeds

import net.stewart.finance.db.CpiRepository
import net.stewart.finance.rules.CpiSeries
import net.stewart.finance.rules.parseFredCsvPoints
import org.slf4j.LoggerFactory

/** FRED's CSV export of the CPIAUCSL series (public domain; see NOTICE). */
const val FRED_CPIAUCSL_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL"

/** Classpath location of the embedded snapshot (spec sec. 10: the server
 *  must start, CPI included, without internet access). */
const val CPI_SNAPSHOT_RESOURCE = "/cpi/CPIAUCSL.csv"

/**
 * Keeps cpi_observations populated: seeded once from the embedded
 * snapshot, refreshed from FRED in the background (monthly data - a
 * weekly pull is plenty). Fixes the legacy fetch-once-and-die-offline
 * defect 13 by construction.
 */
class CpiFeed(
    private val cpi: CpiRepository,
    private val fetch: () -> String = { httpGet(FRED_CPIAUCSL_URL) },
) {
    private val log = LoggerFactory.getLogger(CpiFeed::class.java)

    /** Loads the embedded snapshot when the table is empty (first boot). */
    fun seedIfEmpty() {
        if (!cpi.isEmpty()) return
        val csv = checkNotNull(javaClass.getResourceAsStream(CPI_SNAPSHOT_RESOURCE)) {
            "embedded CPI snapshot missing: $CPI_SNAPSHOT_RESOURCE"
        }.bufferedReader().readText()
        val points = parseFredCsvPoints(csv)
        cpi.upsertAll(points)
        log.info("CPI seeded from embedded snapshot: {}..{}", points.keys.min(), points.keys.max())
    }

    fun refresh() {
        val points = parseFredCsvPoints(fetch())
        cpi.upsertAll(points)
        log.info("CPI refreshed from FRED: {}..{}", points.keys.min(), points.keys.max())
    }

    /** The persisted series, or null before any seed (degraded mode). */
    fun series(): CpiSeries? {
        val observations = cpi.loadAll()
        return if (observations.isEmpty()) null else CpiSeries(observations)
    }
}
