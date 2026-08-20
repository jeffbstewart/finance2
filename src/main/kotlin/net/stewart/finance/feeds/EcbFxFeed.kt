package net.stewart.finance.feeds

import java.io.StringReader
import java.math.BigDecimal
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.LocalDate
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import net.stewart.finance.db.FxRepository
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.RateSource
import org.slf4j.LoggerFactory
import org.w3c.dom.Element
import org.xml.sax.InputSource

/** ECB's rolling 90-day reference-rate history — enough backfill to
 *  ride out any realistic downtime of the always-running container. */
const val ECB_90_DAY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml"

/**
 * The EUR→USD reference rates by date from an ECB eurofxref XML
 * document. Rates parse as exact decimals — never floats.
 */
fun parseEcbUsdRates(xml: String): Map<LocalDate, BigDecimal> {
    val factory = DocumentBuilderFactory.newInstance().apply {
        // The feed needs no DTDs or external entities; forbid them.
        setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
        setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        isNamespaceAware = false
    }
    val document = factory.newDocumentBuilder().parse(InputSource(StringReader(xml)))
    val result = linkedMapOf<LocalDate, BigDecimal>()
    val cubes = document.getElementsByTagName("Cube")
    for (i in 0 until cubes.length) {
        val dayCube = cubes.item(i) as Element
        val time = dayCube.getAttribute("time").takeIf { it.isNotEmpty() } ?: continue
        val date = LocalDate.parse(time)
        val children = dayCube.getElementsByTagName("Cube")
        for (j in 0 until children.length) {
            val rateCube = children.item(j) as Element
            if (rateCube.getAttribute("currency") == "USD") {
                result[date] = BigDecimal(rateCube.getAttribute("rate"))
            }
        }
    }
    require(result.isNotEmpty()) { "no USD rates found in ECB document" }
    return result
}

/**
 * Fetches ECB reference rates and persists EUR→USD into fx_rates
 * (MERGE — reruns are idempotent). The ECB publishes ~30 currencies;
 * only the pair the portfolio needs is stored today, and extending is
 * a matter of persisting more of the parsed document.
 */
class EcbFxFeed(
    private val fx: FxRepository,
    private val fetch: () -> String = { httpGet(ECB_90_DAY_URL) },
) {
    private val log = LoggerFactory.getLogger(EcbFxFeed::class.java)

    fun refresh() {
        val rates = parseEcbUsdRates(fetch())
        for ((date, usdPerEur) in rates) {
            fx.upsert(CurrencyUnit.EUR, CurrencyUnit.USD, date, usdPerEur, RateSource.ECB)
        }
        log.info("ECB FX refresh: {} EUR->USD rates through {}", rates.size, rates.keys.max())
    }
}

internal fun httpGet(url: String): String {
    val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(20)).build()
    val response = client.send(
        HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(60)).GET().build(),
        HttpResponse.BodyHandlers.ofString(),
    )
    check(response.statusCode() == 200) { "GET $url returned ${response.statusCode()}" }
    return response.body()
}
