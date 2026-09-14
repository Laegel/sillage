// Pure aggregations behind the Metrics page — no React, so metrics.check.ts
// can run them under plain Node.
import type { IssueTransition, StepAttempt, UsageEntry } from '../types.ts'
import { weekIndex, type Week } from './weeks.ts'

export const DAY_MS = 86_400_000

// Mirrors server/flow-metrics.ts's FlowIssue.
export interface FlowIssue {
  id: string
  project?: string
  status: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  canceledAt?: string
  updatedAt: string
  transitions: IssueTransition[]
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Nearest-rank percentile.
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]
}

export function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length
}

// 0-based axis ticks on a 1/2/2.5/5 × 10ⁿ step, about four intervals.
export function niceTicks(max: number, { integer = false }: { integer?: boolean } = {}): number[] {
  const top = max > 0 ? max : 1
  const raw = top / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  let step = ([1, 2, 2.5, 5, 10].find((n) => normalized <= n) ?? 10) * magnitude
  if (integer) step = Math.max(1, Math.ceil(step))
  const count = Math.ceil(top / step - 1e-9)
  return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toFixed(10)))
}

// Milliseconds spent in each status, from Linear's transition log. The last
// status runs until the issue completed/canceled, or `now` if it's still open.
export function statusDurations(issue: FlowIssue, now: Date): Record<string, number> {
  const sorted = [...issue.transitions].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const end = new Date(issue.completedAt ?? issue.canceledAt ?? now.toISOString()).getTime()
  const totals: Record<string, number> = {}
  sorted.forEach((t, i) => {
    const from = new Date(t.timestamp).getTime()
    const to = i + 1 < sorted.length ? new Date(sorted[i + 1].timestamp).getTime() : end
    totals[t.toStatus] = (totals[t.toStatus] ?? 0) + Math.max(0, to - from)
  })
  return totals
}

const REVIEWED = new Set(['In Review', 'Done'])
const ACTIVE = new Set(['In Progress', 'Todo'])

// Work that came back after it was handed over (review or done).
export function isRework(t: IssueTransition): boolean {
  return Boolean(t.fromStatus && REVIEWED.has(t.fromStatus) && ACTIVE.has(t.toStatus))
}

const ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/

export type SpendKind = 'issue' | 'driver' | 'chat' | 'other'

// Usage rows carry the issue id for implement/refine/check runs and a
// `driver:`/`ideation:`/`design:` session id for chats (server/index.ts broadcast).
export function spendKind(id: string | undefined): SpendKind {
  if (!id) return 'other'
  if (ISSUE_ID.test(id)) return 'issue'
  if (id.startsWith('driver:')) return 'driver'
  if (id.startsWith('ideation:') || id.startsWith('design:')) return 'chat'
  return 'other'
}

export function issueCostById(usage: UsageEntry[]): Map<string, number> {
  const costs = new Map<string, number>()
  for (const e of usage) {
    if (spendKind(e.id) !== 'issue' || !e.cost) continue
    costs.set(e.id!, (costs.get(e.id!) ?? 0) + e.cost)
  }
  return costs
}

export function spendWeeks(usage: UsageEntry[], weeks: Week[]): Record<SpendKind, number[]> {
  const out: Record<SpendKind, number[]> = { issue: weeks.map(() => 0), driver: weeks.map(() => 0), chat: weeks.map(() => 0), other: weeks.map(() => 0) }
  for (const e of usage) {
    const i = weekIndex(weeks, e.timestamp)
    if (i >= 0 && e.cost) out[spendKind(e.id)][i] += e.cost
  }
  return out
}

export function spendByBackend(usage: UsageEntry[]): { backend: string; cost: number; tokens: number; runs: number }[] {
  const map = new Map<string, { backend: string; cost: number; tokens: number; runs: number }>()
  for (const e of usage) {
    const row = map.get(e.backend) ?? { backend: e.backend, cost: 0, tokens: 0, runs: 0 }
    row.cost += e.cost ?? 0
    row.tokens += (e.tokens?.input ?? 0) + (e.tokens?.output ?? 0)
    row.runs += 1
    map.set(e.backend, row)
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost)
}

// ---- Flow ----------------------------------------------------------------

export interface FlowWeek {
  completed: number
  byProject: Map<string, number>
  cycleMedianDays?: number
  inProgressDays?: number
  inReviewDays?: number
  rework: number
}

export interface FlowTotals {
  completed: number
  cycleMedianDays?: number
  cycleP90Days?: number
  waitingMedianDays?: number
  reviewed: number
  reworkRate?: number
  costPerIssue?: number
}

function completedIn(issues: FlowIssue[], weeks: Week[]): FlowIssue[] {
  return issues.filter((i) => weekIndex(weeks, i.completedAt) >= 0)
}

function cycleDays(i: FlowIssue): number | undefined {
  return i.startedAt && i.completedAt ? (new Date(i.completedAt).getTime() - new Date(i.startedAt).getTime()) / DAY_MS : undefined
}

export function flowWeeks(issues: FlowIssue[], weeks: Week[], now: Date): FlowWeek[] {
  return weeks.map((week) => {
    const done = completedIn(issues, [week])
    const byProject = new Map<string, number>()
    for (const i of done) byProject.set(i.project ?? '', (byProject.get(i.project ?? '') ?? 0) + 1)
    const durations = done.map((i) => statusDurations(i, now))
    return {
      completed: done.length,
      byProject,
      cycleMedianDays: median(done.flatMap((i) => cycleDays(i) ?? [])),
      inProgressDays: mean(durations.map((d) => (d['In Progress'] ?? 0) / DAY_MS)),
      inReviewDays: mean(durations.map((d) => (d['In Review'] ?? 0) / DAY_MS)),
      rework: issues.flatMap((i) => i.transitions).filter((t) => isRework(t) && weekIndex([week], t.timestamp) === 0).length,
    }
  })
}

