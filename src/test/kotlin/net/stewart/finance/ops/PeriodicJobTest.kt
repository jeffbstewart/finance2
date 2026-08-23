package net.stewart.finance.ops

import java.time.Duration
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class PeriodicJobTest {
    @Test
    fun `startAfterFirstPass runs the task on the caller before returning`() {
        val runs = AtomicInteger()
        val caller = Thread.currentThread()
        var ranOn: Thread? = null
        val job = PeriodicJob("t", Duration.ofDays(1)) {
            ranOn = Thread.currentThread()
            runs.incrementAndGet()
        }
        job.startAfterFirstPass()
        try {
            assertEquals(1, runs.get())
            assertEquals(caller, ranOn)
        } finally {
            job.stop()
        }
    }

    @Test
    fun `startAfterFirstPass swallows a failing first pass`() {
        val job = PeriodicJob("t", Duration.ofDays(1)) { error("provider down") }
        job.startAfterFirstPass()
        job.stop()
    }

    @Test
    fun `start does not run the task inline`() {
        val runs = AtomicInteger()
        val job = PeriodicJob("t", Duration.ofDays(1), initialDelay = Duration.ofDays(1)) { runs.incrementAndGet() }
        job.start()
        try {
            assertEquals(0, runs.get())
            assertFailsWith<IllegalStateException> { job.start() }
        } finally {
            job.stop()
        }
    }
}
