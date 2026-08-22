package net.stewart.finance.domain

import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

/**
 * An exact amount of one currency. Fixed scale 4
 * (docs/design/initial-build-scope.md sec. 2); values fit a `NUMERIC(20,4)`
 * column by construction.
 *
 * Arithmetic policy: addition and subtraction are exact and require the
 * same currency ([CurrencyMismatchException] otherwise). Multiplication
 * by a [Quantity] or [Fraction] and every division round HALF_EVEN to
 * the result's canonical scale - the only places rounding occurs.
 * Division by money yields a unitless [Fraction] and is the only
 * sanctioned money/money operation; division by zero throws
 * [ArithmeticException]. There is no conversion to or from binary
 * floating point.
 */
class Money private constructor(val amount: BigDecimal, val currency: CurrencyUnit) : Comparable<Money> {

    operator fun plus(other: Money): Money {
        requireSameCurrency(other, "add")
        return Money((amount + other.amount).atExactScale(SCALE, MAX_INTEGER_DIGITS, "money amount"), currency)
    }

    operator fun minus(other: Money): Money {
        requireSameCurrency(other, "subtract")
        return Money((amount - other.amount).atExactScale(SCALE, MAX_INTEGER_DIGITS, "money amount"), currency)
    }

    operator fun unaryMinus(): Money = Money(amount.negate(), currency)

    /** Value of [quantity] units at this price per unit; HALF_EVEN to scale 4. */
    operator fun times(quantity: Quantity): Money =
        Money((amount * quantity.amount).atRoundedScale(SCALE, MAX_INTEGER_DIGITS, "money amount"), currency)

    /** The portion [fraction] of this amount; HALF_EVEN to scale 4. */
    operator fun times(fraction: Fraction): Money =
        Money((amount * fraction.value).atRoundedScale(SCALE, MAX_INTEGER_DIGITS, "money amount"), currency)

    /**
     * The unitless ratio of this amount to [other] (same currency);
     * HALF_EVEN to fraction scale. [other] must be non-zero.
     */
    operator fun div(other: Money): Fraction {
        requireSameCurrency(other, "divide")
        return Fraction.of(amount.divide(other.amount, Fraction.SCALE, RoundingMode.HALF_EVEN))
    }

    /** Per-unit price of this total over [quantity] units; HALF_EVEN to scale 4. */
    operator fun div(quantity: Quantity): Money =
        Money(amount.divide(quantity.amount, SCALE, RoundingMode.HALF_EVEN), currency)

    /**
     * This amount scaled up to the whole it is [fraction] of (e.g. a
     * class value over its target fraction); HALF_EVEN to scale 4.
     * [fraction] must be non-zero.
     */
    operator fun div(fraction: Fraction): Money =
        Money(amount.divide(fraction.value, SCALE, RoundingMode.HALF_EVEN), currency)

    fun abs(): Money = if (amount.signum() < 0) -this else this

    fun isZero(): Boolean = amount.signum() == 0

    fun signum(): Int = amount.signum()

    /**
     * Splits this amount proportionally to [weights] without losing a
     * unit: the parts are each within one 0.0001 of their exact
     * proportional share and sum to exactly this amount (largest-
     * remainder distribution; ties broken toward earlier weights).
     * Weights must be non-negative with a positive sum.
     */
    fun allocateBy(weights: List<BigDecimal>): List<Money> {
        require(weights.isNotEmpty()) { "allocateBy requires at least one weight" }
        require(weights.all { it.signum() >= 0 }) { "negative weight in $weights" }
        val weightScale = weights.maxOf { maxOf(it.scale(), 0) }
        val intWeights = weights.map { it.movePointRight(weightScale).toBigIntegerExact() }
        val totalWeight = intWeights.fold(BigInteger.ZERO, BigInteger::add)
        require(totalWeight.signum() > 0) { "weights must not sum to zero" }

        val totalUnits = amount.abs().movePointRight(SCALE).toBigIntegerExact()
        val units = ArrayList<BigInteger>(intWeights.size)
        val remainders = ArrayList<BigInteger>(intWeights.size)
        for (w in intWeights) {
            val quotientAndRemainder = (totalUnits * w).divideAndRemainder(totalWeight)
            units.add(quotientAndRemainder[0])
            remainders.add(quotientAndRemainder[1])
        }
        var leftover = (totalUnits - units.fold(BigInteger.ZERO, BigInteger::add)).toInt()
        val byLargestRemainder = remainders.indices.sortedWith(
            compareByDescending<Int> { remainders[it] }.thenBy { it }
        )
        for (i in byLargestRemainder) {
            if (leftover == 0) break
            units[i] += BigInteger.ONE
            leftover--
        }
        val negative = amount.signum() < 0
        return units.map { u ->
            val part = BigDecimal(u, SCALE)
            of(if (negative) part.negate() else part, currency)
        }
    }

