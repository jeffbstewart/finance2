package net.stewart.finance.domain

/**
 * Where an archived bankferry snapshot stands (pipeline design,
 * amended 2026-08-20): uploads archive first, processing is a
 * separate, freely repeatable step — the marker exists so a
 * processing bug can be fixed and the same bytes re-run.
 */
enum class SnapshotStatus {
    UPLOADED,
    PROCESSED,
    FAILED;

    companion object {
        fun parse(dbValue: String): SnapshotStatus =
            entries.firstOrNull { it.name == dbValue }
                ?: throw IllegalArgumentException("unknown snapshot status \"$dbValue\" in database")
    }
}
