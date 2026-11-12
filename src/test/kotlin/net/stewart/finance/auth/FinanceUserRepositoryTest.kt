package net.stewart.finance.auth

import java.sql.SQLException
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FinanceUserRepositoryTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    private val repo get() = FinanceUserRepository(db.dataSource)

    @Test
    fun `create, find, and lock the user`() {
        assertTrue(!repo.hasUsers())
        val created = repo.createUser("Jeff", "hash", "Jeff S")
        assertTrue(repo.hasUsers())

        // Case-insensitive lookup via VARCHAR_IGNORECASE.
        val found = repo.findByUsername("jeff")
        assertEquals(created, found)
        assertEquals(created, repo.findById(created.id))
        assertNull(repo.findByUsername("nobody"))
        assertNull(repo.findById(9999))

        repo.lockUser(created.id)
        assertTrue(repo.findById(created.id)!!.isLocked)

        // Uniqueness is case-insensitive too.
        assertFailsWith<SQLException> { repo.createUser("JEFF", "hash2", "dup") }
    }
}
