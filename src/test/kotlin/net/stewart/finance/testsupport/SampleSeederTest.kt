package net.stewart.finance.testsupport

import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.MtmMarkRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.db.SnapshotRepository
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.SecurityId
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.extension.RegisterExtension
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SampleSeederTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    private val portfolioId = PortfolioId(1)
    private val seeder get() = SampleSeeder(db.dataSource)

    @BeforeEach
    fun portfolioFixture() {
        seeder.reset()
        db.dataSource.connection.use { conn ->
            conn.createStatement().use { s ->
                s.executeUpdate("DELETE FROM portfolios")
                s.executeUpdate("INSERT INTO portfolios (id, name) VALUES (1, 'test')")
            }
        }
    }

    @Test
    fun `seed populates every fixture family with stable id keys`() {
        val ids = seeder.seed(portfolioId)
        assertTrue(
            ids.keys.containsAll(
                listOf(
                    "broker.vanguard", "broker.eurobank", "broker.old",
                    "account.brokerage", "account.roth", "account.eur", "account.closed",
                    "security.vti", "security.bondx", "security.gold", "security.eufund", "security.ghost",
                    "lot.vti_lt", "lot.vti_st", "lot.bondx", "lot.eufund",
                    "sale.last_year", "sale.this_year", "snapshot.sample",
                )
            ),
            "missing keys: ${ids.keys}",
        )
        val securities = SecurityRepository(db.dataSource).list(portfolioId, includeHidden = true)
        assertEquals(5, securities.size)
        assertEquals(1, securities.count { it.hidden })
        // The MTM ledger carries its two chained marks.
        val marks = MtmMarkRepository(db.dataSource)
            .listForSecurity(SecurityId(ids.getValue("security.eufund")))
        assertEquals(2, marks.size)
        assertEquals(marks[0].basisAfterUsd, marks[1].basisBeforeUsd)
        // Holdings carry both provenance kinds.
        val holdings = HoldingRepository(db.dataSource).list(portfolioId)
        assertEquals(2, holdings.size)
        assertEquals(2, holdings.map { it.source }.distinct().size)
        // The archived snapshot parses back as schema v1.
        val snapshots = SnapshotRepository(db.dataSource).list(portfolioId)
        assertEquals(1, snapshots.size)
        assertEquals(1, snapshots[0].schemaVersion)
        assertEquals(4, LotRepository(db.dataSource).list(portfolioId).size)
    }

    @Test
    fun `reset then seed is repeatable`() {
        seeder.seed(portfolioId)
        seeder.reset()
        assertTrue(SecurityRepository(db.dataSource).list(portfolioId, includeHidden = true).isEmpty())
        val ids = seeder.seed(portfolioId)
        assertEquals(5, SecurityRepository(db.dataSource).list(portfolioId, includeHidden = true).size)
        assertTrue(ids.isNotEmpty())
    }
}
