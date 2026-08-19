package net.stewart.finance.db

import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.ClassificationKind
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.SecurityId

data class ClassificationSetRow(
    val kind: ClassificationKind,
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
                val byKind = linkedMapOf<ClassificationKind, Pair<LocalDate, MutableMap<String, Fraction>>>()
                while (rs.next()) {
                    val kind = ClassificationKind.parse(rs.getString("kind"))
                    val entry = byKind.getOrPut(kind) {
                        rs.getObject("as_of", LocalDate::class.java) to linkedMapOf()
                    }
                    entry.second[rs.getString("class_key")] = Fraction.of(rs.getBigDecimal("weight"))
                }
                byKind.map { (kind, entry) -> ClassificationSetRow(kind, entry.first, entry.second) }
            }
        }

    /** Replaces the (security, kind) set atomically. */
    fun replace(securityId: SecurityId, kind: ClassificationKind, weights: Map<String, Fraction>, asOf: LocalDate) {
        dataSource.connection.use { conn ->
            conn.autoCommit = false
            try {
                conn.prepareStatement(
                    "DELETE FROM security_classifications WHERE security_id = ? AND kind = ?"
                ).use { stmt ->
                    stmt.setLong(1, securityId.value)
                    stmt.setString(2, kind.name)
                    stmt.executeUpdate()
                }
                conn.prepareStatement(
                    "INSERT INTO security_classifications (security_id, kind, class_key, weight, as_of) " +
                        "VALUES (?, ?, ?, ?, ?)"
                ).use { stmt ->
                    for ((key, weight) in weights) {
                        stmt.setLong(1, securityId.value)
                        stmt.setString(2, kind.name)
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

    /**
     * Every security's asset-class weight map, in one query — feeds
     * the allocation dashboard and rebalancer without an N+1.
     */
    fun assetClassWeightsBySecurity(portfolioId: net.stewart.finance.domain.PortfolioId): Map<SecurityId, Map<String, Fraction>> =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT sc.security_id, sc.class_key, sc.weight FROM security_classifications sc " +
                    "JOIN securities s ON s.id = sc.security_id " +
                    "WHERE s.portfolio_id = ? AND sc.kind = ? ORDER BY sc.security_id"
            ).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                stmt.setString(2, ClassificationKind.ASSET_CLASS.name)
                val rs = stmt.executeQuery()
                val result = linkedMapOf<SecurityId, MutableMap<String, Fraction>>()
                while (rs.next()) {
                    result.getOrPut(SecurityId(rs.getLong("security_id"))) { linkedMapOf() }[
                        rs.getString("class_key")
                    ] = Fraction.of(rs.getBigDecimal("weight"))
                }
                result
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
