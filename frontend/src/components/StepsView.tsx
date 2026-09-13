import React from 'react'
import { fetchStepMetrics } from '../api.ts'
import type { StepAttempt, StepOutcome } from '../types.ts'

// Answers one question: does the Builder → check loop in runCard actually
// work? One row per attempt comes from server/step-metrics-store.ts; a "step"
// here is a (plan, step) pair, which can span several attempts and runs.

const RECENT_ISSUES = 15

function pct(part: number, whole: number): string {
  return whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%`
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const OUTCOME_CLASS: Record<StepOutcome, string> = {
  passed: 'steps-outcome-pass',
  retrying: 'steps-outcome-retry',
  exhausted: 'steps-outcome-fail',
  check_infra: 'steps-outcome-fail',
  builder_failed: 'steps-outcome-fail',
}

export default function StepsView() {
  const [entries, setEntries] = React.useState<StepAttempt[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    fetchStepMetrics()
      .then((res) => setEntries(res.entries))
      .finally(() => setLoading(false))
  }, [])

  const stats = React.useMemo(() => {
    const attempts = entries.filter((e) => e.phase === 'step')
    const byStep = new Map<string, StepAttempt[]>()
    for (const e of attempts) {
      const key = `${e.planId}/${e.stepId}`
      byStep.set(key, [...(byStep.get(key) ?? []), e])
    }
    const steps = [...byStep.values()]
    const firstChecked = steps.map((rows) => rows.find((r) => r.attempt === 1 && (r.verdict === 'pass' || r.verdict === 'fail'))).filter(Boolean)
    const finished = steps.filter((rows) => rows.some((r) => r.outcome === 'passed' || r.outcome === 'exhausted'))
    const checked = attempts.filter((e) => e.verdict === 'pass' || e.verdict === 'fail')

    const byChecker = (['command', 'visual', 'verifier'] as const).map((checker) => {
      const rows = checked.filter((e) => e.checker === checker)
      return { checker, checked: rows.length, failed: rows.filter((e) => e.verdict === 'fail').length }
    })

    const backends = new Map<string, StepAttempt[]>()
    for (const e of attempts) {
      const key = e.model ? `${e.backend ?? 'unknown'} · ${e.model}` : e.backend ?? 'unknown'
      backends.set(key, [...(backends.get(key) ?? []), e])
    }
    const byBackend = [...backends.entries()].map(([agent, rows]) => {
      const rowsChecked = rows.filter((e) => e.verdict === 'pass' || e.verdict === 'fail')
      return {
        agent,
        attempts: rows.length,
        passed: rowsChecked.filter((e) => e.verdict === 'pass').length,
        checked: rowsChecked.length,
        builderFailed: rows.filter((e) => e.outcome === 'builder_failed').length,
        medianBuilder: median(rows.map((e) => e.builderMs)),
      }
    })

    return {
      attempts: attempts.length,
      firstPass: pct(firstChecked.filter((r) => r!.verdict === 'pass').length, firstChecked.length),
      eventualPass: pct(finished.filter((rows) => rows.some((r) => r.outcome === 'passed')).length, finished.length),
      exhausted: pct(finished.filter((rows) => rows.some((r) => r.outcome === 'exhausted')).length, finished.length),
      builderFailed: pct(attempts.filter((e) => e.outcome === 'builder_failed').length, attempts.length),
      checkInfra: pct(attempts.filter((e) => e.outcome === 'check_infra').length, attempts.length),
      medianBuilder: median(attempts.map((e) => e.builderMs)),
      medianCheck: median(attempts.flatMap((e) => (e.checkMs === undefined ? [] : [e.checkMs]))),
      finishedSteps: finished.length,
      byChecker,
      byBackend,
    }
  }, [entries])

  // Newest issues first; within an issue, attempts in the order they ran.
  const recent = React.useMemo(() => {
    const groups = new Map<string, StepAttempt[]>()
    for (const e of [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
      groups.set(e.issueId, [...(groups.get(e.issueId) ?? []), e])
    }
    return [...groups.entries()].sort((a, b) => b[1].at(-1)!.timestamp.localeCompare(a[1].at(-1)!.timestamp)).slice(0, RECENT_ISSUES)
  }, [entries])

  if (loading) return <div className="usage-view">Loading step metrics…</div>

  if (entries.length === 0) {
    return (
      <div className="usage-view">
        <div className="usage-chart-card">
          <h3>No step attempts recorded yet</h3>
          <p className="friction-empty">Every Builder attempt on a refined card's steps, and the check that followed, will show up here.</p>
        </div>
      </div>
    )
  }

  const tiles: { value: string; label: string; sub: string }[] = [
    { value: stats.firstPass, label: 'First-attempt pass', sub: 'steps passing their check on attempt 1' },
    { value: stats.eventualPass, label: 'Eventually passed', sub: `of ${stats.finishedSteps} finished steps` },
    { value: stats.exhausted, label: 'Exhausted', sub: 'failed every attempt, flagged' },
    { value: stats.builderFailed, label: 'Builder failed', sub: `of ${stats.attempts} attempts, before any check` },
    { value: stats.checkInfra, label: 'Check broke', sub: 'check could not run' },
    { value: `${duration(stats.medianBuilder)} / ${duration(stats.medianCheck)}`, label: 'Median build / check', sub: 'per attempt' },
  ]

  return (
    <div className="usage-view">
      <div className="usage-stats steps-stats">
        {tiles.map((t) => (
          <div key={t.label} className="usage-stat">
            <span className="usage-stat-value">{t.value}</span>
            <span className="usage-stat-label">{t.label}</span>
            <span className="usage-stat-sub">{t.sub}</span>
          </div>
        ))}
      </div>

      <div className="usage-chart-card">
        <h3>Builder said done, check disagreed</h3>
        {stats.byChecker.map((c) => (
          <div key={c.checker} className="usage-line">
            <span className="steps-cell-name">{c.checker}</span>
            <span>{pct(c.failed, c.checked)} failed</span>
            <span>({c.failed} of {c.checked} checks)</span>
          </div>
        ))}
      </div>

      <div className="usage-chart-card">
        <h3>By agent</h3>
        {stats.byBackend.map((b) => (
          <div key={b.agent} className="usage-line">
            <span className="steps-cell-name">{b.agent}</span>
            <span>{b.attempts} attempts</span>
            <span>{pct(b.passed, b.checked)} of checks passed</span>
            <span>{b.builderFailed} builder failures</span>
            <span>median build {duration(b.medianBuilder)}</span>
          </div>
        ))}
      </div>

      <div className="usage-chart-card">
        <h3>Recent attempts</h3>
        {recent.map(([issueId, rows]) => (
          <div key={issueId} className="friction-group">
            <div className="friction-group-title">{issueId}</div>
            {rows.map((e, i) => (
              <div key={i} className="friction-entry steps-entry">
                <span className="friction-kind">
                  {e.phase === 'wrap_up' ? 'PR wrap-up' : `step ${e.stepIndex}/${e.stepCount} · try ${e.attempt}`}
                </span>
                <span className={`steps-outcome ${OUTCOME_CLASS[e.outcome]}`}>
                  {e.outcome.replace('_', ' ')}
                  {e.builderFailure ? ` (${e.builderFailure.replace('_', ' ')})` : ''}
                </span>
                <span className="friction-detail">
                  {e.stepTitle && <strong>{e.stepTitle}</strong>}
                  {e.checker && ` — ${e.checker}: ${e.verdict}`}
                  {(e.verdictDetail || e.builderDetail) && <span className="steps-detail"> {e.verdict === 'pass' ? '' : e.verdictDetail ?? e.builderDetail}</span>}
                </span>
                <span className="friction-when">
                  {e.backend ?? '?'}
                  {e.model ? ` · ${e.model}` : ''} · {duration(e.builderMs)}
                  {e.checkMs !== undefined ? ` + ${duration(e.checkMs)}` : ''}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
