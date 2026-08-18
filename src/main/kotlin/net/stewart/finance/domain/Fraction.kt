package net.stewart.finance.domain

import java.math.BigDecimal

/**
 * A unitless fraction — a classification weight, a portfolio share, the
 * result of dividing money by money (the only sanctioned money÷money
 * operation). Not restricted to [0, 1]: drift and delta math produce
 * values outside that range.
 *
 * Fixed scale 4 (docs/design/initial-build-scope.md §2); the spec's
 * ±0.0001 tolerances are one unit in the last place of this type.
 */
class Fraction private constructor(val value: BigDecimal) : Comparable<Fraction> {

    operator fun plus(other: Fraction): Fraction = Fraction(
        (value + other.value).atExactScale(SCALE, MAX_INTEGER_DIGITS, "fraction")
    )

    operator fun minus(other: Fraction): Fraction = Fraction(
        (value - other.value).atExactScale(SCALE, MAX_INTEGER_DIGITS, "fraction")
    )

    operator fun unaryMinus(): Fraction = Fraction(value.negate())

    /** Product of two fractions, HALF_EVEN back to scale 4. */
    operator fun times(other: Fraction): Fraction =
        Fraction((value * other.value).atRoundedScale(SCALE, MAX_INTEGER_DIGITS, "fraction"))

    /** The portion [this] of [money]; HALF_EVEN to money scale. */
    operator fun times(money: Money): Money = money * this

    fun abs(): Fraction = if (value.signum() < 0) -this else this

    fun isZero(): Boolean = value.signum() == 0

    fun signum(): Int = value.signum()

    override fun compareTo(other: Fraction): Int = value.compareTo(other.value)

    /** Exact decimal string at scale 4 for the proto boundary. */
    fun toWire(): String = value.toPlainString()

    override fun toString(): String = value.toPlainString()

    override fun equals(other: Any?): Boolean = other is Fraction && value == other.value

    override fun hashCode(): Int = value.hashCode()

    companion object {
        const val SCALE = 4
        private const val MAX_INTEGER_DIGITS = 16

        /** Exact construction: more than [SCALE] decimal places is an error. */
        fun of(value: BigDecimal): Fraction =
            Fraction(value.atExactScale(SCALE, MAX_INTEGER_DIGITS, "fraction"))

        fun of(value: String): Fraction = of(BigDecimal(value))

        /** Explicit-rounding construction (HALF_EVEN), for provider values only. */
        fun rounded(value: BigDecimal): Fraction =
            Fraction(value.atRoundedScale(SCALE, MAX_INTEGER_DIGITS, "fraction"))

        /** Strict parse of a wire decimal string. */
        fun fromWire(value: String): Fraction = of(BigDecimal(value))

        val ZERO: Fraction = of(BigDecimal.ZERO)
        val ONE: Fraction = of(BigDecimal.ONE)
    }
}
