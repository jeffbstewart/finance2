package net.stewart.finance.domain

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class CurrencyUnitTest {

    @Test
    fun `parse accepts ISO 4217 codes`() {
        assertEquals(CurrencyUnit.USD, CurrencyUnit.parse("USD"))
        assertEquals(CurrencyUnit.EUR, CurrencyUnit.parse("EUR"))
        assertEquals("JPY", CurrencyUnit.parse("JPY").code)
    }

    @Test
    fun `parse rejects unknown and non-canonical codes`() {
        assertFailsWith<IllegalArgumentException> { CurrencyUnit.parse("") }
        assertFailsWith<IllegalArgumentException> { CurrencyUnit.parse("usd") }
        assertFailsWith<IllegalArgumentException> { CurrencyUnit.parse("DOLLARS") }
    }

    @Test
    fun `symbols render for display`() {
        assertEquals("$", CurrencyUnit.USD.symbol)
        assertEquals("\u20ac", CurrencyUnit.EUR.symbol)
    }

    @Test
    fun `toString is the code`() {
        assertEquals("USD", CurrencyUnit.USD.toString())
    }
}
