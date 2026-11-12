package net.stewart.finance.domain

import java.util.Locale

/**
 * An ISO 4217 currency code, validated at construction.
 *
 * Currency is a property of the account in finance2 (see
 * docs/design/initial-build-scope.md sec. 5): every security held in an
 * account and its sweep balance are denominated in the account's
 * currency. Arithmetic between [Money] values of different currencies
 * throws [CurrencyMismatchException]; conversion is explicit, through a
 * dated FX rate, never implicit.
 */
@JvmInline
value class CurrencyUnit private constructor(val code: String) {

    /** The display symbol for this currency, e.g. `$` or `\u20ac`. */
    val symbol: String
        get() = java.util.Currency.getInstance(code).getSymbol(Locale.US)

    override fun toString(): String = code

    companion object {
        val USD = CurrencyUnit("USD")
        val EUR = CurrencyUnit("EUR")

        /**
         * Parses an ISO 4217 code (untrusted input). Throws
         * [IllegalArgumentException] for anything that is not an exact,
         * uppercase ISO 4217 code.
         */
        fun parse(code: String): CurrencyUnit {
            try {
                java.util.Currency.getInstance(code)
            } catch (e: IllegalArgumentException) {
                throw IllegalArgumentException("unknown ISO 4217 currency code \"$code\"", e)
            }
            return CurrencyUnit(code)
        }
    }
}

/** Thrown when arithmetic mixes two currencies without an explicit FX conversion. */
class CurrencyMismatchException(message: String) : ArithmeticException(message)
