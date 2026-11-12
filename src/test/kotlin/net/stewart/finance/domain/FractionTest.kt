package net.stewart.finance.domain

import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class FractionTest {

    @Test
    fun `of normalizes to scale 4`() {
        assertEquals("0.2500", Fraction.of("0.25").toWire())
        assertEquals("1.0000", Fraction.ONE.toWire())
    }

    @Test
    fun `of rejects excess decimal places`() {
        assertFailsWith<ArithmeticException> { Fraction.of("0.00001") }
    }

    @Test
    fun `rounded rounds half to even`() {
        assertEquals(Fraction.of("0.1250"), Fraction.rounded(BigDecimal("0.12505")))
        assertEquals(Fraction.of("0.1252"), Fraction.rounded(BigDecimal("0.12515")))
    }

    @Test
    fun `arithmetic is exact and products round`() {
        assertEquals(Fraction.ONE, Fraction.of("0.6") + Fraction.of("0.4"))
        assertEquals(Fraction.of("0.2"), Fraction.of("0.6") - Fraction.of("0.4"))
        assertEquals(Fraction.of("-0.6"), -Fraction.of("0.6"))
        // The legacy fixed type truncated 0.3 * 0.6 to 0.1 at one decimal;
        // here the product rounds HALF_EVEN at scale 4.
        assertEquals(Fraction.of("0.1800"), Fraction.of("0.3") * Fraction.of("0.6"))
        assertEquals(Fraction.of("0.0002"), Fraction.of("0.015") * Fraction.of("0.0125"))
    }

    @Test
    fun `fraction of money delegates to money`() {
        val m = Money.of("100", CurrencyUnit.USD)
        assertEquals(m * Fraction.of("0.25"), Fraction.of("0.25") * m)
    }

    @Test
    fun `comparison, zero, and abs`() {
        assertTrue(Fraction.ZERO < Fraction.ONE)
        assertTrue(Fraction.ZERO.isZero())
        assertEquals(Fraction.of("0.5"), Fraction.of("-0.5").abs())
        assertEquals(-1, Fraction.of("-0.5").signum())
    }

    @Test
    fun `wire round-trip is lossless`() {
        val f = Fraction.of("0.3333")
        assertEquals(f, Fraction.fromWire(f.toWire()))
    }
}
