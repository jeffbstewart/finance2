package net.stewart.finance.db

import java.sql.ResultSet
import javax.sql.DataSource
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.SecurityType

data class SecurityRow(
    val id: SecurityId,
    val ticker: String,
    val description: String,
    val currency: CurrencyUnit,
    val securityType: SecurityType,
    val pricingLocus: PricingLocus,
    val netExpenseRatio: Fraction?,
    val hidden: Boolean,
)

/** Securities, always portfolio-scoped. */
class SecurityRepository(private val dataSource: DataSource) {

    fun list(portfolioId: PortfolioId, includeHidden: Boolean): List<SecurityRow> =
        dataSource.connection.use { conn ->
            val sql = "$SELECT WHERE portfolio_id = ?" +
                (if (includeHidden) "" else " AND NOT hidden") + " ORDER BY ticker"
            conn.prepareStatement(sql).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                val rs = stmt.executeQuery()
                buildList { while (rs.next()) add(rs.toRow()) }
            }
        }

    fun find(id: SecurityId, portfolioId: PortfolioId): SecurityRow? =
        dataSource.connection.use { conn ->
            conn.prepareStatement("$SELECT WHERE id = ? AND portfolio_id = ?").use { stmt ->
                stmt.setLong(1, id.value)
                stmt.setLong(2, portfolioId.value)
                val rs = stmt.executeQuery()
                if (rs.next()) rs.toRow() else null
            }
        }

    /** Throws SQLException on a duplicate ticker within the portfolio. */
    fun create(portfolioId: PortfolioId, ticker: String, currency: CurrencyUnit): SecurityId =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "INSERT INTO securities (portfolio_id, ticker, currency) VALUES (?, ?, ?)",
                java.sql.Statement.RETURN_GENERATED_KEYS,
            ).use { stmt ->
                stmt.setLong(1, portfolioId.value)
                stmt.setString(2, ticker)
                stmt.setString(3, currency.code)
                stmt.executeUpdate()
                SecurityId(stmt.generatedKeys.also { check(it.next()) }.getLong(1))
            }
        }

    fun updateProfile(
        id: SecurityId,
        description: String,
        securityType: SecurityType,
        pricingLocus: PricingLocus,
        netExpenseRatio: Fraction?,
    ): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "UPDATE securities SET description = ?, security_type = ?, pricing_locus = ?, " +
                    "net_expense_ratio = ? WHERE id = ?"
            ).use { stmt ->
                stmt.setString(1, description)
                stmt.setString(2, securityType.name)
                stmt.setString(3, pricingLocus.name)
                stmt.setBigDecimal(4, netExpenseRatio?.value)
                stmt.setLong(5, id.value)
                stmt.executeUpdate() > 0
            }
        }

    fun setHidden(id: SecurityId, hidden: Boolean): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement("UPDATE securities SET hidden = ? WHERE id = ?").use { stmt ->
                stmt.setBoolean(1, hidden)
                stmt.setLong(2, id.value)
                stmt.executeUpdate() > 0
            }
        }

    /** True when any lot or holding references the security. */
    fun hasPositions(id: SecurityId): Boolean =
        dataSource.connection.use { conn ->
            conn.prepareStatement(
                "SELECT 1 FROM purchase_lots WHERE security_id = ? " +
                    "UNION ALL SELECT 1 FROM holdings WHERE security_id = ? LIMIT 1"
            ).use { stmt ->
                stmt.setLong(1, id.value)
                stmt.setLong(2, id.value)
                stmt.executeQuery().next()
            }
        }

    private fun ResultSet.toRow() = SecurityRow(
        id = SecurityId(getLong("id")),
        ticker = getString("ticker"),
        description = getString("description"),
        currency = CurrencyUnit.parse(getString("currency").trim()),
        securityType = SecurityType.parse(getString("security_type")),
        pricingLocus = PricingLocus.parse(getString("pricing_locus")),
        netExpenseRatio = getBigDecimal("net_expense_ratio")?.let { Fraction.of(it) },
        hidden = getBoolean("hidden"),
    )

    private companion object {
        const val SELECT =
            "SELECT id, ticker, description, currency, security_type, pricing_locus, " +
                "net_expense_ratio, hidden FROM securities"
    }
}
