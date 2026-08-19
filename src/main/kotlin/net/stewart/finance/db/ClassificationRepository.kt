package net.stewart.finance.db

import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.SecurityId

data class ClassificationSetRow(
    val kind: String,
    val asOf: LocalDate,
    val weights: Map<String, Fraction>,
)

/**
 * Generic classification storage (build-scope §4): kinds are data,
 * "ASSET_CLASS" at launch; each (security, kind) set is date-stamped
 * and replaced atomically.
 */
class ClassificationRepository(private val dataSource: DataSource) {

    fun setsFor(securityId: SecurityId): List<ClassificationSetRow> =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT kind, class_key, weight, as_of FROM security_classifications " +
                    "WHERE security_id = ? ORDER BY kind, class_key"
            ).use { stmt ->
                stmt.setLong(1, securityId.value)
                val rs = stmt.executeQuery()
                val byKind = linkedMapOf<String, Pair<LocalDate, MutableMap<String, Fraction>>>()
                while (rs.next()) {
                    val kind = rs.getString("kind")
                    val entry = byKind.getOrPut(kind) {
                        rs.getObject("as_of", LocalDate::class.java) to linkedMapOf()
                    }
                    entry.second[rs.getString("class_key")] = Fraction.of(rs.getBigDecimal("weight"))
                }
                byKind.map { (kind, entry) -> ClassificationSetRow(kind, entry.first, entry.second) }
            }
        }

    /** Replaces the (security, kind) set atomically. */
    fun replace(securityId: SecurityId, kind: String, weights: Map<String, Fraction>, asOf: LocalDate) {
        dataSource.connection.use { conn ->
            conn.autoCommit = false
            try {
                conn.prepareStatement(
                    "DELETE FROM security_classifications WHERE security_id = ? AND kind = ?"
                ).use { stmt ->
                    stmt.setLong(1, securityId.value)
                    stmt.setString(2, kind)
                    stmt.executeUpdate()
                }
                conn.prepareStatement(
                    "INSERT INTO security_classifications (security_id, kind, class_key, weight, as_of) " +
                        "VALUES (?, ?, ?, ?, ?)"
                ).use { stmt ->
                    for ((key, weight) in weights) {
                        stmt.setLong(1, securityId.value)
                        stmt.setString(2, kind)
                        stmt.setString(3, key)
                        stmt.setBigDecimal(4, weight.value)
                        stmt.setObject(5, asOf)
                        stmt.addBatch()
                    }
                    stmt.executeBatch()
                }
                conn.commit()
            } catch (e: Exception) {
                conn.rollback()
                throw e
            } finally {
                conn.autoCommit = true
            }
        }
    }

    /** The seeded asset-class names, in display order. */
    fun assetClassNames(): List<String> =
        dataSource.connection.use { conn ->
            val rs = conn.createStatement()
                .executeQuery("SELECT name FROM asset_classes ORDER BY display_order")
            buildList { while (rs.next()) add(rs.getString(1)) }
        }
}
