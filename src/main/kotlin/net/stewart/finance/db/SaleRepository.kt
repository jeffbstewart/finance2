package net.stewart.finance.db

import java.sql.ResultSet
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.LotId
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SaleId
import net.stewart.finance.domain.SecurityId

data class SaleRecord(
    val id: SaleId,
    val accountId: AccountId,
    val accountName: String,
    val brokerName: String,
    val securityId: SecurityId,
    val saleDate: LocalDate,
    val pricePerShare: Money,
    val saleCosts: Money,
    val allocations: List<Pair<LotId, Quantity>>,
)

/** Sales and their lot allocations; currency from the account row. */
class SaleRepository(private val dataSource: DataSource) {

    fun list(
        portfolioId: PortfolioId,
        accountId: AccountId? = null,
        securityId: SecurityId? = null,
    ): List<SaleRecord> =
        query(
            SELECT + " WHERE b.portfolio_id = ?" +
                (if (accountId != null) " AND s.account_id = ?" else "") +
                (if (securityId != null) " AND s.security_id = ?" else "") +
                " ORDER BY s.sale_date, s.id"
        ) { stmt ->
            var i = 1
            stmt.setLong(i++, portfolioId.value)
            if (accountId != null) stmt.setLong(i++, accountId.value)
            if (securityId != null) stmt.setLong(i, securityId.value)
        }

    /** Sales in [from]..[to] from taxable accounts only (spec §5.3). */
    fun listForTaxReport(portfolioId: PortfolioId, from: LocalDate, to: LocalDate): List<SaleRecord> =
        query(
            "$SELECT WHERE b.portfolio_id = ? AND NOT a.tax_deferred " +
                "AND s.sale_date >= ? AND s.sale_date <= ? ORDER BY s.sale_date, s.id"
        ) { stmt ->
            stmt.setLong(1, portfolioId.value)
            stmt.setObject(2, from)
            stmt.setObject(3, to)
        }

    fun find(id: SaleId, portfolioId: PortfolioId): SaleRecord? =
        query("$SELECT WHERE s.id = ? AND b.portfolio_id = ?") { stmt ->
            stmt.setLong(1, id.value)
            stmt.setLong(2, portfolioId.value)
        }.singleOrNull()

    /** Inserts the sale and its allocations atomically. */
    fun create(
        accountId: AccountId,
        securityId: SecurityId,
        saleDate: LocalDate,
        pricePerShare: Money,
        saleCosts: Money,
        allocations: List<Pair<LotId, Quantity>>,
    ): SaleId =
        dataSource.connection.use { conn ->
            conn.autoCommit = false
            try {
                val saleId = conn.prepareStatement(
                    "INSERT INTO sales (account_id, security_id, sale_date, price_per_share, sale_costs) " +
                        "VALUES (?, ?, ?, ?, ?)",
                    java.sql.Statement.RETURN_GENERATED_KEYS,
                ).use { stmt ->
                    stmt.setLong(1, accountId.value)
                    stmt.setLong(2, securityId.value)
                    stmt.setObject(3, saleDate)
                    stmt.setBigDecimal(4, pricePerShare.amount)
                    stmt.setBigDecimal(5, saleCosts.amount)
                    stmt.executeUpdate()
                    stmt.generatedKeys.also { check(it.next()) }.getLong(1)
                }
                conn.prepareStatement(
                    "INSERT INTO sale_allocations (sale_id, lot_id, shares_sold) VALUES (?, ?, ?)"
                ).use { stmt ->
                    for ((lotId, shares) in allocations) {
                        stmt.setLong(1, saleId)
                        stmt.setLong(2, lotId.value)
                        stmt.setBigDecimal(3, shares.amount)
                        stmt.addBatch()
                    }
                    stmt.executeBatch()
                }
                conn.commit()
                SaleId(saleId)
            } catch (e: Exception) {
                conn.rollback()
                throw e
            } finally {
                conn.autoCommit = true
            }
        }

    /** Deletes the sale and its allocations atomically. */
    fun delete(id: SaleId): Boolean =
        dataSource.connection.use { conn ->
            conn.autoCommit = false
            try {
                conn.prepareStatement("DELETE FROM sale_allocations WHERE sale_id = ?").use { stmt ->
                    stmt.setLong(1, id.value)
                    stmt.executeUpdate()
                }
                val deleted = conn.prepareStatement("DELETE FROM sales WHERE id = ?").use { stmt ->
                    stmt.setLong(1, id.value)
                    stmt.executeUpdate() > 0
                }
                conn.commit()
                deleted
            } catch (e: Exception) {
                conn.rollback()
                throw e
            } finally {
                conn.autoCommit = true
            }
        }

    private fun query(sql: String, bind: (java.sql.PreparedStatement) -> Unit): List<SaleRecord> =
        dataSource.connection.use { conn ->
            val sales = conn.prepareStatement(sql).use { stmt ->
                bind(stmt)
                val rs = stmt.executeQuery()
                buildList { while (rs.next()) add(rs.toRecord()) }
            }
            if (sales.isEmpty()) return@use sales
            val allocations = linkedMapOf<Long, MutableList<Pair<LotId, Quantity>>>()
            conn.prepareStatement(
                "SELECT sale_id, lot_id, shares_sold FROM sale_allocations WHERE sale_id IN (" +
                    sales.joinToString(",") { "?" } + ") ORDER BY sale_id, lot_id"
            ).use { stmt ->
                sales.forEachIndexed { i, sale -> stmt.setLong(i + 1, sale.id.value) }
                val rs = stmt.executeQuery()
                while (rs.next()) {
                    allocations.getOrPut(rs.getLong("sale_id")) { mutableListOf() }
                        .add(LotId(rs.getLong("lot_id")) to Quantity.of(rs.getBigDecimal("shares_sold")))
                }
            }
            sales.map { it.copy(allocations = allocations[it.id.value].orEmpty()) }
        }

    private fun ResultSet.toRecord(): SaleRecord {
        val currency = CurrencyUnit.parse(getString("currency").trim())
        return SaleRecord(
            id = SaleId(getLong("id")),
            accountId = AccountId(getLong("account_id")),
            accountName = getString("account_name"),
            brokerName = getString("broker_name"),
            securityId = SecurityId(getLong("security_id")),
            saleDate = getObject("sale_date", LocalDate::class.java),
            pricePerShare = Money.of(getBigDecimal("price_per_share"), currency),
            saleCosts = Money.of(getBigDecimal("sale_costs"), currency),
            allocations = emptyList(),
        )
    }

    private companion object {
        const val SELECT =
            "SELECT s.id, s.account_id, a.name AS account_name, b.name AS broker_name, " +
                "s.security_id, s.sale_date, s.price_per_share, s.sale_costs, a.currency " +
                "FROM sales s JOIN accounts a ON a.id = s.account_id " +
                "JOIN brokers b ON b.id = a.broker_id"
    }
}
