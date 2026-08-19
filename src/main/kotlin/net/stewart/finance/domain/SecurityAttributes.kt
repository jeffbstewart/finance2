package net.stewart.finance.domain

// The securities columns are deliberately open-ended VARCHARs in the
// schema (a future value is an additive migration, not surgery), but
// server code never handles them as bare strings: these enums are the
// only representation past the ResultSet, and an unknown stored value
// fails loudly at read time.

/**
 * What kind of instrument a security is. MUTUAL_FUND is load-bearing:
 * mutual funds are bought in dollar amounts, everything else in whole
 * shares (spec §5.5).
 */
enum class SecurityType {
    UNKNOWN,
    STOCK,
    ETF,
    MUTUAL_FUND,
    PRIVATE;

    companion object {
        fun parse(dbValue: String): SecurityType =
            entries.firstOrNull { it.name == dbValue }
                ?: throw IllegalArgumentException("unknown security type \"$dbValue\" in database")
    }
}

/**
 * Who prices the security (build-scope §4): MARKET = the external
 * provider; MANUAL = hand-entered private price rows.
 */
enum class PricingLocus {
    MARKET,
    MANUAL;

    companion object {
        fun parse(dbValue: String): PricingLocus =
            entries.firstOrNull { it.name == dbValue }
                ?: throw IllegalArgumentException("unknown pricing locus \"$dbValue\" in database")
    }
}
