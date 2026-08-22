package net.stewart.finance.db

import java.sql.ResultSet
import javax.sql.DataSource
import net.stewart.finance.domain.CurrencyUnit
import net.stewart.finance.domain.Fraction
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.PricingLocus
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.domain.SecurityType
import net.stewart.finance.domain.TaxTreatment
import org.jdbi.v3.core.Jdbi

/**
 * One security. [ticker] is the portfolio-unique symbol the human
 * chose - for a 401(k) trust a made-up one ("VBTIX-TR"); [marketTicker]
 * is what the price feeds are keyed on and is null for anything not
 * market-priced. [mirrorsSecurityId] names the public fund a trust is
 * the institutional class of (V010).
 */
data class SecurityRow(
    val id: SecurityId,
    val ticker: String,
    val description: String,
    val currency: CurrencyUnit,
    val securityType: SecurityType,
    val pricingLocus: PricingLocus,
    val taxTreatment: TaxTreatment,
    val netExpenseRatio: Fraction?,
    val hidden: Boolean,
    val marketTicker: String? = null,
    val cusip: String? = null,
    val isin: String? = null,
    val mirrorsSecurityId: SecurityId? = null,
) {
    /** The symbol a provider is asked for: the market ticker, else the
     *  symbol itself (pre-V010 rows and the default for MARKET locus). */
    val feedTicker: String get() = marketTicker ?: ticker
}

/** Securities, always portfolio-scoped. */
class SecurityRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    fun list(portfolioId: PortfolioId, includeHidden: Boolean): List<SecurityRow> = jdbi.sql { handle ->
        handle.createQuery(
            "$SELECT WHERE portfolio_id = :portfolioId" +
                (if (includeHidden) "" else " AND NOT hidden") + " ORDER BY ticker"
        )
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRow() }
            .list()
    }

    /** Every visible MARKET-locus security, portfolio-independent -
     *  the background price-prefetch job's work list. */
    fun listAllMarket(): List<SecurityRow> = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE pricing_locus = 'MARKET' AND NOT hidden ORDER BY ticker")
            .map { rs, _ -> rs.toRow() }
            .list()
    }

    fun find(id: SecurityId, portfolioId: PortfolioId): SecurityRow? = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE id = :id AND portfolio_id = :portfolioId")
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRow() }
            .findOne()
            .orElse(null)
    }

    /** Throws SQLException on a duplicate ticker within the portfolio. */
    fun create(portfolioId: PortfolioId, ticker: String, currency: CurrencyUnit): SecurityId =
        jdbi.sql { handle ->
            SecurityId(
                handle.createUpdate(
                    "INSERT INTO securities (portfolio_id, ticker, currency) " +
                        "VALUES (:portfolioId, :ticker, :currency)"
                )
                    .bind("portfolioId", portfolioId.value)
                    .bind("ticker", ticker)
                    .bind("currency", currency.code)
                    .executeAndReturnGeneratedKeys("id")
                    .mapTo(Long::class.java)
                    .one()
            )
        }

    fun updateProfile(
        id: SecurityId,
        description: String,
        securityType: SecurityType,
        pricingLocus: PricingLocus,
        taxTreatment: TaxTreatment,
        netExpenseRatio: Fraction?,
        marketTicker: String? = null,
        cusip: String? = null,
        isin: String? = null,
        mirrorsSecurityId: SecurityId? = null,
    ): Boolean = jdbi.sql { handle ->
        handle.createUpdate(
            "UPDATE securities SET description = :description, security_type = :securityType, " +
                "pricing_locus = :pricingLocus, tax_treatment = :taxTreatment, " +
                "net_expense_ratio = :netExpenseRatio, market_ticker = :marketTicker, " +
                "cusip = :cusip, isin = :isin, mirrors_security_id = :mirrors WHERE id = :id"
        )
            .bind("description", description)
            .bind("securityType", securityType.name)
            .bind("pricingLocus", pricingLocus.name)
            .bind("taxTreatment", taxTreatment.name)
            .bind("netExpenseRatio", netExpenseRatio?.value)
            .bind("marketTicker", marketTicker)
            .bind("cusip", cusip)
            .bind("isin", isin)
            .bind("mirrors", mirrorsSecurityId?.value)
            .bind("id", id.value)
            .execute() > 0
    }

    fun setHidden(id: SecurityId, hidden: Boolean): Boolean = jdbi.sql { handle ->
        handle.createUpdate("UPDATE securities SET hidden = :hidden WHERE id = :id")
            .bind("hidden", hidden)
            .bind("id", id.value)
            .execute() > 0
    }

    /** True when any lot or holding references the security. */
    fun hasPositions(id: SecurityId): Boolean = jdbi.sql { handle ->
        handle.createQuery(
            "SELECT 1 FROM purchase_lots WHERE security_id = :id " +
                "UNION ALL SELECT 1 FROM holdings WHERE security_id = :id LIMIT 1"
        )
            .bind("id", id.value)
            .mapTo(Int::class.java)
            .findFirst()
            .isPresent
    }

    /** True when another security names this one as its mirror. */
    fun isMirrored(id: SecurityId): Boolean = jdbi.sql { handle ->
        handle.createQuery("SELECT 1 FROM securities WHERE mirrors_security_id = :id LIMIT 1")
            .bind("id", id.value)
            .mapTo(Int::class.java)
            .findFirst()
            .isPresent
    }

    private fun ResultSet.toRow() = SecurityRow(
        id = SecurityId(getLong("id")),
        ticker = getString("ticker"),
        description = getString("description"),
        currency = CurrencyUnit.parse(getString("currency").trim()),
        securityType = SecurityType.parse(getString("security_type")),
        pricingLocus = PricingLocus.parse(getString("pricing_locus")),
        taxTreatment = TaxTreatment.parse(getString("tax_treatment")),
        netExpenseRatio = getBigDecimal("net_expense_ratio")?.let { Fraction.of(it) },
        hidden = getBoolean("hidden"),
        marketTicker = getString("market_ticker"),
        cusip = getString("cusip"),
        isin = getString("isin"),
        mirrorsSecurityId = getObject("mirrors_security_id", java.lang.Long::class.java)
            ?.let { SecurityId(it.toLong()) },
    )

    private companion object {
        const val SELECT =
            "SELECT id, ticker, description, currency, security_type, pricing_locus, " +
                "tax_treatment, net_expense_ratio, hidden, market_ticker, cusip, isin, " +
                "mirrors_security_id FROM securities"
    }
}
