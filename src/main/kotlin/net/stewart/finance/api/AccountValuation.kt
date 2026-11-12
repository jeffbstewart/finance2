package net.stewart.finance.api

import java.time.LocalDate
import net.stewart.finance.db.AccountRow
import net.stewart.finance.db.HoldingRepository
import net.stewart.finance.db.LotRepository
import net.stewart.finance.db.SaleRepository
import net.stewart.finance.db.SecurityRepository
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.Money
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.Quantity
import net.stewart.finance.domain.SecurityId
import net.stewart.finance.rules.CLOSED_TOLERANCE
import net.stewart.finance.rules.Lot
import net.stewart.finance.rules.Sale
import net.stewart.finance.rules.SaleAllocation
import net.stewart.finance.rules.position
import org.slf4j.LoggerFactory

/**
 * The investment value of every account - the positions the Positions
 * page shows, valued the same way (lots through the sale rules,
 * holdings at quantity times price), summed per account in the
 * account's currency. Sweeps are not included: they are the
 * account's other number, and the views show both.
 *
 * A security without a price (a fresh manual one, a provider outage)
 * makes the Positions page fail loudly for that security; a list of
 * brokers must not. Such positions are skipped here and logged once
 * per call, so an unpriced security shows as "not yet counted" rather
 * than taking the whole page down.
 */
class AccountValuation(
    private val securities: SecurityRepository,
    private val lots: LotRepository,
    private val sales: SaleRepository,
    private val holdings: HoldingRepository,
    private val pricing: PricingService,
) {
    private val log = LoggerFactory.getLogger(AccountValuation::class.java)

    /** Investment value per account (account currency), for every
     *  account that holds anything; absent accounts hold nothing. */
    fun byAccount(portfolioId: PortfolioId, accounts: List<AccountRow>, today: LocalDate): Map<AccountId, Money> {
        val securityById = securities.list(portfolioId, includeHidden = true).associateBy { it.id }
        val prices = pricing.latestBySecurity(portfolioId, securityById.values)
        val lotsByAccount = lots.list(portfolioId, null).groupBy { it.accountId }
        val salesByAccount = sales.list(portfolioId, null).groupBy { it.accountId }
        val holdingsByAccount = holdings.list(portfolioId).groupBy { it.accountId }
        val unpriced = mutableSetOf<SecurityId>()

        val result = linkedMapOf<AccountId, Money>()
        for (account in accounts) {
            var value = Money.zero(account.currency)
            val lotsBySecurity = lotsByAccount[account.id].orEmpty().groupBy { it.securityId }
            val salesBySecurity = salesByAccount[account.id].orEmpty().groupBy { it.securityId }
            for ((securityId, lotRecords) in lotsBySecurity) {
                val price = prices[securityId] ?: run { unpriced += securityId; continue }
                val p = position(
                    lotRecords.map { Lot(it.id, it.dateBought, it.quantity, it.pricePerShare, it.purchaseCosts) },
                    salesBySecurity[securityId].orEmpty().map { s ->
                        Sale(s.id, s.saleDate, s.pricePerShare, s.saleCosts, s.allocations.map { (lotId, shares) -> SaleAllocation(lotId, shares) })
                    },
                    price,
                    today,
                )
                if (p.shares.abs() <= CLOSED_TOLERANCE) continue
                value += p.currentValue
            }
            for (holding in holdingsByAccount[account.id].orEmpty()) {
                if (holding.quantity == Quantity.ZERO) continue
                val price = prices[holding.securityId] ?: run { unpriced += holding.securityId; continue }
                value += price * holding.quantity
            }
            if (!value.isZero()) result[account.id] = value
        }
        if (unpriced.isNotEmpty()) {
            val tickers = unpriced.mapNotNull { securityById[it]?.ticker }.sorted()
            log.warn("account values omit unpriced securities: {}", tickers.joinToString(", "))
        }
        return result
    }
}