// `costSince`: when usage logging began — issues completed before it have no
// recorded spend, and counting them as $0 would understate cost per issue.
export function flowTotals(issues: FlowIssue[], weeks: Week[], now: Date, issueCosts: Map<string, number>, costSince?: string): FlowTotals {
  const done = completedIn(issues, weeks)
  const cycles = done.flatMap((i) => cycleDays(i) ?? [])
  // Only issues that actually went to review — most agent work skips it, and
  // their zeros would pin the median to 0.
  const waits = done.map((i) => (statusDurations(i, now)['In Review'] ?? 0) / DAY_MS).filter((days) => days > 0)
  const costed = costSince === undefined ? [] : done.filter((i) => i.completedAt! >= costSince)
  return {
    completed: done.length,
    cycleMedianDays: median(cycles),
    cycleP90Days: percentile(cycles, 90),
    waitingMedianDays: median(waits),
    reviewed: waits.length,
    reworkRate: done.length ? done.filter((i) => i.transitions.some(isRework)).length / done.length : undefined,
    costPerIssue: costed.length ? costed.reduce((sum, i) => sum + (issueCosts.get(i.id) ?? 0), 0) / costed.length : undefined,
  }
}

// What's sitting in review right now, and since when.
export function waitingNow(issues: FlowIssue[], now: Date): { count: number; oldestDays?: number } {
  const inReview = issues.filter((i) => i.status === 'In Review')
  const ages = inReview.map((i) => {
    const entered =
      i.transitions
        .filter((t) => t.toStatus === 'In Review')
        .map((t) => t.timestamp)
        .sort()
        .at(-1) ?? i.updatedAt
    return (now.getTime() - new Date(entered).getTime()) / DAY_MS
  })
  return { count: inReview.length, oldestDays: ages.length ? Math.max(...ages) : undefined }
}

// ---- Agent loop (step metrics) --------------------------------------------

export interface LoopStats {
  attempts: number
  finishedSteps: number
  firstPassRate?: number
  eventualPassRate?: number
  exhaustedRate?: number
  builderFailedRate?: number
  checkInfraRate?: number
  medianBuilderMs?: number
  medianCheckMs?: number
  byChecker: { checker: 'command' | 'visual' | 'verifier'; checked: number; failed: number }[]
  byAgent: { agent: string; attempts: number; checked: number; passed: number; builderFailed: number; medianBuilderMs?: number }[]
}

const ratio = (part: number, whole: number) => (whole ? part / whole : undefined)
const isChecked = (e: StepAttempt) => e.verdict === 'pass' || e.verdict === 'fail'

export function loopStats(entries: StepAttempt[]): LoopStats {
  const attempts = entries.filter((e) => e.phase === 'step')
  const byStep = new Map<string, StepAttempt[]>()
  for (const e of attempts) byStep.set(`${e.planId}/${e.stepId}`, [...(byStep.get(`${e.planId}/${e.stepId}`) ?? []), e])
  const steps = [...byStep.values()]
  const firstChecked = steps.flatMap((rows) => rows.filter((r) => r.attempt === 1 && isChecked(r)).slice(0, 1))
  const finished = steps.filter((rows) => rows.some((r) => r.outcome === 'passed' || r.outcome === 'exhausted'))
  const checked = attempts.filter(isChecked)

  const agents = new Map<string, StepAttempt[]>()
  for (const e of attempts) {
    const key = e.model ? `${e.backend ?? 'unknown'} · ${e.model}` : e.backend ?? 'unknown'
    agents.set(key, [...(agents.get(key) ?? []), e])
  }

  return {
    attempts: attempts.length,
    finishedSteps: finished.length,
    firstPassRate: ratio(firstChecked.filter((r) => r.verdict === 'pass').length, firstChecked.length),
    eventualPassRate: ratio(finished.filter((rows) => rows.some((r) => r.outcome === 'passed')).length, finished.length),
    exhaustedRate: ratio(finished.filter((rows) => rows.some((r) => r.outcome === 'exhausted')).length, finished.length),
    builderFailedRate: ratio(attempts.filter((e) => e.outcome === 'builder_failed').length, attempts.length),
    checkInfraRate: ratio(attempts.filter((e) => e.outcome === 'check_infra').length, attempts.length),
    medianBuilderMs: median(attempts.map((e) => e.builderMs)),
    medianCheckMs: median(attempts.flatMap((e) => (e.checkMs === undefined ? [] : [e.checkMs]))),
    byChecker: (['command', 'visual', 'verifier'] as const).map((checker) => {
      const rows = checked.filter((e) => e.checker === checker)
      return { checker, checked: rows.length, failed: rows.filter((e) => e.verdict === 'fail').length }
    }),
    byAgent: [...agents.entries()].map(([agent, rows]) => ({
      agent,
      attempts: rows.length,
      checked: rows.filter(isChecked).length,
      passed: rows.filter((e) => e.verdict === 'pass').length,
      builderFailed: rows.filter((e) => e.outcome === 'builder_failed').length,
      medianBuilderMs: median(rows.map((e) => e.builderMs)),
    })),
  }
}

// ---- Formatting -----------------------------------------------------------

export function formatPct(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`
}

export function formatDays(days: number | undefined): string {
  if (days === undefined) return '—'
  if (days === 0) return '0'
  if (days < 1 / 24) return `${Math.round(days * 1440)}m`
  if (days < 1) return `${Math.round(days * 24)}h`
  return `${days < 10 ? Number(days.toFixed(1)) : Math.round(days)}d`
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export function formatCost(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value === 0) return '$0'
  return `$${value < 10 ? value.toFixed(2) : Math.round(value).toLocaleString()}`
}
