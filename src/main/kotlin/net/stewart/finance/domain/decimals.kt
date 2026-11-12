package net.stewart.finance.domain

import java.math.BigDecimal
import java.math.RoundingMode

// The numeric policy from docs/design/initial-build-scope.md sec. 2: every
// domain value lives at a fixed canonical scale, construction is strict
// (excess decimal places are an error, not a silent round), rounding
// happens only where an operation's contract declares HALF_EVEN, and
// integer digits are capped so a value that would not fit the NUMERIC
// column fails at construction, not at the database write.

/** Normalizes to [scale], rejecting values with more decimal places. */
internal fun BigDecimal.atExactScale(scale: Int, maxIntegerDigits: Int, what: String): BigDecimal {
    val scaled = try {
        setScale(scale, RoundingMode.UNNECESSARY)
    } catch (e: ArithmeticException) {
        throw ArithmeticException("$what $this has more than $scale decimal places")
    }
    return scaled.guardIntegerDigits(maxIntegerDigits, what)
}

/** Rounds HALF_EVEN to [scale]. */
internal fun BigDecimal.atRoundedScale(scale: Int, maxIntegerDigits: Int, what: String): BigDecimal =
    setScale(scale, RoundingMode.HALF_EVEN).guardIntegerDigits(maxIntegerDigits, what)

private fun BigDecimal.guardIntegerDigits(max: Int, what: String): BigDecimal {
    if (precision() - scale() > max) {
        throw ArithmeticException("$what $this overflows $max integer digits")
    }
    return this
}
