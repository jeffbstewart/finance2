package net.stewart.finance.domain

/**
 * Where a stored value came from (build-scope §1 provenance): entered
 * by hand, or imported from a bankferry Plaid snapshot. The columns
 * stay open-ended VARCHARs (a future source is an additive migration),
 * but server code never handles provenance as a bare string; unknown
 * stored values fail loudly at read time.
 */
enum class EntrySource(val dbValue: String) {
    MANUAL("manual"),
    PLAID("plaid");

    companion object {
        fun parse(dbValue: String): EntrySource =
            entries.firstOrNull { it.dbValue == dbValue }
                ?: throw IllegalArgumentException("unknown entry source \"$dbValue\" in database")
    }
}
