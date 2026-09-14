import React from 'react'
import { fetchFlowIssues, fetchGates, fetchStepMetrics, fetchUsage } from '../api.ts'
import type { GateProject, Project, StepAttempt, UsageEntry } from '../types.ts'
import {
  flowTotals,
  flowWeeks,
  formatCost,
  formatDays,
  formatPct,
  issueCostById,
  loopStats,
  spendKind,
  waitingNow,
  type FlowIssue,
} from '../lib/metrics.ts'
import { lastNWeeks, type Week } from '../lib/weeks.ts'
import FlowSection from './metrics/FlowSection.tsx'
import LoopSection from './metrics/LoopSection.tsx'
import CostSection from './metrics/CostSection.tsx'
import GatesSection from './metrics/GatesSection.tsx'

// One page answering "is the agent loop working, and where does it stall?".
// A single filter row scopes every number below it, so they always agree;
// each headline tile compares against the period just before.

const PERIODS = [4, 8, 12, 26]
const FILTERS_KEY = 'sillage.metrics.filters'

type Filters = { weeks: number; project: string }

function loadFilters(): Filters {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}')
    return { weeks: PERIODS.includes(saved.weeks) ? saved.weeks : 8, project: typeof saved.project === 'string' ? saved.project : '' }
  } catch {
    return { weeks: 8, project: '' }
  }
}

function inWeeks(weeks: Week[], iso: string): boolean {
  const t = new Date(iso).getTime()
  return t >= weeks[0].start.getTime() && t < weeks[weeks.length - 1].end.getTime()
}

type Delta = { text: string; good: boolean } | undefined

// `lowerIsBetter` decides the colour; the arrow and signed text carry the direction on their own.
function delta(current: number | undefined, previous: number | undefined, format: (v: number) => string, lowerIsBetter: boolean): Delta {
  if (current === undefined || previous === undefined || current === previous) return undefined
  const up = current > previous
  return { text: `${up ? '▲' : '▼'} ${format(Math.abs(current - previous))}`, good: up !== lowerIsBetter }
}

function Tile({ value, label, sub, change }: { value: string; label: string; sub: string; change: Delta }) {
  return (
    <div className="metrics-tile">
      <span className="metrics-tile-value">{value}</span>
      <span className="metrics-tile-label">{label}</span>
      <span className="metrics-tile-sub">
        {change && <span className={change.good ? 'metrics-delta-good' : 'metrics-delta-bad'}>{change.text} </span>}
        {sub}
      </span>
    </div>
  )
}

