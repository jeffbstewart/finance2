package net.stewart.finance.db

import java.math.BigDecimal
import java.sql.ResultSet
import java.time.OffsetDateTime
import javax.sql.DataSource
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.PlanId
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.SecurityId
import org.jdbi.v3.core.Jdbi

enum class PlanStatus {
    OPEN,
    ARCHIVED;

    companion object {
        fun parse(dbValue: String): PlanStatus =
            entries.firstOrNull { it.name == dbValue }
                ?: throw IllegalArgumentException("unknown plan status \"$dbValue\" in database")
    }
}

data class PlanRecord(
    val id: PlanId,
    val name: String,
    val status: PlanStatus,
    val createdAt: OffsetDateTime,
    val updatedAt: OffsetDateTime,
    val lastPrintedAt: OffsetDateTime?,
    val stepCount: Int,
)

/** A step as stored: the human's entry, nothing derived. */
data class PlanStepRecord(
    val id: Long,
    val position: Int,
    val kind: String,
    val accountId: AccountId,
    val toAccountId: AccountId?,
    val securityId: SecurityId?,
    val shares: BigDecimal?,
    val amount: BigDecimal?,
    val note: String,
)

/** Input for replacing a plan's steps. */
data class PlanStepInput(
    val kind: String,
    val accountId: AccountId,
    val toAccountId: AccountId?,
    val securityId: SecurityId?,
    val shares: BigDecimal?,
    val amount: BigDecimal?,
    val note: String,
)

/**
 * Trading plans (docs/design/trading-plan.md): the human's entries,
 * portfolio-scoped. Scoring is the rules' job; nothing derived is
 * stored, so a plan always scores against current prices.
 */
class TradingPlanRepository(dataSource: DataSource) {

    private val jdbi = Jdbi.create(dataSource)

    /** Newest first (by id: creation order is what "newest" means). */
    fun list(portfolioId: PortfolioId, includeArchived: Boolean): List<PlanRecord> = jdbi.sql { handle ->
        handle.createQuery(
            "$SELECT WHERE p.portfolio_id = :portfolioId" +
                (if (includeArchived) "" else " AND p.status = 'OPEN'") +
                " ORDER BY p.id DESC"
        )
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRecord() }
            .list()
    }

    fun find(id: PlanId, portfolioId: PortfolioId): PlanRecord? = jdbi.sql { handle ->
        handle.createQuery("$SELECT WHERE p.id = :id AND p.portfolio_id = :portfolioId")
            .bind("id", id.value)
            .bind("portfolioId", portfolioId.value)
            .map { rs, _ -> rs.toRecord() }
            .findOne()
            .orElse(null)
    }

    fun create(portfolioId: PortfolioId, name: String): PlanId = jdbi.sql { handle ->
        PlanId(
            handle.createUpdate("INSERT INTO trading_plans (portfolio_id, name) VALUES (:portfolioId, :name)")
                .bind("portfolioId", portfolioId.value)
                .bind("name", name)
                .executeAndReturnGeneratedKeys("id")
                .mapTo(Long::class.java)
                .one()
        )
    }

    fun rename(id: PlanId, name: String): Boolean = jdbi.sql { handle ->
        handle.createUpdate("UPDATE trading_plans SET name = :name, updated_at = CURRENT_TIMESTAMP WHERE id = :id")
            .bind("name", name)
            .bind("id", id.value)
            .execute() > 0
    }

    fun setStatus(id: PlanId, status: PlanStatus): Boolean = jdbi.sql { handle ->
        handle.createUpdate("UPDATE trading_plans SET status = :status, updated_at = CURRENT_TIMESTAMP WHERE id = :id")
            .bind("status", status.name)
            .bind("id", id.value)
            .execute() > 0
    }

    fun markPrinted(id: PlanId): Boolean = jdbi.sql { handle ->
        handle.createUpdate("UPDATE trading_plans SET last_printed_at = CURRENT_TIMESTAMP WHERE id = :id")
            .bind("id", id.value)
            .execute() > 0
    }

    fun delete(id: PlanId): Boolean = jdbi.sql { handle ->
        handle.createUpdate("DELETE FROM trading_plans WHERE id = :id")
            .bind("id", id.value)
            .execute() > 0
    }

    fun steps(id: PlanId): List<PlanStepRecord> = jdbi.sql { handle ->
        handle.createQuery(
            "SELECT id, position, kind, account_id, to_account_id, security_id, shares, amount, note " +
                "FROM trading_plan_steps WHERE plan_id = :id ORDER BY position"
        )
            .bind("id", id.value)
            .map { rs, _ -> rs.toStep() }
            .list()
    }

    /** Replaces every step, in the given order, in one transaction. */
    fun replaceSteps(id: PlanId, steps: List<PlanStepInput>) {
        jdbi.sqlTransaction { handle ->
            handle.createUpdate("DELETE FROM trading_plan_steps WHERE plan_id = :id").bind("id", id.value).execute()
            steps.forEachIndexed { index, step ->
                handle.createUpdate(
                    "INSERT INTO trading_plan_steps " +
                        "(plan_id, position, kind, account_id, to_account_id, security_id, shares, amount, note) " +
                        "VALUES (:planId, :position, :kind, :accountId, :toAccountId, :securityId, :shares, :amount, :note)"
                )
                    .bind("planId", id.value)
                    .bind("position", index + 1)
                    .bind("kind", step.kind)
                    .bind("accountId", step.accountId.value)
                    .bind("toAccountId", step.toAccountId?.value)
                    .bind("securityId", step.securityId?.value)
                    .bind("shares", step.shares)
                    .bind("amount", step.amount)
                    .bind("note", step.note)
                    .execute()
            }
            handle.createUpdate("UPDATE trading_plans SET updated_at = CURRENT_TIMESTAMP WHERE id = :id")
                .bind("id", id.value).execute()
        }
    }

    private fun ResultSet.toRecord() = PlanRecord(
        id = PlanId(getLong("id")),
        name = getString("name"),
        status = PlanStatus.parse(getString("status")),
        createdAt = getObject("created_at", OffsetDateTime::class.java),
        updatedAt = getObject("updated_at", OffsetDateTime::class.java),
        lastPrintedAt = getObject("last_printed_at", OffsetDateTime::class.java),
        stepCount = getInt("step_count"),
    )

    private fun ResultSet.toStep() = PlanStepRecord(
        id = getLong("id"),
        position = getInt("position"),
        kind = getString("kind"),
        accountId = AccountId(getLong("account_id")),
        toAccountId = getObject("to_account_id", java.lang.Long::class.java)?.let { AccountId(it.toLong()) },
        securityId = getObject("security_id", java.lang.Long::class.java)?.let { SecurityId(it.toLong()) },
        shares = getBigDecimal("shares"),
        amount = getBigDecimal("amount"),
        note = getString("note"),
    )

    private companion object {
        const val SELECT =
            "SELECT p.id, p.name, p.status, p.created_at, p.updated_at, p.last_printed_at, " +
                "(SELECT COUNT(*) FROM trading_plan_steps s WHERE s.plan_id = p.id) AS step_count " +
                "FROM trading_plans p"
    }
}
