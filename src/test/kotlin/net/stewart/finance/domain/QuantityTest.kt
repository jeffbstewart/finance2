package net.stewart.finance.domain

import io.kotest.property.Arb
import io.kotest.property.arbitrary.long
import io.kotest.property.arbitrary.map
import io.kotest.property.checkAll
import kotlinx.coroutines.runBlocking
import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** Quantities at scale 8 with up to 10 integer digits. */
private fun arbQuantity(): Arb<Quantity> =
    Arb.long(-999_999_999_999_999_999L..999_999_999_999_999_999L)
        .map { Quantity.of(BigDecimal.valueOf(it, 8)) }

class QuantityTest {

    @Test
    fun `of normalizes to scale 8`() {
        assertEquals("3.00000000", Quantity.of("3").toWire())
        assertEquals("0.12345678", Quantity.of("0.12345678").toWire())
    }

    @Test
    fun `of rejects excess decimal places`() {
        assertFailsWith<ArithmeticException> { Quantity.of("0.000000001") }
    }

    @Test
    fun `of enforces the NUMERIC column bound`() {
        Quantity.of("999999999999.99999999") // 12 integer digits: the limit
        assertFailsWith<ArithmeticException> { Quantity.of("1000000000000") }
    }

    @Test
    fun `rounded rounds half to even`() {
        assertEquals(Quantity.of("0.00000002"), Quantity.rounded(BigDecimal("0.000000025")))
        assertEquals(Quantity.of("0.00000004"), Quantity.rounded(BigDecimal("0.000000035")))
    }

    @Test
    fun `arithmetic is exact`() {
        assertEquals(Quantity.of("5.5"), Quantity.of("2.25") + Quantity.of("3.25"))
        assertEquals(Quantity.of("-1"), Quantity.of("2.25") - Quantity.of("3.25"))
        assertEquals(Quantity.of("-2.25"), -Quantity.of("2.25"))
        assertEquals(Quantity.of("2.25"), Quantity.of("-2.25").abs())
    }

    @Test
    fun `quantity ratio is a fraction`() {
        // Fraction of a lot still held: 50 of 400 shares.
        assertEquals(Fraction.of("0.125"), Quantity.of("50") / Quantity.of("400"))
        assertEquals(Fraction.of("0.3333"), Quantity.of("1") / Quantity.of("3"))
        assertFailsWith<ArithmeticException> { Quantity.of("1") / Quantity.ZERO }
    }

    @Test
    fun `quantity times price matches price times quantity`() {
        val price = Money.of("12.34", CurrencyUnit.USD)
        assertEquals(price * Quantity.of("3"), Quantity.of("3") * price)
    }

    @Test
    fun `comparison and zero`() {
        assertTrue(Quantity.of("1") < Quantity.of("1.00000001"))
        assertTrue(Quantity.ZERO.isZero())
        assertEquals(0, Quantity.of("0.0").compareTo(Quantity.ZERO))
    }

    @Test
    fun `wire round-trip is lossless`() = runBlocking<Unit> {
        checkAll(arbQuantity()) { q ->
            assertEquals(q, Quantity.fromWire(q.toWire()))
        }
    }
}
