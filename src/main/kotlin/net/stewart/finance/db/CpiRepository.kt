package net.stewart.finance.db

import java.math.BigDecimal
import java.time.LocalDate
import java.time.YearMonth
import javax.sql.DataSource
import org.jdbi.v3.core.Jdbi

/** Monthly CPIAUCSL observations (spec §5.7). */
class CpiRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun isEmpty(): Boolean = jdbi.sql { handle ->
        handle.createQuery("SELECT 1 FROM cpi_observations LIMIT 1")
            .mapTo(Int::class.java)
            .findOne()
            .isEmpty
    }

    fun loadAll(): Map<YearMonth, BigDecimal> = jdbi.sql { handle ->
        val result = linkedMapOf<YearMonth, BigDecimal>()
        handle.createQuery("SELECT obs_month, index_value FROM cpi_observations ORDER BY obs_month")
            .map { rs, _ ->
                YearMonth.from(rs.getObject("obs_month", LocalDate::class.java)) to
                    rs.getBigDecimal("index_value")
            }
            .forEach { (month, value) -> result[month] = value }
        result
    }

    fun upsertAll(observations: Map<YearMonth, BigDecimal>) {
        if (observations.isEmpty()) return
        jdbi.sql { handle ->
            val batch = handle.prepareBatch(
                "MERGE INTO cpi_observations (obs_month, index_value, updated_at) " +
                    "KEY (obs_month) VALUES (:month, :value, CURRENT_TIMESTAMP)"
            )
            for ((month, value) in observations) {
                batch.bind("month", month.atDay(1)).bind("value", value).add()
            }
            batch.execute()
        }
    }
}
