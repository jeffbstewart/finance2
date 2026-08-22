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
import org.jdbi.v3.core.Handle
import org.jdbi.v3.core.Jdbi

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
class SaleRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun list(
        portfolioId: PortfolioId,
        accountId: AccountId? = null,
        securityId: SecurityId? = null,
    ): List<SaleRecord> = jdbi.sql { handle ->
        val query = handle.createQuery(
            SELECT + " WHERE b.portfolio_id = :portfolioId" +
                (if (accountId != null) " AND s.account_id = :accountId" else "") +
                (if (securityId != null) " AND s.security_id = :securityId" else "") +
                " ORDER BY s.sale_date, s.id"
        ).bind("portfolioId", portfolioId.value)
        if (accountId != null) query.bind("accountId", accountId.value)
        if (securityId != null) query.bind("securityId", securityId.value)
        withAllocations(handle, query.map { rs, _ -> rs.toRecord() }.list())
    }

    /** Sales in [from]..[to] from taxable accounts only (spec sec. 5.3). */
    fun listForTaxReport(portfolioId: PortfolioId, from: LocalDate, to: LocalDate): List<SaleRecord> =
        jdbi.sql { handle ->
            val sales = handle.createQuery(
                "$SELECT WHERE b.portfolio_id = :portfolioId AND NOT a.tax_deferred " +
                    "AND s.sale_date >= :from AND s.sale_date <= :to ORDER BY s.sale_date, s.id"
            )
                .bind("portfolioId", portfolioId.value)
                .bind("from", from)
                .bind("to", to)
                .map { rs, _ -> rs.toRecord() }
                .list()
            withAllocations(handle, sales)
        }

    fun find(id: SaleId, portfolioId: PortfolioId): SaleRecord? = jdbi.sql { handle ->
        val sales = handle.createQuery("$SELECT WHERE s.id = :id AND b.portfolio_id = :portfolioId")
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRecord() }
            .list()
        withAllocations(handle, sales).singleOrNull()
    }

    /** Inserts the sale and its allocations atomically. */
    fun create(
        accountId: AccountId,
        securityId: SecurityId,
        saleDate: LocalDate,
        pricePerShare: Money,
        saleCosts: Money,
        allocations: List<Pair<LotId, Quantity>>,
    ): SaleId = jdbi.sqlTransaction { handle ->
        val saleId = handle.createUpdate(
            "INSERT INTO sales (account_id, security_id, sale_date, price_per_share, sale_costs) " +
                "VALUES (:accountId, :securityId, :saleDate, :pricePerShare, :saleCosts)"
        )
            .bind("accountId", accountId.value)
            .bind("securityId", securityId.value)
            .bind("saleDate", saleDate)
            .bind("pricePerShare", pricePerShare.amount)
            .bind("saleCosts", saleCosts.amount)
            .executeAndReturnGeneratedKeys("id")
            .mapTo(Long::class.java)
            .one()
        val batch = handle.prepareBatch(
            "INSERT INTO sale_allocations (sale_id, lot_id, shares_sold) VALUES (:saleId, :lotId, :shares)"
        )
        for ((lotId, shares) in allocations) {
            batch.bind("saleId", saleId).bind("lotId", lotId.value).bind("shares", shares.amount).add()
        }
        batch.execute()
        SaleId(saleId)
    }

    /** Deletes the sale and its allocations atomically. */
    fun delete(id: SaleId): Boolean = jdbi.sqlTransaction { handle ->
        handle.createUpdate("DELETE FROM sale_allocations WHERE sale_id = :id")
            .bind("id", id.value)
            .execute()
        handle.createUpdate("DELETE FROM sales WHERE id = :id")
            .bind("id", id.value)
            .execute() > 0
    }

    private fun withAllocations(handle: Handle, sales: List<SaleRecord>): List<SaleRecord> {
        if (sales.isEmpty()) return sales
        val allocations = linkedMapOf<Long, MutableList<Pair<LotId, Quantity>>>()
        handle.createQuery(
            "SELECT sale_id, lot_id, shares_sold FROM sale_allocations " +
                "WHERE sale_id IN (<saleIds>) ORDER BY sale_id, lot_id"
        )
            .bindList("saleIds", sales.map { it.id.value })
            .map { rs, _ ->
                Triple(
                    rs.getLong("sale_id"),
                    LotId(rs.getLong("lot_id")),
                    Quantity.of(rs.getBigDecimal("shares_sold")),
                )
            }
            .forEach { (saleId, lotId, shares) ->
                allocations.getOrPut(saleId) { mutableListOf() }.add(lotId to shares)
            }
        return sales.map { it.copy(allocations = allocations[it.id.value].orEmpty()) }
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
