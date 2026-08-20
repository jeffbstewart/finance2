package net.stewart.finance.ops

import java.time.Duration
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import org.slf4j.LoggerFactory

/**
 * The deployment is one durable, always-running container (ruling
 * 2026-08-19), so background refresh needs nothing fancier than a
 * fixed-rate daemon thread: run shortly after startup, then every
 * [period]; a failing pass logs and never kills the schedule (spec
 * §10 startup resilience — external fetches degrade the feature, not
 * the process).
 */
class PeriodicJob(
    private val name: String,
    private val period: Duration,
    private val initialDelay: Duration = Duration.ofSeconds(15),
    private val task: () -> Unit,
) {
    private val log = LoggerFactory.getLogger(PeriodicJob::class.java)
    private var executor: ScheduledExecutorService? = null

    /** One pass; failures are logged, never thrown. */
    fun runOnce() {
        runCatching(task).onFailure { log.warn("job \"{}\" failed; retrying next period", name, it) }
    }

    fun start() {
        check(executor == null) { "job \"$name\" already started" }
        executor = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, name).apply { isDaemon = true }
        }.also {
            it.scheduleAtFixedRate(::runOnce, initialDelay.seconds, period.seconds, TimeUnit.SECONDS)
        }
        log.info("job \"{}\" scheduled every {}", name, period)
    }

    fun stop() {
        executor?.shutdownNow()
        executor = null
    }
}
