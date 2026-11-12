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
import org.jdbi.v3.core.Jdbi

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
 * Purchase lots - the tax record for taxable accounts (build-scope
 * sec. 1). Money currency comes from the owning account's row in the same
 * query, never from a caller.
 */
class LotRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun list(
        portfolioId: PortfolioId,
        accountId: AccountId? = null,
        securityId: SecurityId? = null,
    ): List<LotRecord> = jdbi.sql { handle ->
        val query = handle.createQuery(
            SELECT + " WHERE b.portfolio_id = :portfolioId" +
                (if (accountId != null) " AND l.account_id = :accountId" else "") +
                (if (securityId != null) " AND l.security_id = :securityId" else "") +
                " ORDER BY l.date_bought, l.id"
        ).bind("portfolioId", portfolioId.value)
        if (accountId != null) query.bind("accountId", accountId.value)
        if (securityId != null) query.bind("securityId", securityId.value)
        query.map { rs, _ -> rs.toRecord() }.list()
    }

    fun find(id: LotId, portfolioId: PortfolioId): LotRecord? = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE l.id = :id AND b.portfolio_id = :portfolioId")
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRecord() }
            .findOne()
            .orElse(null)
    }

    fun create(
        accountId: AccountId,
        securityId: SecurityId,
        dateBought: LocalDate,
        quantity: Quantity,
        pricePerShare: Money,
        purchaseCosts: Money,
    ): LotId = jdbi.sql { handle ->
        LotId(
            handle.createUpdate(
                "INSERT INTO purchase_lots (account_id, security_id, date_bought, quantity, " +
                    "price_per_share, purchase_costs) " +
                    "VALUES (:accountId, :securityId, :dateBought, :quantity, :pricePerShare, :purchaseCosts)"
            )
                .bind("accountId", accountId.value)
                .bind("securityId", securityId.value)
                .bind("dateBought", dateBought)
                .bind("quantity", quantity.amount)
                .bind("pricePerShare", pricePerShare.amount)
                .bind("purchaseCosts", purchaseCosts.amount)
                .executeAndReturnGeneratedKeys("id")
                .mapTo(Long::class.java)
                .one()
        )
    }

    /** Account and security are immutable (guard rail sec. 5.9). */
    fun update(
        id: LotId,
        dateBought: LocalDate,
        quantity: Quantity,
        pricePerShare: Money,
        purchaseCosts: Money,
    ): Boolean = jdbi.sql { handle ->
        handle.createUpdate(
            "UPDATE purchase_lots SET date_bought = :dateBought, quantity = :quantity, " +
                "price_per_share = :pricePerShare, purchase_costs = :purchaseCosts WHERE id = :id"
        )
            .bind("dateBought", dateBought)
            .bind("quantity", quantity.amount)
            .bind("pricePerShare", pricePerShare.amount)
            .bind("purchaseCosts", purchaseCosts.amount)
            .bind("id", id.value)
            .execute() > 0
    }

    fun delete(id: LotId): Boolean = jdbi.sql { handle ->
        handle.createUpdate("DELETE FROM purchase_lots WHERE id = :id")
            .bind("id", id.value)
            .execute() > 0
    }

    /** True when any sale allocation references the lot. */
    fun hasSales(id: LotId): Boolean = jdbi.sql { handle ->
        handle.createQuery("SELECT 1 FROM sale_allocations WHERE lot_id = :id LIMIT 1")
            .bind("id", id.value)
            .mapTo(Int::class.java)
            .findOne()
            .isPresent
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
