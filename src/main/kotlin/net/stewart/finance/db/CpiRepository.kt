package net.stewart.finance.db

import java.math.BigDecimal
import java.time.LocalDate
import java.time.YearMonth
import javax.sql.DataSource

/** Monthly CPIAUCSL observations (spec §5.7). */
class CpiRepository(private val dataSource: DataSource) {

    fun isEmpty(): Boolean =
        dataSource.connection.use { conn ->
            !conn.createStatement().executeQuery("SELECT 1 FROM cpi_observations LIMIT 1").next()
        }

    fun loadAll(): Map<YearMonth, BigDecimal> =
        dataSource.connection.use { conn ->
            val rs = conn.createStatement()
                .executeQuery("SELECT obs_month, index_value FROM cpi_observations ORDER BY obs_month")
            val result = linkedMapOf<YearMonth, BigDecimal>()
            while (rs.next()) {
                result[YearMonth.from(rs.getObject("obs_month", LocalDate::class.java))] =
                    rs.getBigDecimal("index_value")
            }
            result
        }

    fun upsertAll(observations: Map<YearMonth, BigDecimal>) {
        if (observations.isEmpty()) return
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "MERGE INTO cpi_observations (obs_month, index_value, updated_at) " +
                    "KEY (obs_month) VALUES (?, ?, CURRENT_TIMESTAMP)"
            ).use { stmt ->
                for ((month, value) in observations) {
                    stmt.setObject(1, month.atDay(1))
                    stmt.setBigDecimal(2, value)
                    stmt.addBatch()
                }
                stmt.executeBatch()
            }
        }
    }
}
