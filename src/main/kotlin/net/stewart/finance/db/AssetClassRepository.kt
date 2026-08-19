package net.stewart.finance.db

import javax.sql.DataSource
import net.stewart.finance.domain.AssetClassId

data class AssetClassRow(
    val id: AssetClassId,
    val name: String,
)

/** The seeded asset classes, in display order (classes are data, §4/§6). */
class AssetClassRepository(private val dataSource: DataSource) {

    fun list(): List<AssetClassRow> =
        dataSource.connection.use { conn ->
            val rs = conn.createStatement()
                .executeQuery("SELECT id, name FROM asset_classes ORDER BY display_order")
            buildList {
                while (rs.next()) add(AssetClassRow(AssetClassId(rs.getLong("id")), rs.getString("name")))
            }
        }
}
