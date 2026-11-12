package net.stewart.finance.rules

import net.stewart.finance.domain.Money

/**
 * The one PFIC sec. 1296 mark computation (build-scope sec. 11): the year-end
 * mark takes the basis to FMV, floored at total acquisition cost - 
 * which, for a single position acquired once and never partially
 * sold, is exactly the unreversed-inclusions loss limitation. The
 * year's ordinary income is the basis movement (negative down to the
 * floor, never below).
 */
data class MarkComputation(
    val basisBefore: Money,
    val basisAfter: Money,
    val ordinaryIncome: Money,
)

fun computeMark(fmvUsd: Money, basisBefore: Money, acquisitionCostUsd: Money): MarkComputation {
    require(basisBefore >= acquisitionCostUsd) {
        "basis before ($basisBefore) below acquisition cost ($acquisitionCostUsd) - mark chain is corrupt"
    }
    val basisAfter = if (fmvUsd > acquisitionCostUsd) fmvUsd else acquisitionCostUsd
    return MarkComputation(
        basisBefore = basisBefore,
        basisAfter = basisAfter,
        ordinaryIncome = basisAfter - basisBefore,
    )
}
