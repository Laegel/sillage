import type { StepAttempt, StepOutcome } from '../../types.ts'
import { formatDuration, formatPct, type LoopStats } from '../../lib/metrics.ts'

// Was the Steps tab: does runCard's Builder → check loop work? One row per
// attempt comes from server/step-metrics-store.ts.

const RECENT_ISSUES = 15

const OUTCOME_CLASS: Record<StepOutcome, string> = {
  passed: 'metrics-outcome-pass',
  retrying: 'metrics-outcome-retry',
  exhausted: 'metrics-outcome-fail',
  check_infra: 'metrics-outcome-fail',
  builder_failed: 'metrics-outcome-fail',
}

export default function LoopSection({ stats, entries }: { stats: LoopStats; entries: StepAttempt[] }) {
  // Newest issues first; within an issue, attempts in the order they ran.
  const groups = new Map<string, StepAttempt[]>()
  for (const e of [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) groups.set(e.issueId, [...(groups.get(e.issueId) ?? []), e])
  const recent = [...groups.entries()].sort((a, b) => b[1].at(-1)!.timestamp.localeCompare(a[1].at(-1)!.timestamp)).slice(0, RECENT_ISSUES)

  const tiles = [
    { value: formatPct(stats.eventualPassRate), label: 'Eventually passed', sub: `of ${stats.finishedSteps} finished steps` },
    { value: formatPct(stats.exhaustedRate), label: 'Exhausted', sub: 'failed every attempt, flagged' },
    { value: formatPct(stats.builderFailedRate), label: 'Builder failed', sub: `of ${stats.attempts} attempts, before any check` },
    { value: formatPct(stats.checkInfraRate), label: 'Check broke', sub: 'the check could not run' },
    { value: `${formatDuration(stats.medianBuilderMs)} / ${formatDuration(stats.medianCheckMs)}`, label: 'Median build / check', sub: 'per attempt' },
  ]

  return (
    <section className="metrics-section">
      <h2 className="metrics-section-title">Agent loop</h2>
      {stats.attempts === 0 ? (
        <p className="metrics-empty">No step attempts in this period. Every Builder attempt on a refined card's steps, and the check that followed, shows up here.</p>
      ) : (
        <>
          <div className="metrics-tiles metrics-tiles-compact">
            {tiles.map((t) => (
              <div key={t.label} className="metrics-tile">
                <span className="metrics-tile-value">{t.value}</span>
                <span className="metrics-tile-label">{t.label}</span>
                <span className="metrics-tile-sub">{t.sub}</span>
              </div>
            ))}
          </div>
          <div className="metrics-grid">
            <div className="metrics-chart-card">
              <h3>Builder said done, check disagreed</h3>
              <table className="metrics-table">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Failed</th>
                    <th>Checks</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byChecker.map((c) => (
                    <tr key={c.checker}>
                      <td>{c.checker}</td>
                      <td>{formatPct(c.checked ? c.failed / c.checked : undefined)}</td>
                      <td>{c.checked}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="metrics-chart-card">
              <h3>By agent</h3>
              <table className="metrics-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Attempts</th>
                    <th>Checks passed</th>
                    <th>Builder failed</th>
                    <th>Median build</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byAgent.map((a) => (
                    <tr key={a.agent}>
                      <td>{a.agent}</td>
                      <td>{a.attempts}</td>
                      <td>{formatPct(a.checked ? a.passed / a.checked : undefined)}</td>
                      <td>{a.builderFailed}</td>
                      <td>{formatDuration(a.medianBuilderMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <details className="metrics-chart-card metrics-details">
            <summary>Recent attempts</summary>
            {recent.map(([issueId, rows]) => (
              <div key={issueId} className="friction-group">
                <div className="friction-group-title">{issueId}</div>
                {rows.map((e, i) => (
                  <div key={i} className="friction-entry metrics-attempt">
                    <span className="friction-kind">{e.phase === 'wrap_up' ? 'PR wrap-up' : `step ${e.stepIndex}/${e.stepCount} · try ${e.attempt}`}</span>
                    <span className={`metrics-outcome ${OUTCOME_CLASS[e.outcome]}`}>
                      {e.outcome.replace('_', ' ')}
                      {e.builderFailure ? ` (${e.builderFailure.replace('_', ' ')})` : ''}
                    </span>
                    <span className="friction-detail">
                      {e.stepTitle && <strong>{e.stepTitle}</strong>}
                      {e.checker && ` — ${e.checker}: ${e.verdict}`}
                      {e.verdict !== 'pass' && (e.verdictDetail || e.builderDetail) && <span className="metrics-muted"> {e.verdictDetail ?? e.builderDetail}</span>}
                    </span>
                    <span className="friction-when">
                      {e.backend ?? '?'}
                      {e.model ? ` · ${e.model}` : ''} · {formatDuration(e.builderMs)}
                      {e.checkMs !== undefined ? ` + ${formatDuration(e.checkMs)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </details>
        </>
      )}
    </section>
  )
}
