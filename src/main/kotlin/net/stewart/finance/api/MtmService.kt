package net.stewart.finance.api

import io.grpc.Status
import io.grpc.StatusException
import java.math.BigDecimal
import java.sql.SQLException
import java.time.LocalDate
import net.stewart.finance.db.FxRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.MtmMarkRecord
import net.stewart.finance.db.MtmMarkRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRow
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.MtmMarkId
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.TaxTreatment
import net.stewart.finance.rules.computeMark

/**
 * The PFIC §1296 mark-to-market ledger logic (build-scope §11). All
 * USD figures flow through dated FX (never a silent 1:1); the basis
 * floor is total acquisition cost at purchase-date rates, which for a
 * single never-partially-sold position equals the unreversed-
 * inclusions loss limitation exactly.
 */
class MtmService(
    private val lots: LotRepository,
    private val sales: SaleRepository,
    private val marks: MtmMarkRepository,
    private val fx: FxRepository,
    private val reporting: ReportingCurrency,
    /** Date-ascending price history for a security ([PricingService.history]). */
    private val history: (SecurityRow) -> List<PricingService.HistoryPoint>,
) {

    data class Suggestion(
        val markDate: LocalDate,
        val quantity: Quantity,
        val fmvLocal: Money?,
        val fxRate: BigDecimal?,
        val computed: MtmMarkRecord?,
        val notes: List<String>,
    )

    fun listForSecurity(security: SecurityRow): List<MtmMarkRecord> =
        marks.listForSecurity(security.id)

    /** Total USD acquisition cost of lots bought on or before [asOf]. */
    fun acquisitionCostUsd(
        portfolioId: PortfolioId,
        security: SecurityRow,
        asOf: LocalDate = LocalDate.MAX,
    ): Money = lots.list(portfolioId, securityId = security.id)
        .filter { it.dateBought <= asOf }
        .fold(reporting.zero()) { acc, lot ->
            acc + reporting.toReporting(lot.pricePerShare * lot.quantity + lot.purchaseCosts, lot.dateBought)
        }

    /**
     * The proposed year-end mark from stored prices and FX. Whatever
     * the store cannot supply stays null with an explanatory note —
     * the ECB feed backfills only 90 days, so a past year's Dec 31
     * rate is often absent and gets entered by hand.
     */
    fun suggest(portfolioId: PortfolioId, security: SecurityRow, taxYear: Int): Suggestion {
        requireMtm(security)
        requireNoSales(portfolioId, security)
        val markDate = LocalDate.of(taxYear, 12, 31)
        val notes = mutableListOf<String>()

        val quantity = sharesHeld(portfolioId, security, markDate)
        if (quantity.isZero()) {
            notes += "no purchase lots on or before $markDate — record the purchase first"
        }

        val pricePoint = history(security).lastOrNull { it.date <= markDate }
        if (pricePoint == null) {
            notes += "no stored price on or before $markDate — enter the FMV by hand"
        } else if (pricePoint.date != markDate) {
            notes += "price from ${pricePoint.date} (latest on or before $markDate)"
        }

        val fxRate = fx.latestRate(security.currency, reporting.currency, markDate)
        if (fxRate == null) {
            notes += "no stored ${security.currency}->${reporting.currency} rate on or before " +
                "$markDate — enter the rate by hand"
        }

        val fmvLocal = pricePoint?.let {
            if (quantity.isZero()) null else Money.rounded(it.close.amount.multiply(quantity.amount), security.currency)
        }
        val computed = if (fmvLocal != null && fxRate != null) {
            computeRecord(portfolioId, security, taxYear, markDate, quantity, fmvLocal, fxRate)
        } else null
        return Suggestion(markDate, quantity, fmvLocal, fxRate, computed, notes)
    }

    /** Validates and persists the mark as filed; returns the stored row. */
    fun record(
        portfolioId: PortfolioId,
        security: SecurityRow,
        taxYear: Int,
        markDate: LocalDate,
        quantity: Quantity,
        fmvLocal: Money,
        fxRate: BigDecimal,
    ): MtmMarkRecord {
        requireMtm(security)
        requireNoSales(portfolioId, security)
        if (markDate.year != taxYear) {
            throw invalid("mark date $markDate is not in tax year $taxYear")
        }
        if (quantity.signum() <= 0) throw invalid("quantity must be positive")
        if (fmvLocal.signum() < 0) throw invalid("FMV must not be negative")
        if (fxRate.signum() <= 0) throw invalid("FX rate must be positive")
        val latest = marks.listForSecurity(security.id).lastOrNull()
        if (latest != null && latest.taxYear >= taxYear) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "marks must be recorded in tax-year order — the latest is ${latest.taxYear}"
                )
            )
        }
        val computed = computeRecord(portfolioId, security, taxYear, markDate, quantity, fmvLocal, fxRate)
        val id = try {
            marks.create(
                securityId = security.id,
                taxYear = taxYear,
                markDate = markDate,
                quantity = quantity,
                fmvLocal = fmvLocal,
                fxRate = fxRate,
                fmvUsd = computed.fmvUsd,
                basisBeforeUsd = computed.basisBeforeUsd,
                basisAfterUsd = computed.basisAfterUsd,
                ordinaryIncomeUsd = computed.ordinaryIncomeUsd,
            )
        } catch (e: SQLException) {
            throw StatusException(
                Status.ALREADY_EXISTS.withDescription("a $taxYear mark already exists for ${security.ticker}")
            )
        }
        return computed.copy(id = id)
    }

    /** Only the latest mark may go — the basis chain feeds forward. */
    fun delete(portfolioId: PortfolioId, markId: MtmMarkId): MtmMarkRecord {
        val mark = marks.find(markId, portfolioId)
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no mark ${markId.value}"))
        val latest = marks.listForSecurity(mark.securityId).last()
        if (latest.id != mark.id) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "only the latest mark (${latest.taxYear}) may be deleted — the basis chain feeds forward"
                )
            )
        }
        marks.delete(mark.id)
        return mark
    }

    /** Guard for sale mutations: rejected until sale-year treatment is ruled. */
    fun requireNoSales(portfolioId: PortfolioId, security: SecurityRow) {
        if (sales.list(portfolioId, securityId = security.id).isNotEmpty()) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "${security.ticker} has recorded sales, but sale-year treatment for " +
                        "mark-to-market securities is not yet ruled (build-scope §11)"
                )
            )
        }
    }

    private fun computeRecord(
        portfolioId: PortfolioId,
        security: SecurityRow,
        taxYear: Int,
        markDate: LocalDate,
        quantity: Quantity,
        fmvLocal: Money,
        fxRate: BigDecimal,
    ): MtmMarkRecord {
        val floor = acquisitionCostUsd(portfolioId, security, markDate)
        if (floor.isZero()) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "no purchase lots for ${security.ticker} on or before $markDate — record the purchase first"
                )
            )
        }
        val previous = marks.listForSecurity(security.id).lastOrNull { it.taxYear < taxYear }
        // Basis carries the prior mark forward plus any purchases since
        // it; the first mark starts from acquisition cost.
        val basisBefore = if (previous == null) floor else {
            previous.basisAfterUsd + lots.list(portfolioId, securityId = security.id)
                .filter { it.dateBought > previous.markDate && it.dateBought <= markDate }
                .fold(reporting.zero()) { acc, lot ->
                    acc + reporting.toReporting(
                        lot.pricePerShare * lot.quantity + lot.purchaseCosts,
                        lot.dateBought,
                    )
                }
        }
        val fmvUsd = Money.rounded(fmvLocal.amount.multiply(fxRate), reporting.currency)
        val computation = computeMark(fmvUsd, basisBefore, floor)
        return MtmMarkRecord(
            id = MtmMarkId(Long.MAX_VALUE), // placeholder until persisted
            securityId = security.id,
            taxYear = taxYear,
            markDate = markDate,
            quantity = quantity,
            fmvLocal = fmvLocal,
            fxRate = fxRate,
            fmvUsd = fmvUsd,
            basisBeforeUsd = computation.basisBefore,
            basisAfterUsd = computation.basisAfter,
            ordinaryIncomeUsd = computation.ordinaryIncome,
        )
    }

    private fun sharesHeld(portfolioId: PortfolioId, security: SecurityRow, asOf: LocalDate): Quantity =
        lots.list(portfolioId, securityId = security.id)
            .filter { it.dateBought <= asOf }
            .fold(Quantity.ZERO) { acc, lot -> acc + lot.quantity }

    private fun requireMtm(security: SecurityRow) {
        if (security.taxTreatment != TaxTreatment.MARK_TO_MARKET) {
            throw StatusException(
                Status.FAILED_PRECONDITION.withDescription(
                    "${security.ticker} is not marked-to-market — elect the treatment on its profile first"
                )
            )
        }
    }

    private fun invalid(message: String) =
        StatusException(Status.INVALID_ARGUMENT.withDescription(message))
}
