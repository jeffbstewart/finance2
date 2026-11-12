package net.stewart.finance

import io.micrometer.core.instrument.Gauge
import io.micrometer.core.instrument.MeterRegistry
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import net.stewart.finance.proto.GetInfoRequest
import net.stewart.finance.proto.GetInfoResponse
import net.stewart.finance.proto.InfoServiceGrpcKt

const val APP_VERSION = "0.1.0"

/**
 * What was built, baked into the image by CI (Dockerfile build args ->
 * FINANCE2_BUILD_* env). The pull request number is the handle a human
 * remembers; the commit time says how old the build is; the short
 * commit is there for the rare dispute. A local `docker compose
 * --build` or `gradlew run` has none of these and reports "dev".
 */
data class BuildInfo(
    val pullRequest: Int,
    val commit: String,
    val builtAt: OffsetDateTime?,
) {
    /** One line for the UI corner: "PR #82 - 2026-08-22 02:30 UTC - 7d470c5". */
    val label: String
        get() {
            if (pullRequest == 0 && commit.isEmpty() && builtAt == null) return "dev build"
            val parts = mutableListOf<String>()
            if (pullRequest > 0) parts += "PR #$pullRequest"
            builtAt?.let { parts += it.withOffsetSameInstant(ZoneOffset.UTC).format(STAMP) + " UTC" }
            if (commit.isNotEmpty()) parts += commit
            return parts.joinToString(" - ")
        }

    /**
     * The stamp as Prometheus gauges, so a dashboard can say which PR
     * each scrape target runs and how old the build is:
     *
     *   finance2_build_pull_request{commit="7d470c5"}  82   (0 for a dev build)
     *   finance2_build_timestamp_seconds{commit="..."} 1.77e9 (commit time; 0 for dev)
     *
     * The commit rides as a label on both; its value is constant for
     * the process's life, so the cardinality is one series per build.
     */
    fun bindTo(registry: MeterRegistry) {
        val commitLabel = commit.ifEmpty { "dev" }
        Gauge.builder("finance2_build_pull_request", this) { it.pullRequest.toDouble() }
            .description("The pull request this server was built from; 0 for a build made outside CI")
            .tag("commit", commitLabel)
            .register(registry)
        Gauge.builder("finance2_build_timestamp_seconds", this) { it.builtAt?.toEpochSecond()?.toDouble() ?: 0.0 }
            .description("Commit time of the build, seconds since the epoch; 0 for a build made outside CI")
            .tag("commit", commitLabel)
            .register(registry)
    }

    companion object {
        private val STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

        val DEV = BuildInfo(0, "", null)

        /** Reads FINANCE2_BUILD_PR / _COMMIT / _TIME; anything unparseable
         *  is treated as absent rather than failing the boot. */
        fun fromEnv(env: (String) -> String? = System::getenv): BuildInfo = BuildInfo(
            pullRequest = env("FINANCE2_BUILD_PR")?.trim()?.toIntOrNull() ?: 0,
            commit = env("FINANCE2_BUILD_COMMIT")?.trim().orEmpty().take(12),
            builtAt = env("FINANCE2_BUILD_TIME")?.trim()?.takeIf { it.isNotEmpty() }?.let {
                runCatching { OffsetDateTime.parse(it) }.getOrNull()
            },
        )
    }
}

class InfoGrpcService(
    private val build: BuildInfo = BuildInfo.DEV,
) : InfoServiceGrpcKt.InfoServiceCoroutineImplBase() {
    override suspend fun getInfo(request: GetInfoRequest): GetInfoResponse {
        val builder = GetInfoResponse.newBuilder()
            .setVersion(APP_VERSION)
            .setBuild(build.label)
            .setPullRequest(build.pullRequest)
            .setCommit(build.commit)
        build.builtAt?.let { builder.setBuiltAt(it.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)) }
        return builder.build()
    }
}