    override fun compareTo(other: Money): Int {
        requireSameCurrency(other, "compare")
        return amount.compareTo(other.amount)
    }

    /** Exact decimal string at scale 4 for the proto boundary; currency travels beside it. */
    fun toWire(): String = amount.toPlainString()

    /**
     * Accounting display: currency symbol, comma grouping, 2-4 decimal
     * places, negatives in parentheses - e.g. `($1,234.5678)`.
     */
    fun display(): String {
        val format = DecimalFormat("#,##0.00##", DecimalFormatSymbols(Locale.US))
        val body = currency.symbol + format.format(amount.abs())
        return if (amount.signum() < 0) "($body)" else body
    }

    override fun toString(): String = "$currency ${amount.toPlainString()}"

    override fun equals(other: Any?): Boolean =
        other is Money && currency == other.currency && amount == other.amount

    override fun hashCode(): Int = 31 * currency.hashCode() + amount.hashCode()

    private fun requireSameCurrency(other: Money, verb: String) {
        if (currency != other.currency) {
            throw CurrencyMismatchException(
                "cannot $verb $currency and ${other.currency} without an explicit FX conversion"
            )
        }
    }

    companion object {
        const val SCALE = 4
        private const val MAX_INTEGER_DIGITS = 16

        /** Exact construction: more than [SCALE] decimal places is an error. */
        fun of(amount: BigDecimal, currency: CurrencyUnit): Money =
            Money(amount.atExactScale(SCALE, MAX_INTEGER_DIGITS, "money amount"), currency)

        fun of(amount: String, currency: CurrencyUnit): Money = of(BigDecimal(amount), currency)

        /** Explicit-rounding construction (HALF_EVEN), for provider values only. */
        fun rounded(amount: BigDecimal, currency: CurrencyUnit): Money =
            Money(amount.atRoundedScale(SCALE, MAX_INTEGER_DIGITS, "money amount"), currency)

        /** Strict parse of a wire decimal string. */
        fun fromWire(value: String, currency: CurrencyUnit): Money = of(BigDecimal(value), currency)

        fun zero(currency: CurrencyUnit): Money = of(BigDecimal.ZERO, currency)

        /**
         * Parses user-entered money text: bare `1234.56`, symbol-prefixed
         * `$1,234.56`, accounting negatives `($1,234.56)`, and a leading
         * minus. More than [SCALE] decimal places, mixed negation styles,
         * or anything else malformed is an error.
         */
        fun parse(text: String, currency: CurrencyUnit = CurrencyUnit.USD): Money {
            var t = text.trim()
            var negative = false
            if (t.length >= 2 && t.startsWith("(") && t.endsWith(")")) {
                negative = true
                t = t.substring(1, t.length - 1).trim()
            }
            if (t.startsWith("-")) {
                if (negative) throw NumberFormatException("money text \"$text\" mixes (...) and - negation")
                negative = true
                t = t.substring(1).trim()
            }
            t = t.removePrefix(currency.symbol).replace(",", "")
            if (t.isEmpty()) throw NumberFormatException("money text \"$text\" has no amount")
            val magnitude = BigDecimal(t)
            if (magnitude.signum() < 0) throw NumberFormatException("money text \"$text\" has a misplaced sign")
            return of(if (negative) magnitude.negate() else magnitude, currency)
        }
    }
}
