package net.stewart.finance.domain

// The securities columns are deliberately open-ended VARCHARs in the
// schema (a future value is an additive migration, not surgery), but
// server code never handles them as bare strings: these enums are the
// only representation past the ResultSet, and an unknown stored value
// fails loudly at read time.

/**
 * What kind of instrument a security is. MUTUAL_FUND is load-bearing:
 * mutual funds are bought in dollar amounts, everything else in whole
 * shares (spec sec. 5.5).
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
 * A classification taxonomy (build-scope sec. 4). Only the asset-class mix
 * ships at launch; reviving a deferred taxonomy (sector, market cap,
 * region, credit quality) is an additive enum entry plus seed data - 
 * the storage is already generic. Server code rejects kinds it does
 * not know, so the wire cannot persist arbitrary taxonomies.
 */
enum class ClassificationKind {
    ASSET_CLASS;

    companion object {
        fun parse(dbValue: String): ClassificationKind =
            entries.firstOrNull { it.name == dbValue }
                ?: throw IllegalArgumentException("unknown classification kind \"$dbValue\" in database")
    }
}

/**
 * How the security is taxed (build-scope sec. 11): LOTS = purchase-lot
 * basis with ST/LT capital gains (the default); MARK_TO_MARKET = the
 * PFIC sec. 1296 election - annual year-end marks recognize ordinary
 * income and reset the basis, floored at acquisition cost.
 */
enum class TaxTreatment {
    LOTS,
    MARK_TO_MARKET;

    companion object {
        fun parse(dbValue: String): TaxTreatment =
            entries.firstOrNull { it.name == dbValue }
                ?: throw IllegalArgumentException("unknown tax treatment \"$dbValue\" in database")
    }
}

/**
 * Who prices the security (build-scope sec. 4): MARKET = the external
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
