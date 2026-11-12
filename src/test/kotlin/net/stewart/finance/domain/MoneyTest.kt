package net.stewart.finance.domain

import io.kotest.property.Arb
import io.kotest.property.arbitrary.filter
import io.kotest.property.arbitrary.list
import io.kotest.property.arbitrary.long
import io.kotest.property.arbitrary.map
import io.kotest.property.checkAll
import kotlinx.coroutines.runBlocking
import java.math.BigDecimal
import java.math.MathContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

// The property suite is the product of the Phase 2 audit of the legacy
// Go fixed-point type (MODERNIZATION.md Phase 2): it pins down exactly
// the behaviors the legacy type got wrong - truncation instead of a
// declared rounding mode, float64 leaking into "fixed" math via
// MulFloat/QuoFloat, sign-flip overflow heuristics that miss, and
// ad-hoc apportionment that lost pennies.

private val USD = CurrencyUnit.USD
private val EUR = CurrencyUnit.EUR

private fun usd(s: String) = Money.of(s, USD)

/** Money at scale 4 with up to 10 integer digits. */
private fun arbMoney(currency: CurrencyUnit = USD): Arb<Money> =
    Arb.long(-99_999_999_999_999L..99_999_999_999_999L)
        .map { Money.of(BigDecimal.valueOf(it, 4), currency) }

/** 1-8 non-negative weights, not all zero, at scale 2. */
private val arbWeights: Arb<List<BigDecimal>> =
    Arb.list(Arb.long(0L..1_000_000L), 1..8)
        .filter { list -> list.any { it > 0L } }
        .map { list -> list.map { BigDecimal.valueOf(it, 2) } }

class MoneyTest {

    // --- construction ---

    @Test
    fun `of normalizes to scale 4`() {
        assertEquals("1.5000", usd("1.5").toWire())
        assertEquals("0.0000", usd("0").toWire())
        assertEquals("-12.3456", usd("-12.3456").toWire())
    }

    @Test
    fun `of rejects excess decimal places`() {
        assertFailsWith<ArithmeticException> { usd("1.00001") }
    }

    @Test
    fun `of enforces the NUMERIC column bound`() {
        usd("9999999999999999.9999") // 16 integer digits: the limit
        assertFailsWith<ArithmeticException> { usd("10000000000000000.0000") }
    }

    @Test
    fun `rounded rounds half to even`() {
        assertEquals(usd("1.0000"), Money.rounded(BigDecimal("1.00005"), USD))
        assertEquals(usd("1.0002"), Money.rounded(BigDecimal("1.00015"), USD))
        assertEquals(usd("1.0002"), Money.rounded(BigDecimal("1.00019"), USD))
    }

    // --- arithmetic ---

    @Test
    fun `addition and subtraction are exact`() {
        assertEquals(usd("3.0001"), usd("1.0001") + usd("2.0000"))
        assertEquals(usd("-0.9999"), usd("1.0001") - usd("2.0000"))
    }

    @Test
    fun `cross-currency arithmetic throws`() {
        val eur = Money.of("1.00", EUR)
        assertFailsWith<CurrencyMismatchException> { usd("1.00") + eur }
        assertFailsWith<CurrencyMismatchException> { usd("1.00") - eur }
        assertFailsWith<CurrencyMismatchException> { usd("1.00") / eur }
        assertFailsWith<CurrencyMismatchException> { usd("1.00").compareTo(eur) }
    }

    @Test
    fun `price times quantity values a position`() {
        assertEquals(usd("37.0200"), usd("12.34") * Quantity.of("3"))
        // 0.0001 * 0.5 = 0.00005 -> HALF_EVEN at scale 4 -> 0.0000
        assertEquals(usd("0.0000"), usd("0.0001") * Quantity.of("0.5"))
    }

    @Test
    fun `money times fraction takes a portion`() {
        assertEquals(usd("25.0000"), usd("100") * Fraction.of("0.25"))
        // 99.9999 * 0.3333 = 33.32996667 -> HALF_EVEN at scale 4
        assertEquals(usd("33.3300"), usd("99.9999") * Fraction.of("0.3333"))
    }

    @Test
    fun `money over money yields a unitless fraction`() {
        assertEquals(Fraction.of("0.3333"), usd("1") / usd("3"))
        assertEquals(Fraction.of("2.0000"), usd("10") / usd("5"))
    }

    @Test
    fun `money over quantity yields a per-unit price`() {
        assertEquals(usd("3.3333"), usd("10") / Quantity.of("3"))
    }

    @Test
    fun `money over fraction scales up to the whole`() {
        // A class holding $500 at a 0.6 target implies an $833.33 total.
        assertEquals(usd("833.3333"), usd("500") / Fraction.of("0.6"))
        assertEquals(usd("200"), usd("50") / Fraction.of("0.25"))
    }

    @Test
    fun `division by zero throws`() {
        assertFailsWith<ArithmeticException> { usd("1") / usd("0") }
        assertFailsWith<ArithmeticException> { usd("1") / Quantity.ZERO }
        assertFailsWith<ArithmeticException> { usd("1") / Fraction.ZERO }
    }

    @Test
    fun `negation and abs`() {
        assertEquals(usd("-1.5"), -usd("1.5"))
        assertEquals(usd("1.5"), usd("-1.5").abs())
        assertEquals(0, Money.zero(USD).signum())
        assertTrue(Money.zero(USD).isZero())
    }

