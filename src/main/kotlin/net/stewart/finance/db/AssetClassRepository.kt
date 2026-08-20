package net.stewart.finance.db

import javax.sql.DataSource

/**
 * The seeded asset classes (classes are data, build-scope §4/§6).
 * Names are the identity everywhere above the database — the numeric
 * primary key never leaves the db layer. Distinctness is guaranteed by
 * the schema's UNIQUE constraint and encoded here in the return type;
 * iteration order is the seeded display order.
 */
class AssetClassRepository(private val dataSource: DataSource) {

    fun names(): Set<String> =
        dataSource.connection.use { conn ->
            val rs = conn.createStatement()
                .executeQuery("SELECT name FROM asset_classes ORDER BY display_order")
            val result = linkedSetOf<String>()
            while (rs.next()) result.add(rs.getString("name"))
            result
        }
}
