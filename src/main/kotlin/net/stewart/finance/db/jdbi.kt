package net.stewart.finance.db

import java.sql.SQLException
import org.jdbi.v3.core.Handle
import org.jdbi.v3.core.Jdbi
import org.jdbi.v3.core.JdbiException

// Repositories bind SQL parameters by name (review ruling on PR 30):
// a rename or reorder matches by name or fails loudly, never silently
// binds the wrong column. JDBI wraps driver errors in its own runtime
// exceptions; this helper unwraps them so the repository contract —
// "throws SQLException on a constraint violation" — survives the
// migration and the services' ALREADY_EXISTS mapping keeps working.

internal fun <T> Jdbi.sql(block: (Handle) -> T): T = try {
    withHandle<T, Exception>(block)
} catch (e: JdbiException) {
    throw (e.cause as? SQLException) ?: e
}

internal fun <T> Jdbi.sqlTransaction(block: (Handle) -> T): T = try {
    inTransaction<T, Exception>(block)
} catch (e: JdbiException) {
    throw (e.cause as? SQLException) ?: e
}
