package net.stewart.finance.db

import java.sql.ResultSet
import java.time.LocalDate
import java.time.OffsetDateTime
import javax.sql.DataSource
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.SnapshotId
import net.stewart.finance.domain.SnapshotStatus
import org.jdbi.v3.core.Jdbi

data class SnapshotRecord(
    val id: SnapshotId,
    val filename: String,
    val schemaVersion: Int,
    val asOf: LocalDate,
    val uploadedAt: OffsetDateTime,
    val status: SnapshotStatus,
    val processedAt: OffsetDateTime?,
    /** Serialized ImportReport proto from the last run, when any. */
    val report: ByteArray?,
)

/**
 * Archived bankferry snapshot uploads (pipeline design, amended
 * 2026-08-20). Raw bytes stay verbatim so a fixed processor can
 * re-run against exactly what was uploaded; listings omit them.
 */
class SnapshotRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun create(
        portfolioId: PortfolioId,
        filename: String,
        content: ByteArray,
        schemaVersion: Int,
        asOf: LocalDate,
    ): SnapshotId = jdbi.sql { handle ->
        SnapshotId(
            handle.createUpdate(
                "INSERT INTO snapshot_uploads (portfolio_id, filename, content, schema_version, as_of) " +
                    "VALUES (:portfolioId, :filename, :content, :schemaVersion, :asOf)"
            )
                .bind("portfolioId", portfolioId.value)
                .bind("filename", filename)
                .bind("content", content)
                .bind("schemaVersion", schemaVersion)
                .bind("asOf", asOf)
                .executeAndReturnGeneratedKeys("id")
                .mapTo(Long::class.java)
                .one()
        )
    }

    /** Newest first, without the archived bytes. */
    fun list(portfolioId: PortfolioId): List<SnapshotRecord> = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE portfolio_id = :portfolioId ORDER BY uploaded_at DESC, id DESC")
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRecord() }
            .list()
    }

    fun find(id: SnapshotId, portfolioId: PortfolioId): SnapshotRecord? = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE id = :id AND portfolio_id = :portfolioId")
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRecord() }
            .findOne()
            .orElse(null)
    }

    /**
     * The snapshot whose processing run is the most recent — the one
     * whose report describes the current state of the import. A
     * re-run of an older snapshot after lot fixes counts as newest.
     */
    fun latestProcessed(portfolioId: PortfolioId): SnapshotRecord? = jdbi.sql { handle ->
        handle.createQuery(
            "$SELECT WHERE portfolio_id = :portfolioId AND processed_at IS NOT NULL " +
                "ORDER BY processed_at DESC, id DESC LIMIT 1"
        )
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRecord() }
            .findFirst()
            .orElse(null)
    }

    /** The archived snapshot bytes, exactly as uploaded. */
    fun content(id: SnapshotId, portfolioId: PortfolioId): ByteArray? = jdbi.sql { handle ->
        handle.createQuery(
            "SELECT content FROM snapshot_uploads WHERE id = :id AND portfolio_id = :portfolioId"
        )
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .mapTo(ByteArray::class.java)
            .findOne()
            .orElse(null)
    }

    fun recordProcessing(id: SnapshotId, status: SnapshotStatus, report: ByteArray) {
        jdbi.sql { handle ->
            handle.createUpdate(
                "UPDATE snapshot_uploads SET status = :status, processed_at = CURRENT_TIMESTAMP, " +
                    "report = :report WHERE id = :id"
            )
                .bind("status", status.name)
                .bind("report", report)
                .bind("id", id.value)
                .execute()
        }
    }

    fun delete(id: SnapshotId): Boolean = jdbi.sql { handle ->
        handle.createUpdate("DELETE FROM snapshot_uploads WHERE id = :id")
            .bind("id", id.value)
            .execute() > 0
    }

    private fun ResultSet.toRecord() = SnapshotRecord(
        id = SnapshotId(getLong("id")),
        filename = getString("filename"),
        schemaVersion = getInt("schema_version"),
        asOf = getObject("as_of", LocalDate::class.java),
        uploadedAt = getObject("uploaded_at", OffsetDateTime::class.java),
        status = SnapshotStatus.parse(getString("status")),
        processedAt = getObject("processed_at", OffsetDateTime::class.java),
        report = getBytes("report"),
    )

    private companion object {
        const val SELECT =
            "SELECT id, filename, schema_version, as_of, uploaded_at, status, processed_at, report " +
                "FROM snapshot_uploads"
    }
}
