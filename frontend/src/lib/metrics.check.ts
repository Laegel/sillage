// Runnable check for the Metrics page's pure helpers: `node frontend/src/lib/metrics.check.ts`.
import { flowTotals, issueCostById, isRework, median, niceTicks, percentile, spendKind, statusDurations, type FlowIssue } from './metrics.ts'
import { startOfWeek } from './weeks.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const DAY = 86_400_000
const d = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * DAY).toISOString()

// 1. Time per status, independent of transition order.
const issue: FlowIssue = {
  id: 'LAE-1',
  status: 'Done',
  createdAt: d(0),
  startedAt: d(1),
  completedAt: d(4),
  updatedAt: d(4),
  transitions: [
    { fromStatus: 'In Review', toStatus: 'Done', timestamp: d(4) },
    { fromStatus: 'Backlog', toStatus: 'Todo', timestamp: d(0) },
    { fromStatus: 'In Progress', toStatus: 'In Review', timestamp: d(3) },
    { fromStatus: 'Todo', toStatus: 'In Progress', timestamp: d(1) },
  ],
}
const durations = statusDurations(issue, new Date(d(10)))
expect('in progress days', durations['In Progress'] / DAY, 2)
expect('in review days', durations['In Review'] / DAY, 1)
expect('todo days', durations.Todo / DAY, 1)

// 2. Rework = back from In Review/Done to active work only.
expect('review → in progress', isRework({ fromStatus: 'In Review', toStatus: 'In Progress', timestamp: d(0) }), true)
expect('done → todo', isRework({ fromStatus: 'Done', toStatus: 'Todo', timestamp: d(0) }), true)
expect('todo → backlog', isRework({ fromStatus: 'Todo', toStatus: 'Backlog', timestamp: d(0) }), false)
expect('review → canceled', isRework({ fromStatus: 'In Review', toStatus: 'Canceled', timestamp: d(0) }), false)

// 3. Median / percentile.
expect('median odd', median([5, 1, 3]), 3)
expect('median even', median([4, 1, 3, 2]), 2.5)
expect('median empty', median([]), undefined)
expect('p90', percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9)

// 4. Weeks start Monday (local time).
expect('sunday night → previous monday', startOfWeek(new Date(2026, 8, 13, 23)).getTime(), new Date(2026, 8, 7).getTime())
expect('monday midnight → same day', startOfWeek(new Date(2026, 8, 14, 0)).getTime(), new Date(2026, 8, 14).getTime())

// 5. Clean axis ticks.
expect('ticks 1 (integer)', niceTicks(1, { integer: true }), [0, 1])
expect('ticks 73 (integer)', niceTicks(73, { integer: true }), [0, 20, 40, 60, 80])
expect('ticks 3.2', niceTicks(3.2), [0, 1, 2, 3, 4])
expect('ticks 0', niceTicks(0, { integer: true }), [0, 1])

// 6. Cost joins only issue-shaped ids.
const costs = issueCostById([
  { backend: 'claude', timestamp: d(0), id: 'LAE-1', cost: 1.5 },
  { backend: 'claude', timestamp: d(0), id: 'LAE-1', cost: 0.5 },
  { backend: 'claude', timestamp: d(0), id: 'driver:abc', cost: 9 },
  { backend: 'claude', timestamp: d(0), id: 'probe-abc', cost: 1 },
])
expect('issue cost', [...costs.entries()], [['LAE-1', 2]])
expect('spend kind issue', spendKind('LAE-12'), 'issue')
expect('spend kind driver', spendKind('driver:x'), 'driver')
expect('spend kind chat', spendKind('design:x'), 'chat')
expect('spend kind other', spendKind(undefined), 'other')

// 7. Headline totals: waiting only counts issues that went to review; cost only
//    counts issues completed after usage logging began.
const fastIssue: FlowIssue = {
  id: 'LAE-2',
  status: 'Done',
  createdAt: d(0),
  startedAt: d(1),
  completedAt: d(2),
  updatedAt: d(2),
  transitions: [
    { fromStatus: 'Todo', toStatus: 'In Progress', timestamp: d(1) },
    { fromStatus: 'In Progress', toStatus: 'Done', timestamp: d(2) },
  ],
}
// Completed before usage logging began (d(1.5)) — its $0 must not dilute cost per issue.
const oldIssue: FlowIssue = { ...fastIssue, id: 'LAE-3', startedAt: d(0.5), completedAt: d(1), transitions: [] }
const weeksAll = [{ start: new Date(d(-1)), end: new Date(d(30)) }]
const totals = flowTotals([issue, fastIssue, oldIssue], weeksAll, new Date(d(10)), new Map([['LAE-1', 3], ['LAE-2', 1]]), d(1.5))
expect('waiting median ignores never-reviewed', totals.waitingMedianDays, 1)
expect('reviewed count', totals.reviewed, 1)
expect('cost per issue only after logging began', totals.costPerIssue, 2)

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
