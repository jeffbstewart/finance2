package net.stewart.finance.db

import javax.sql.DataSource
import org.jdbi.v3.core.Jdbi

/**
 * The seeded asset classes (classes are data, build-scope §4/§6).
 * Names are the identity everywhere above the database — the numeric
 * primary key never leaves the db layer. Distinctness is guaranteed by
 * the schema's UNIQUE constraint and encoded here in the return type;
 * iteration order is the seeded display order.
 */
class AssetClassRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun names(): Set<String> = jdbi.sql { handle ->
        handle.createQuery("SELECT name FROM asset_classes ORDER BY display_order")
            .mapTo(String::class.java)
            .list()
            .toCollection(linkedSetOf())
    }
}
