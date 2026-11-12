package net.stewart.finance

import kotlin.test.Test
import kotlin.test.assertEquals
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension

/** Proves the h2-kotlin-toolkit test fixtures run finance2's migrations. */
class DbBaselineTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    @Test
    fun `baseline migration applied`() {
        db.dataSource.connection.use { conn ->
            val rs = conn.createStatement()
                .executeQuery("SELECT meta_value FROM app_metadata WHERE meta_key = 'schema_baseline'")
            rs.next()
            assertEquals("phase0", rs.getString(1))
        }
    }
}