    // --- parsing (spec sec. 4.3 forms) ---

    @Test
    fun `parses the spec's accepted forms`() {
        assertEquals(usd("1234.56"), Money.parse("\$1,234.56"))
        assertEquals(usd("1234.56"), Money.parse("1234.56"))
        assertEquals(usd("-1234.56"), Money.parse("(\$1,234.56)"))
        assertEquals(usd("-12.34"), Money.parse("-\$12.34"))
        assertEquals(usd("-12.34"), Money.parse("(12.34)"))
        assertEquals(Money.of("1234.56", EUR), Money.parse("\u20ac1,234.56", EUR))
    }

    @Test
    fun `parse rejects malformed text`() {
        assertFailsWith<NumberFormatException> { Money.parse("") }
        assertFailsWith<NumberFormatException> { Money.parse("$") }
        assertFailsWith<NumberFormatException> { Money.parse("twelve") }
        assertFailsWith<NumberFormatException> { Money.parse("(-\$5.00)") }
        assertFailsWith<NumberFormatException> { Money.parse("\$-5.00") }
        assertFailsWith<ArithmeticException> { Money.parse("1.00001") }
    }

    // --- display (accounting format) ---

    @Test
    fun `displays accounting style`() {
        assertEquals("\$1,234.5678", usd("1234.5678").display())
        assertEquals("(\$1,234.56)", usd("-1234.56").display())
        assertEquals("\$0.10", usd("0.1").display())
        assertEquals("\$1,234.567", usd("1234.567").display())
        assertEquals("\$0.00", Money.zero(USD).display())
        assertEquals("\u20ac1,234.56", Money.of("1234.56", EUR).display())
    }

    // --- wire ---

    @Test
    fun `wire form is a fixed-scale decimal string`() {
        assertEquals("1234.5600", usd("1234.56").toWire())
        assertEquals(usd("1234.56"), Money.fromWire("1234.5600", USD))
    }

    // --- properties ---

    @Test
    fun `wire round-trip is lossless`() = runBlocking<Unit> {
        checkAll(arbMoney()) { m ->
            assertEquals(m, Money.fromWire(m.toWire(), m.currency))
        }
    }

    @Test
    fun `display round-trips through parse`() = runBlocking<Unit> {
        checkAll(arbMoney()) { m ->
            assertEquals(m, Money.parse(m.display(), m.currency))
        }
    }

    @Test
    fun `addition then subtraction is identity`() = runBlocking<Unit> {
        checkAll(arbMoney(), arbMoney()) { a, b ->
            assertEquals(a, a + b - b)
        }
    }

    // --- allocation (no penny lost) ---

    @Test
    fun `allocation is exhaustive and proportional`() = runBlocking<Unit> {
        checkAll(arbMoney(), arbWeights) { total, weights ->
            val parts = total.allocateBy(weights)
            assertEquals(weights.size, parts.size)
            // No penny lost: the parts sum to exactly the total.
            assertEquals(total, parts.reduce { a, b -> a + b })
            // Each part is within one 0.0001 of its exact proportional share.
            val weightSum = weights.reduce(BigDecimal::add)
            for ((part, weight) in parts.zip(weights)) {
                val ideal = total.amount.multiply(weight).divide(weightSum, MathContext.DECIMAL128)
                assertTrue(
                    (part.amount - ideal).abs() <= BigDecimal("0.0001"),
                    "part $part strays from ideal $ideal of $total by ${weights.size} weights"
                )
            }
        }
    }

    @Test
    fun `allocation distributes remainder units deterministically`() {
        // 0.0002 over three equal weights: earlier indexes win the tie.
        val one = BigDecimal.ONE
        assertEquals(
            listOf(usd("0.0001"), usd("0.0001"), usd("0.0000")),
            usd("0.0002").allocateBy(listOf(one, one, one))
        )
        assertEquals(
            listOf(usd("-0.0001"), usd("-0.0001"), usd("0.0000")),
            usd("-0.0002").allocateBy(listOf(one, one, one))
        )
    }

    @Test
    fun `allocation gives zero-weight entries nothing`() {
        val parts = usd("10").allocateBy(listOf(BigDecimal.ZERO, BigDecimal.ONE))
        assertEquals(listOf(usd("0"), usd("10")), parts)
    }

    @Test
    fun `allocation apportions sale costs by shares sold`() {
        // The spec sec. 4.2 case: sale costs split proportionally to shares
        // sold from each lot, without inventing or losing a unit.
        val costs = usd("10.00")
        val sharesSold = listOf(BigDecimal("3"), BigDecimal("3"), BigDecimal("3"))
        assertEquals(
            listOf(usd("3.3334"), usd("3.3333"), usd("3.3333")),
            costs.allocateBy(sharesSold)
        )
    }

    @Test
    fun `allocation rejects bad weights`() {
        assertFailsWith<IllegalArgumentException> { usd("1").allocateBy(emptyList()) }
        assertFailsWith<IllegalArgumentException> { usd("1").allocateBy(listOf(BigDecimal("-1"))) }
        assertFailsWith<IllegalArgumentException> { usd("1").allocateBy(listOf(BigDecimal.ZERO)) }
    }
}
