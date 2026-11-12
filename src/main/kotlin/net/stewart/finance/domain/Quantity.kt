package net.stewart.finance.domain

import java.math.BigDecimal

/**
 * A count of units held - shares, fund units, troy ounces. Unitless and
 * currency-free; multiplying by a per-unit [Money] price yields value.
 *
 * Fixed scale 8 (docs/design/initial-build-scope.md sec. 2), so provider
 * fractional-share quantities import without rounding. Values fit a
 * `NUMERIC(20,8)` column by construction.
 */
class Quantity private constructor(val amount: BigDecimal) : Comparable<Quantity> {

    operator fun plus(other: Quantity): Quantity = Quantity(
        (amount + other.amount).atExactScale(SCALE, MAX_INTEGER_DIGITS, "quantity")
    )

    operator fun minus(other: Quantity): Quantity = Quantity(
        (amount - other.amount).atExactScale(SCALE, MAX_INTEGER_DIGITS, "quantity")
    )

    operator fun unaryMinus(): Quantity = Quantity(amount.negate())

    /** Value of this many units at [price] per unit; HALF_EVEN to money scale. */
    operator fun times(price: Money): Money = price * this

    /**
     * The unitless ratio of this quantity to [other] (e.g. the fraction
     * of a lot still held), HALF_EVEN to fraction scale. [other] must be
     * non-zero.
     */
    operator fun div(other: Quantity): Fraction =
        Fraction.of(amount.divide(other.amount, Fraction.SCALE, java.math.RoundingMode.HALF_EVEN))

    fun abs(): Quantity = if (amount.signum() < 0) -this else this

    fun isZero(): Boolean = amount.signum() == 0

    fun signum(): Int = amount.signum()

    override fun compareTo(other: Quantity): Int = amount.compareTo(other.amount)

    /** Exact decimal string at scale 8 for the proto boundary. */
    fun toWire(): String = amount.toPlainString()

    override fun toString(): String = amount.toPlainString()

    override fun equals(other: Any?): Boolean = other is Quantity && amount == other.amount

    override fun hashCode(): Int = amount.hashCode()

    companion object {
        const val SCALE = 8
        private const val MAX_INTEGER_DIGITS = 12

        /** Exact construction: more than [SCALE] decimal places is an error. */
        fun of(amount: BigDecimal): Quantity =
            Quantity(amount.atExactScale(SCALE, MAX_INTEGER_DIGITS, "quantity"))

        fun of(amount: String): Quantity = of(BigDecimal(amount))

        /** Explicit-rounding construction (HALF_EVEN), for provider values only. */
        fun rounded(amount: BigDecimal): Quantity =
            Quantity(amount.atRoundedScale(SCALE, MAX_INTEGER_DIGITS, "quantity"))

        /** Strict parse of a wire decimal string. */
        fun fromWire(value: String): Quantity = of(BigDecimal(value))

        val ZERO: Quantity = of(BigDecimal.ZERO)
    }
}
