package net.stewart.finance.api

import java.math.BigDecimal
import java.math.MathContext
import java.time.LocalDate
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.proto.Decimal
import net.stewart.finance.proto.Sparkline
import net.stewart.finance.proto.SparklineDot

/** One close in a sparkline window. */
data class DatedPrice(val date: LocalDate, val price: Money)

/**
 * The table-cell trend (spec sec. 9.17), with a borrowed shape for a
 * security that cannot draw its own: a 401(k) trust has a handful of
 * statement prices a year, so when it mirrors a public fund whose
 * window has more points than its own, the sparkline carries the
 * mirror's closes - flagged by `proxy_ticker` so the UI draws it
 * dashed and captions it - and the trust's own observations ride
 * along as dots, placed by date and rescaled into the mirror's price
 * level by the same median-ratio alignment the details chart uses.
 * Presentation geometry only: nothing here is ever summed.
 */
object Sparklines {

    fun build(
        security: SecurityRow,
        series: Map<SecurityId, List<DatedPrice>>,
        securitiesById: Map<SecurityId, SecurityRow>,
    ): Sparkline {
        val own = series[security.id].orEmpty()
        val mirror = security.mirrorsSecurityId?.let { securitiesById[it] }
        val borrowed = mirror?.let { series[it.id].orEmpty() }.orEmpty()
        if (mirror == null || borrowed.size <= own.size) {
            return Sparkline.newBuilder()
                .addAllAdjustedCloses(own.map { it.price.toProto().amount })
                .build()
        }
        val builder = Sparkline.newBuilder()
            .addAllAdjustedCloses(borrowed.map { it.price.toProto().amount })
            .setProxyTicker(mirror.ticker)
            .setOwnPoints(own.size)
        scale(own, borrowed)?.let { ratio ->
            for (point in own) {
                val index = indexOnOrBefore(borrowed, point.date) ?: continue
                builder.addActuals(
                    SparklineDot.newBuilder()
                        .setIndex(index)
                        .setValue(Decimal.newBuilder().setValue(point.price.amount.divide(ratio, MathContext.DECIMAL64).stripTrailingZeros().toPlainString()))
                )
            }
        }
        return builder.build()
    }

    /** Median of own/borrowed over dates both have (a borrowed close on
     *  or before the own date counts); null when nothing overlaps. */
    private fun scale(own: List<DatedPrice>, borrowed: List<DatedPrice>): BigDecimal? {
        val ratios = own.mapNotNull { point ->
            val index = indexOnOrBefore(borrowed, point.date) ?: return@mapNotNull null
            val base = borrowed[index].price.amount
            if (base.signum() <= 0 || point.price.amount.signum() <= 0) null
            else point.price.amount.divide(base, MathContext.DECIMAL64)
        }.sorted()
        return ratios.getOrNull(ratios.size / 2)
    }

    /** The last borrowed close dated on or before [date]; null before the first. */
    private fun indexOnOrBefore(borrowed: List<DatedPrice>, date: LocalDate): Int? {
        var index = -1
        for ((i, point) in borrowed.withIndex()) {
            if (point.date.isAfter(date)) break
            index = i
        }
        return index.takeIf { it >= 0 }
    }
}
