// Runnable check for the Gates view's aggregations: `node frontend/src/lib/gates.check.ts`.
import { flakyTests, gateSummary, gettingSlower, slowestTests, stepSeries, testLoad } from './gates.ts'
import type { GateRun, GateTest } from '../types.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const t = (name: string, durationMs: number, status: GateTest['status'] = 'passed'): GateTest => ({ suite: 's', name, durationMs, status })
let seq = 0
const run = (over: Partial<GateRun> = {}): GateRun => {
  seq++
  return {
    runId: `r${seq}`, gate: 'pre-push', startedAt: new Date(Date.UTC(2026, 8, 1, 0, seq)).toISOString(), durationMs: 1000, exitCode: 0,
    commit: `c${seq}`, branch: 'main', trigger: 'manual', steps: [], junit: [], tests: [], ...over,
  }
}

// 1. Summary (runs given out of order).
const a = run({ durationMs: 3000 }), b = run({ durationMs: 1000, exitCode: 1 }), c = run({ durationMs: 2000 })
expect('summary', gateSummary([c, a, b]), { runs: 3, medianMs: 2000, p90Ms: 3000, passRate: 2 / 3, lastRunId: c.runId })

// 2. Step series, oldest first, gaps where a run stopped early.
const s1 = run({ steps: [{ name: 'compile', durationMs: 50, exitCode: 0 }, { name: 'tests', durationMs: 10, exitCode: 0 }] })
const s2 = run({ steps: [{ name: 'compile', durationMs: 40, exitCode: 1 }] })
expect('step series', stepSeries([s2, s1]), { runIds: [s1.runId, s2.runId], steps: [{ name: 'compile', values: [50, 40] }, { name: 'tests', values: [10, undefined] }] })

// 3. Slowest tests by median, skipped ignored.
const slow = [run({ tests: [t('x', 100), t('y', 900), t('z', 5000, 'skipped')] }), run({ tests: [t('x', 300), t('y', 700)] })]
expect('slowest', slowestTests(slow, 5).map((r) => [r.name, r.medianMs, r.runs]), [['y', 800, 2], ['x', 200, 2]])

// 4. Getting slower.
const history = (earlier: number[], recent: number[]) => [...earlier, ...recent].map((ms) => run({ tests: [t('grow', ms)] }))
expect('slower flagged', gettingSlower(history([400, 400, 400], [1000, 1000, 1000, 1000, 1000])).map((r) => [r.name, r.earlierMs, r.recentMs]), [['grow', 400, 1000]])
expect('ratio below 1.5× not flagged', gettingSlower(history([1000, 1000, 1000], [1400, 1400, 1400, 1400, 1400])).length, 0)
expect('under 0.5s slower not flagged', gettingSlower(history([100, 100, 100], [400, 400, 400, 400, 400])).length, 0)
expect('too little history not flagged', gettingSlower(history([100, 100], [2000, 2000, 2000, 2000, 2000])).length, 0)

// 5. Flaky: pass and fail on the same commit.
const f1 = run({ commit: 'same', tests: [t('flaky', 10), t('broken', 10, 'failed')] })
const f2 = run({ commit: 'same', tests: [t('flaky', 10, 'failed'), t('broken', 10, 'failed')] })
const f3 = run({ commit: 'other', tests: [t('fixed', 10, 'failed')] })
const f4 = run({ commit: 'newer', tests: [t('fixed', 10)] })
expect('flaky', flakyTests([f1, f2, f3, f4]).map((r) => [r.name, r.commit]), [['flaky', 'same']])

// 6. Test load per run.
expect('test load', testLoad(slow), [{ runId: slow[0].runId, count: 2, totalMs: 1000 }, { runId: slow[1].runId, count: 2, totalMs: 1000 }])

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
