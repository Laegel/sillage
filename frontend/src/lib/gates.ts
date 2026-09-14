// Pure aggregations behind the Gates section — where gate time goes and which
// tests are slow, getting slower, or flaky. No React, so gates.check.ts runs
// under plain Node.
import type { GateRun, GateTest } from '../types.ts'
import { median, percentile } from './metrics.ts'

const byStart = (runs: GateRun[]) => [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
const testKey = (t: GateTest) => `${t.suite}\n${t.name}`
const counted = (t: GateTest) => t.status !== 'skipped'

export function gateSummary(runs: GateRun[]) {
  const ordered = byStart(runs)
  const durations = ordered.map((r) => r.durationMs)
  return {
    runs: ordered.length,
    medianMs: median(durations),
    p90Ms: percentile(durations, 90),
    passRate: ordered.length ? ordered.filter((r) => r.exitCode === 0).length / ordered.length : undefined,
    lastRunId: ordered.at(-1)?.runId,
  }
}

// One series per step name (in first-seen order), a value per run oldest first;
// undefined where a run stopped before reaching that step.
export function stepSeries(runs: GateRun[]): { runIds: string[]; steps: { name: string; values: (number | undefined)[] }[] } {
  const ordered = byStart(runs)
  const names = [...new Set(ordered.flatMap((r) => r.steps.map((s) => s.name)))]
  return {
    runIds: ordered.map((r) => r.runId),
    steps: names.map((name) => ({ name, values: ordered.map((r) => r.steps.find((s) => s.name === name)?.durationMs) })),
  }
}

interface TestHistory {
  suite: string
  name: string
  samples: { runId: string; commit: string; durationMs: number; status: GateTest['status'] }[]
}

function histories(runs: GateRun[]): TestHistory[] {
  const map = new Map<string, TestHistory>()
  for (const run of byStart(runs)) {
    for (const test of run.tests.filter(counted)) {
      const entry = map.get(testKey(test)) ?? { suite: test.suite, name: test.name, samples: [] }
      entry.samples.push({ runId: run.runId, commit: run.commit, durationMs: test.durationMs, status: test.status })
      map.set(testKey(test), entry)
    }
  }
  return [...map.values()]
}

export function slowestTests(runs: GateRun[], limit = 10) {
  return histories(runs)
    .map((h) => {
      const durations = h.samples.map((s) => s.durationMs)
      return { suite: h.suite, name: h.name, medianMs: median(durations)!, p90Ms: percentile(durations, 90)!, runs: durations.length }
    })
    .sort((a, b) => b.medianMs - a.medianMs)
    .slice(0, limit)
}

// A test whose recent runs are clearly slower than its own history: at least
// `minRatio`× and `minDeltaMs` slower, with enough earlier samples to compare.
export function gettingSlower(runs: GateRun[], { recent = 5, minRatio = 1.5, minDeltaMs = 500, minEarlier = 3 } = {}) {
  return histories(runs)
    .flatMap((h) => {
      const earlier = h.samples.slice(0, -recent).map((s) => s.durationMs)
      const latest = h.samples.slice(-recent).map((s) => s.durationMs)
      if (earlier.length < minEarlier || latest.length < recent) return []
      const earlierMs = median(earlier)!
      const recentMs = median(latest)!
      return recentMs >= earlierMs * minRatio && recentMs - earlierMs >= minDeltaMs ? [{ suite: h.suite, name: h.name, earlierMs, recentMs }] : []
    })
    .sort((a, b) => b.recentMs - b.earlierMs - (a.recentMs - a.earlierMs))
}

// Passed and failed on the same commit — the code didn't change, the result did.
export function flakyTests(runs: GateRun[]) {
  return histories(runs).flatMap((h) => {
    const byCommit = new Map<string, Set<string>>()
    for (const s of h.samples) byCommit.set(s.commit, (byCommit.get(s.commit) ?? new Set()).add(s.status))
    const commit = [...byCommit].find(([, statuses]) => statuses.has('passed') && statuses.has('failed'))?.[0]
    return commit ? [{ suite: h.suite, name: h.name, commit }] : []
  })
}

export function testLoad(runs: GateRun[]) {
  return byStart(runs).map((r) => {
    const tests = r.tests.filter(counted)
    return { runId: r.runId, count: tests.length, totalMs: tests.reduce((sum, t) => sum + t.durationMs, 0) }
  })
}