export default function MetricsView({ projects }: { projects: Project[] }) {
  const [filters, setFilters] = React.useState<Filters>(loadFilters)
  const [flow, setFlow] = React.useState<FlowIssue[] | null>(null)
  const [usage, setUsage] = React.useState<UsageEntry[]>([])
  const [steps, setSteps] = React.useState<StepAttempt[]>([])
  const [gates, setGates] = React.useState<GateProject[]>([])
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState('')

  React.useEffect(() => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(filters))
    } catch {
      // private mode / blocked storage — the filters just won't persist
    }
  }, [filters])

  // Two periods back, so every tile can compare against the one before.
  const now = React.useMemo(() => new Date(), [flow])
  const allWeeks = React.useMemo(() => lastNWeeks(filters.weeks * 2, now), [filters.weeks, now])
  const weeks = React.useMemo(() => allWeeks.slice(filters.weeks), [allWeeks, filters.weeks])
  const previousWeeks = React.useMemo(() => allWeeks.slice(0, filters.weeks), [allWeeks, filters.weeks])

  React.useEffect(() => {
    setRefreshing(true)
    Promise.all([fetchFlowIssues(allWeeks[0].start), fetchUsage(), fetchStepMetrics(), fetchGates()])
      .then(([f, u, s, g]) => {
        setGates(g.projects)
        setFlow(f.issues)
        setUsage(u.entries)
        setSteps(s.entries)
        setError('')
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRefreshing(false))
    // Refetch only when the period changes — the project filter is client-side.
  }, [filters.weeks])

  const view = React.useMemo(() => {
    if (!flow) return null
    const projectOf = new Map(flow.map((i) => [i.id, i.project ?? '']))
    const inProject = (issueId: string) => !filters.project || projectOf.get(issueId) === filters.project
    const scopedFlow = flow.filter((i) => inProject(i.id))
    const scopedUsage = usage.filter((e) => (spendKind(e.id) === 'issue' ? inProject(e.id!) : !filters.project))
    const scopedSteps = steps.filter((e) => inProject(e.issueId))
    const issueCosts = issueCostById(usage)
    const costSince = usage.map((e) => e.timestamp).sort()[0]

    const loopFor = (range: Week[]) => loopStats(scopedSteps.filter((e) => inWeeks(range, e.timestamp)))
    return {
      flowWeeks: flowWeeks(scopedFlow, weeks, now),
      totals: flowTotals(scopedFlow, weeks, now, issueCosts, costSince),
      previous: flowTotals(scopedFlow, previousWeeks, now, issueCosts, costSince),
      waiting: waitingNow(scopedFlow, now),
      costSince,
      loop: loopFor(weeks),
      previousLoop: loopFor(previousWeeks),
      periodSteps: scopedSteps.filter((e) => inWeeks(weeks, e.timestamp)),
      periodUsage: scopedUsage.filter((e) => inWeeks(weeks, e.timestamp)),
    }
  }, [flow, usage, steps, filters.project, weeks, previousWeeks, now])

  const points = (v: number) => `${Math.round(v * 100)} pts`

  return (
    <div className={`metrics-view${refreshing && view ? ' metrics-refreshing' : ''}`}>
      <div className="metrics-filters">
        <label>
          Period
          <select value={filters.weeks} onChange={(e) => setFilters({ ...filters, weeks: Number(e.target.value) })}>
            {PERIODS.map((n) => (
              <option key={n} value={n}>
                Last {n} weeks
              </option>
            ))}
          </select>
        </label>
        <label>
          Project
          <select value={filters.project} onChange={(e) => setFilters({ ...filters, project: e.target.value })}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {error && <span className="metrics-error">Could not load metrics: {error}</span>}
      </div>

      {!view ? (
        <p className="metrics-empty">{error ? '' : 'Loading metrics…'}</p>
      ) : (
        <>
          <div className="metrics-tiles">
            <Tile
              value={formatDays(view.totals.cycleMedianDays)}
              label="Cycle time"
              sub={`median · p90 ${formatDays(view.totals.cycleP90Days)} · ${view.totals.completed} done`}
              change={delta(view.totals.cycleMedianDays, view.previous.cycleMedianDays, formatDays, true)}
            />
            <Tile
              value={formatDays(view.totals.waitingMedianDays)}
              label="Waiting on you"
              sub={`median in review, ${view.totals.reviewed} reviewed · ${view.waiting.count} waiting now${view.waiting.oldestDays !== undefined ? `, oldest ${formatDays(view.waiting.oldestDays)}` : ''}`}
              change={delta(view.totals.waitingMedianDays, view.previous.waitingMedianDays, formatDays, true)}
            />
            <Tile
              value={formatPct(view.totals.reworkRate)}
              label="Rework rate"
              sub="completed issues sent back at least once"
              change={delta(view.totals.reworkRate, view.previous.reworkRate, points, true)}
            />
            <Tile
              value={formatPct(view.loop.firstPassRate)}
              label="First-try step pass"
              sub={`${view.loop.attempts} step attempts`}
              change={delta(view.loop.firstPassRate, view.previousLoop.firstPassRate, points, false)}
            />
            <Tile
              value={formatCost(view.totals.costPerIssue)}
              label="Cost per issue"
              sub={`agent spend per completed issue${view.costSince ? ` since ${new Date(view.costSince).toLocaleDateString()}` : ''}`}
              change={delta(view.totals.costPerIssue, view.previous.costPerIssue, formatCost, true)}
            />
          </div>

          <FlowSection weeks={weeks} flow={view.flowWeeks} projects={projects} />
          <LoopSection stats={view.loop} entries={view.periodSteps} />
          <GatesSection gates={gates} projects={projects} projectFilter={filters.project} since={weeks[0].start} />
          <CostSection weeks={weeks} usage={view.periodUsage} />
        </>
      )}
    </div>
  )
}
