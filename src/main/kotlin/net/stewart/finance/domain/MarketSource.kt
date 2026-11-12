package net.stewart.finance.domain

/**
 * Which Decision 4 provider a market bar came from. Open column,
 * closed code, like the other enums.
 */
enum class MarketSource(val dbValue: String) {
    TIINGO("tiingo"),
    EODHD("eodhd");

    companion object {
        fun parse(dbValue: String): MarketSource =
            entries.firstOrNull { it.dbValue == dbValue }
                ?: throw IllegalArgumentException("unknown market source \"$dbValue\" in database")
    }
}
