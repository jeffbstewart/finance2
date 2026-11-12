package net.stewart.finance.db

import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.ClassificationKind
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.SecurityId
import org.jdbi.v3.core.Jdbi

data class ClassificationSetRow(
    val kind: ClassificationKind,
    val asOf: LocalDate,
    val weights: Map<String, Fraction>,
)

/**
 * Generic classification storage (build-scope sec. 4): kinds are data,
 * "ASSET_CLASS" at launch; each (security, kind) set is date-stamped
 * and replaced atomically.
 */
class ClassificationRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun setsFor(securityId: SecurityId): List<ClassificationSetRow> = jdbi.sql { handle ->
        val byKind = linkedMapOf<ClassificationKind, Pair<LocalDate, MutableMap<String, Fraction>>>()
        handle.createQuery(
            "SELECT kind, class_key, weight, as_of FROM security_classifications " +
                "WHERE security_id = :securityId ORDER BY kind, class_key"
        )
            .bind("securityId", securityId.value)
            .map { rs, _ ->
                Triple(
                    ClassificationKind.parse(rs.getString("kind")),
                    rs.getObject("as_of", LocalDate::class.java),
                    rs.getString("class_key") to Fraction.of(rs.getBigDecimal("weight")),
                )
            }
            .forEach { (kind, asOf, entry) ->
                byKind.getOrPut(kind) { asOf to linkedMapOf() }.second[entry.first] = entry.second
            }
        byKind.map { (kind, entry) -> ClassificationSetRow(kind, entry.first, entry.second) }
    }

    /** Replaces the (security, kind) set atomically. */
    fun replace(securityId: SecurityId, kind: ClassificationKind, weights: Map<String, Fraction>, asOf: LocalDate) {
        jdbi.sqlTransaction { handle ->
            handle.createUpdate(
                "DELETE FROM security_classifications WHERE security_id = :securityId AND kind = :kind"
            )
                .bind("securityId", securityId.value)
                .bind("kind", kind.name)
                .execute()
            val batch = handle.prepareBatch(
                "INSERT INTO security_classifications (security_id, kind, class_key, weight, as_of) " +
                    "VALUES (:securityId, :kind, :classKey, :weight, :asOf)"
            )
            for ((key, weight) in weights) {
                batch
                    .bind("securityId", securityId.value)
                    .bind("kind", kind.name)
                    .bind("classKey", key)
                    .bind("weight", weight.value)
                    .bind("asOf", asOf)
                    .add()
            }
            batch.execute()
        }
    }

    /**
     * Every security's asset-class weight map, in one query - feeds
     * the allocation dashboard and rebalancer without an N+1.
     */
    fun assetClassWeightsBySecurity(portfolioId: PortfolioId): Map<SecurityId, Map<String, Fraction>> =
        jdbi.sql { handle ->
            val result = linkedMapOf<SecurityId, MutableMap<String, Fraction>>()
            handle.createQuery(
                "SELECT sc.security_id, sc.class_key, sc.weight FROM security_classifications sc " +
                    "JOIN securities s ON s.id = sc.security_id " +
                    "WHERE s.portfolio_id = :portfolioId AND sc.kind = :kind ORDER BY sc.security_id"
            )
                .bind("portfolioId", portfolioId.value)
                .bind("kind", ClassificationKind.ASSET_CLASS.name)
                .map { rs, _ ->
                    SecurityId(rs.getLong("security_id")) to
                        (rs.getString("class_key") to Fraction.of(rs.getBigDecimal("weight")))
                }
                .forEach { (id, entry) ->
                    result.getOrPut(id) { linkedMapOf() }[entry.first] = entry.second
                }
            result
        }
}
