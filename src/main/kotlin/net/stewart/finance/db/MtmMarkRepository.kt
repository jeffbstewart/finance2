package net.stewart.finance.db

import java.math.BigDecimal
import java.sql.ResultSet
import java.time.LocalDate
import javax.sql.DataSource
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.MtmMarkId
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import org.jdbi.v3.core.Jdbi

data class MtmMarkRecord(
    val id: MtmMarkId,
    val securityId: SecurityId,
    val taxYear: Int,
    val markDate: LocalDate,
    val quantity: Quantity,
    /** Year-end FMV in the security's currency. */
    val fmvLocal: Money,
    /** USD per one unit of the security's currency, as filed. */
    val fxRate: BigDecimal,
    val fmvUsd: Money,
    val basisBeforeUsd: Money,
    val basisAfterUsd: Money,
    val ordinaryIncomeUsd: Money,
)

/**
 * The per-security mark-to-market ledger (build-scope §11): one row
 * per elected security per tax year, in filing order. USD amounts are
 * the tax truth; the local FMV and FX rate record how they were
 * derived.
 */
class MtmMarkRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    /** Year-ascending marks for one security. */
    fun listForSecurity(securityId: SecurityId): List<MtmMarkRecord> = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE m.security_id = :securityId ORDER BY m.tax_year")
            .bind("securityId", securityId.value)
            .map { rs, _ -> rs.toRecord() }
            .list()
    }

    /** Marks across the portfolio whose mark date falls in [from, to]. */
    fun listForTaxReport(
        portfolioId: PortfolioId,
        from: LocalDate,
        to: LocalDate,
    ): List<MtmMarkRecord> = jdbi.sql { handle ->
        handle.createQuery(
            "$SELECT WHERE s.portfolio_id = :portfolioId " +
                "AND m.mark_date >= :from AND m.mark_date <= :to ORDER BY m.mark_date, m.id"
        )
            .bind("portfolioId", portfolioId.value)
            .bind("from", from)
            .bind("to", to)
            .map { rs, _ -> rs.toRecord() }
            .list()
    }

    fun find(id: MtmMarkId, portfolioId: PortfolioId): MtmMarkRecord? = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE m.id = :id AND s.portfolio_id = :portfolioId")
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRecord() }
            .findOne()
            .orElse(null)
    }

    /** Throws SQLException on a duplicate (security, tax year). */
    fun create(
        securityId: SecurityId,
        taxYear: Int,
        markDate: LocalDate,
        quantity: Quantity,
        fmvLocal: Money,
        fxRate: BigDecimal,
        fmvUsd: Money,
        basisBeforeUsd: Money,
        basisAfterUsd: Money,
        ordinaryIncomeUsd: Money,
    ): MtmMarkId = jdbi.sql { handle ->
        MtmMarkId(
            handle.createUpdate(
                "INSERT INTO mtm_marks (security_id, tax_year, mark_date, quantity, fmv_local, " +
                    "fx_rate, fmv_usd, basis_before_usd, basis_after_usd, ordinary_income_usd) " +
                    "VALUES (:securityId, :taxYear, :markDate, :quantity, :fmvLocal, " +
                    ":fxRate, :fmvUsd, :basisBefore, :basisAfter, :ordinaryIncome)"
            )
                .bind("securityId", securityId.value)
                .bind("taxYear", taxYear)
                .bind("markDate", markDate)
                .bind("quantity", quantity.amount)
                .bind("fmvLocal", fmvLocal.amount)
                .bind("fxRate", fxRate)
                .bind("fmvUsd", fmvUsd.amount)
                .bind("basisBefore", basisBeforeUsd.amount)
                .bind("basisAfter", basisAfterUsd.amount)
                .bind("ordinaryIncome", ordinaryIncomeUsd.amount)
                .executeAndReturnGeneratedKeys("id")
                .mapTo(Long::class.java)
                .one()
        )
    }

    fun delete(id: MtmMarkId): Boolean = jdbi.sql { handle ->
        handle.createUpdate("DELETE FROM mtm_marks WHERE id = :id")
            .bind("id", id.value)
            .execute() > 0
    }

    /** True when the security has any marks (guards the LOTS revert). */
    fun hasMarks(securityId: SecurityId): Boolean = jdbi.sql { handle ->
        handle.createQuery("SELECT 1 FROM mtm_marks WHERE security_id = :securityId LIMIT 1")
            .bind("securityId", securityId.value)
            .mapTo(Int::class.java)
            .findFirst()
            .isPresent
    }

    private fun ResultSet.toRecord(): MtmMarkRecord {
        val local = CurrencyUnit.parse(getString("currency").trim())
        val usd = CurrencyUnit.USD
        return MtmMarkRecord(
            id = MtmMarkId(getLong("id")),
            securityId = SecurityId(getLong("security_id")),
            taxYear = getInt("tax_year"),
            markDate = getObject("mark_date", LocalDate::class.java),
            quantity = Quantity.of(getBigDecimal("quantity")),
            fmvLocal = Money.of(getBigDecimal("fmv_local"), local),
            fxRate = getBigDecimal("fx_rate"),
            fmvUsd = Money.of(getBigDecimal("fmv_usd"), usd),
            basisBeforeUsd = Money.of(getBigDecimal("basis_before_usd"), usd),
            basisAfterUsd = Money.of(getBigDecimal("basis_after_usd"), usd),
            ordinaryIncomeUsd = Money.of(getBigDecimal("ordinary_income_usd"), usd),
        )
    }

    private companion object {
        const val SELECT =
            "SELECT m.id, m.security_id, m.tax_year, m.mark_date, m.quantity, m.fmv_local, " +
                "m.fx_rate, m.fmv_usd, m.basis_before_usd, m.basis_after_usd, " +
                "m.ordinary_income_usd, s.currency " +
                "FROM mtm_marks m JOIN securities s ON s.id = m.security_id"
    }
}
