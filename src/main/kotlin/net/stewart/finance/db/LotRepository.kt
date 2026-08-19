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
import net.stewart.finance.domain.SecurityId

data class LotRecord(
    val id: LotId,
    val accountId: AccountId,
    val accountName: String,
    val securityId: SecurityId,
    val dateBought: LocalDate,
    val quantity: Quantity,
    val pricePerShare: Money,
    val purchaseCosts: Money,
)

/**
 * Purchase lots — the tax record for taxable accounts (build-scope
 * §1). Money currency comes from the owning account's row in the same
 * query, never from a caller.
 */
class LotRepository(private val dataSource: DataSource) {

    fun list(
        portfolioId: PortfolioId,
        accountId: AccountId? = null,
        securityId: SecurityId? = null,
    ): List<LotRecord> =
        dataSource.connection.use { conn ->
            val sql = SELECT + " WHERE b.portfolio_id = ?" +
                (if (accountId != null) " AND l.account_id = ?" else "") +
                (if (securityId != null) " AND l.security_id = ?" else "") +
                " ORDER BY l.date_bought, l.id"
            conn.prepareStatement(sql).use { stmt ->
                var i = 1
                stmt.setLong(i++, portfolioId.value)
                if (accountId != null) stmt.setLong(i++, accountId.value)
                if (securityId != null) stmt.setLong(i, securityId.value)
                val rs = stmt.executeQuery()
                buildList { while (rs.next()) add(rs.toRecord()) }
            }
        }

    fun find(id: LotId, portfolioId: PortfolioId): LotRecord? =
        dataSource.connection.use { conn ->
            conn.prepareStatement("$SELECT WHERE l.id = ? AND b.portfolio_id = ?").use { stmt ->
                stmt.setLong(1, id.value)
                stmt.setLong(2, portfolioId.value)
                val rs = stmt.executeQuery()
                if (rs.next()) rs.toRecord() else null
            }
        }

    fun create(
        accountId: AccountId,
        securityId: SecurityId,
        dateBought: LocalDate,
        quantity: Quantity,
        pricePerShare: Money,
        purchaseCosts: Money,
    ): LotId =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "INSERT INTO purchase_lots (account_id, security_id, date_bought, quantity, " +
                    "price_per_share, purchase_costs) VALUES (?, ?, ?, ?, ?, ?)",
                java.sql.Statement.RETURN_GENERATED_KEYS,
            ).use { stmt ->
                stmt.setLong(1, accountId.value)
                stmt.setLong(2, securityId.value)
                stmt.setObject(3, dateBought)
                stmt.setBigDecimal(4, quantity.amount)
                stmt.setBigDecimal(5, pricePerShare.amount)
                stmt.setBigDecimal(6, purchaseCosts.amount)
                stmt.executeUpdate()
                LotId(stmt.generatedKeys.also { check(it.next()) }.getLong(1))
            }
        }

    /** Account and security are immutable (guard rail §5.9). */
    fun update(
        id: LotId,
        dateBought: LocalDate,
        quantity: Quantity,
        pricePerShare: Money,
        purchaseCosts: Money,
    ): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "UPDATE purchase_lots SET date_bought = ?, quantity = ?, price_per_share = ?, " +
                    "purchase_costs = ? WHERE id = ?"
            ).use { stmt ->
                stmt.setObject(1, dateBought)
                stmt.setBigDecimal(2, quantity.amount)
                stmt.setBigDecimal(3, pricePerShare.amount)
                stmt.setBigDecimal(4, purchaseCosts.amount)
                stmt.setLong(5, id.value)
                stmt.executeUpdate() > 0
            }
        }

    fun delete(id: LotId): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement("DELETE FROM purchase_lots WHERE id = ?").use { stmt ->
                stmt.setLong(1, id.value)
                stmt.executeUpdate() > 0
            }
        }

    /** True when any sale allocation references the lot. */
    fun hasSales(id: LotId): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement("SELECT 1 FROM sale_allocations WHERE lot_id = ? LIMIT 1").use { stmt ->
                stmt.setLong(1, id.value)
                stmt.executeQuery().next()
            }
        }

    private fun ResultSet.toRecord(): LotRecord {
        val currency = CurrencyUnit.parse(getString("currency").trim())
        return LotRecord(
            id = LotId(getLong("id")),
            accountId = AccountId(getLong("account_id")),
            accountName = getString("account_name"),
            securityId = SecurityId(getLong("security_id")),
            dateBought = getObject("date_bought", LocalDate::class.java),
            quantity = Quantity.of(getBigDecimal("quantity")),
            pricePerShare = Money.of(getBigDecimal("price_per_share"), currency),
            purchaseCosts = Money.of(getBigDecimal("purchase_costs"), currency),
        )
    }

    private companion object {
        const val SELECT =
            "SELECT l.id, l.account_id, a.name AS account_name, l.security_id, l.date_bought, " +
                "l.quantity, l.price_per_share, l.purchase_costs, a.currency " +
                "FROM purchase_lots l JOIN accounts a ON a.id = l.account_id " +
                "JOIN brokers b ON b.id = a.broker_id"
    }
}
