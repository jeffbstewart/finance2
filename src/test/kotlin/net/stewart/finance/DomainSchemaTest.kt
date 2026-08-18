package net.stewart.finance

import java.math.BigDecimal
import java.sql.Connection
import java.sql.SQLException
import java.sql.Statement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import net.stewart.h2toolkit.H2TestDatabaseExtension
import org.junit.jupiter.api.extension.RegisterExtension

/**
 * Proves the V002 domain schema: seed data, exact NUMERIC round-trips,
 * scoped uniqueness (fix of FUNCTIONAL_SPEC §4.3 legacy defect 4), and
 * the referential guard rails behind §5.9.
 */
class DomainSchemaTest {

    companion object {
        @JvmField
        @RegisterExtension
        val db = H2TestDatabaseExtension()
    }

    @Test
    fun `asset classes are seeded in display order`() {
        db.dataSource.connection.use { conn ->
            val rs = conn.createStatement()
                .executeQuery("SELECT name FROM asset_classes ORDER BY display_order")
            val names = buildList { while (rs.next()) add(rs.getString(1)) }
            assertEquals(listOf("Cash", "US Stock", "Non US Stock", "Bond", "Other"), names)
        }
    }

    @Test
    fun `full entity graph inserts and decimals round-trip exactly`() {
        db.dataSource.connection.use { conn ->
            val portfolioId = insert(conn, "INSERT INTO portfolios (name) VALUES ('default')")
            val brokerId = insert(
                conn, "INSERT INTO brokers (portfolio_id, name) VALUES ($portfolioId, 'Vault Custodian')"
            )
            val accountId = insert(
                conn,
                "INSERT INTO accounts (broker_id, name, account_number, currency, tax_deferred) " +
                    "VALUES ($brokerId, 'Gold IRA', 'X-123', 'USD', TRUE)"
            )
            val securityId = insert(
                conn,
                "INSERT INTO securities (portfolio_id, ticker, description, currency, pricing_locus) " +
                    "VALUES ($portfolioId, 'AGE-1OZ', 'American Gold Eagle 1oz', 'USD', 'MANUAL')"
            )
            insert(
                conn,
                "INSERT INTO holdings (account_id, security_id, quantity, source, as_of) " +
                    "VALUES ($accountId, $securityId, 12.12345678, 'manual', DATE '2026-08-18')"
            )
            insert(
                conn,
                "INSERT INTO private_prices (security_id, price_date, price) " +
                    "VALUES ($securityId, DATE '2026-08-18', 3355.1234)"
            )

            val quantity = conn.createStatement()
                .executeQuery("SELECT quantity FROM holdings WHERE account_id = $accountId")
                .also { it.next() }
                .getBigDecimal(1)
            assertEquals(BigDecimal("12.12345678"), quantity)

            val price = conn.createStatement()
                .executeQuery("SELECT price FROM private_prices WHERE security_id = $securityId")
                .also { it.next() }
                .getBigDecimal(1)
            assertEquals(BigDecimal("3355.1234"), price)
        }
    }

    @Test
    fun `tickers are unique per portfolio, not globally`() {
        db.dataSource.connection.use { conn ->
            val p1 = insert(conn, "INSERT INTO portfolios (name) VALUES ('p1')")
            val p2 = insert(conn, "INSERT INTO portfolios (name) VALUES ('p2')")
            insert(conn, "INSERT INTO securities (portfolio_id, ticker, currency) VALUES ($p1, 'VTI', 'USD')")
            // Same ticker in another portfolio is fine.
            insert(conn, "INSERT INTO securities (portfolio_id, ticker, currency) VALUES ($p2, 'VTI', 'USD')")
            // Same ticker in the same portfolio is not.
            assertFailsWith<SQLException> {
                insert(conn, "INSERT INTO securities (portfolio_id, ticker, currency) VALUES ($p1, 'VTI', 'USD')")
            }
        }
    }

    @Test
    fun `account names are unique per broker, not globally`() {
        db.dataSource.connection.use { conn ->
            val p = insert(conn, "INSERT INTO portfolios (name) VALUES ('scoping')")
            val b1 = insert(conn, "INSERT INTO brokers (portfolio_id, name) VALUES ($p, 'b1')")
            val b2 = insert(conn, "INSERT INTO brokers (portfolio_id, name) VALUES ($p, 'b2')")
            insert(conn, "INSERT INTO accounts (broker_id, name, account_number, currency) VALUES ($b1, 'IRA', '1', 'USD')")
            insert(conn, "INSERT INTO accounts (broker_id, name, account_number, currency) VALUES ($b2, 'IRA', '2', 'EUR')")
            assertFailsWith<SQLException> {
                insert(conn, "INSERT INTO accounts (broker_id, name, account_number, currency) VALUES ($b1, 'IRA', '3', 'USD')")
            }
        }
    }

    @Test
    fun `referenced rows cannot be deleted`() {
        db.dataSource.connection.use { conn ->
            val p = insert(conn, "INSERT INTO portfolios (name) VALUES ('guarded')")
            val b = insert(conn, "INSERT INTO brokers (portfolio_id, name) VALUES ($p, 'broker')")
            insert(conn, "INSERT INTO accounts (broker_id, name, account_number, currency) VALUES ($b, 'acct', '1', 'USD')")
            assertFailsWith<SQLException> {
                conn.createStatement().executeUpdate("DELETE FROM brokers WHERE id = $b")
            }
        }
    }

    private fun insert(conn: Connection, sql: String): Long =
        conn.createStatement().let { stmt ->
            stmt.executeUpdate(sql, Statement.RETURN_GENERATED_KEYS)
            val keys = stmt.generatedKeys
            if (keys.next()) keys.getLong(1) else 0L
        }
}
