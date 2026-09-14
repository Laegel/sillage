import React from 'react'
import type { GateProject, GateRun, Project } from '../../types.ts'
import { flakyTests, gateSummary, gettingSlower, slowestTests, stepSeries, testLoad } from '../../lib/gates.ts'
import { formatDuration, formatPct, median } from '../../lib/metrics.ts'
import { ChartCard, LineChart, StackedBars, type Axis, type Series } from './charts.tsx'
import { projectColor } from './colors.ts'

// Where each project's quality gate spends its time, and which tests are slow,
// getting slower, or flaky. Projects time their own gates (gate-timing.sh writes
// .gates/runs.jsonl); this only reads what they record — see server/gates-store.ts.

// Tests run in milliseconds, gates in minutes — one formatter for both.
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return formatDuration(ms)
}

function runAxis(runs: GateRun[]): Axis {
  const labels = runs.map((r) => {
    const d = new Date(r.startedAt)
    return `${d.getMonth() + 1}/${d.getDate()}`
  })
  const titles = runs.map((r) => `${new Date(r.startedAt).toLocaleString()} · ${r.exitCode === 0 ? 'passed' : `failed (${r.exitCode})`} · ${r.commit.slice(0, 7)} · ${r.trigger}`)
  return { labels, titles, heading: 'Run' }
}

export default function GatesSection({
  gates,
  projects,
  projectFilter,
  since,
}: {
  gates: GateProject[]
  projects: Project[]
  projectFilter: string
  since: Date
}) {
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id
  const inPeriod = gates
    .map((g) => ({ ...g, runs: g.runs.filter((r) => new Date(r.startedAt) >= since) }))
    .filter((g) => g.runs.length > 0 && (!projectFilter || g.projectId === projectFilter))
  const [picked, setPicked] = React.useState('')
  // Default to the project with the most history — a lone failed run says little.
  const busiest = [...inPeriod].sort((a, b) => b.runs.length - a.runs.length)[0]
  const selected = inPeriod.find((g) => g.projectId === (projectFilter || picked)) ?? busiest

  if (inPeriod.length === 0) {
    return (
      <section className="metrics-section">
        <h2 className="metrics-section-title">Gates</h2>
        <p className="metrics-empty">
          No gate runs in this period{projectFilter ? ' for this project' : ''}. A project opts in by timing its gate with gate-timing.sh (ldaahbevy
          scripts/, songe tools/verify/), which writes .gates/runs.jsonl in the repo.
        </p>
      </section>
    )
  }

  const ordered = [...selected.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const axis = runAxis(ordered)
  const steps = stepSeries(ordered)
  const stepSeriesForChart: Series[] = steps.steps.map((s, i) => ({ key: s.name, label: s.name, color: projectColor(i), values: s.values }))
  const load = testLoad(ordered)
  const testTime: Series[] = [{ key: 'tests', label: 'Total test time', color: projectColor(0), values: load.map((l) => (l.count ? l.totalMs : undefined)) }]
  const latestCount = [...load].reverse().find((l) => l.count)?.count
  const slowest = slowestTests(ordered, 10)
  const slower = gettingSlower(ordered)
  const flaky = flakyTests(ordered)

  return (
    <section className="metrics-section">
      <h2 className="metrics-section-title">Gates</h2>

      <div className="metrics-chart-card">
        <table className="metrics-table">
          <thead>
            <tr>
              <th>Project</th>
              <th>Runs</th>
              <th>Median</th>
              <th>p90</th>
              <th>Passed</th>
              <th>Slowest step (median)</th>
            </tr>
          </thead>
          <tbody>
            {inPeriod.map((g) => {
              const summary = gateSummary(g.runs)
              const slowestStep = stepSeries(g.runs)
                .steps.map((s) => ({ name: s.name, ms: median(s.values.filter((v): v is number => v !== undefined)) ?? 0 }))
                .sort((a, b) => b.ms - a.ms)[0]
              return (
                <tr key={g.projectId} className={g.projectId === selected.projectId ? 'metrics-row-selected' : undefined}>
                  <td>
                    {projectFilter ? (
                      nameOf(g.projectId)
                    ) : (
                      <button type="button" className="metrics-link" onClick={() => setPicked(g.projectId)}>
                        {nameOf(g.projectId)}
                      </button>
                    )}
                  </td>
                  <td>{summary.runs}</td>
                  <td>{formatElapsed(summary.medianMs)}</td>
                  <td>{formatElapsed(summary.p90Ms)}</td>
                  <td>{formatPct(summary.passRate)}</td>
                  <td>{slowestStep ? `${slowestStep.name} · ${formatElapsed(slowestStep.ms)}` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <h3 className="metrics-subsection-title">{nameOf(selected.projectId)}</h3>
      <div className="metrics-grid">
        <ChartCard title="Where gate time goes" subtitle="Each step's duration, per run" series={stepSeriesForChart} mark="bar" axis={axis} format={formatElapsed}>
          <StackedBars axis={axis} series={stepSeriesForChart} format={formatElapsed} />
        </ChartCard>
        {latestCount ? (
          <ChartCard title="Test time" subtitle={`Sum of per-test durations · ${latestCount} tests in the latest run`} series={testTime} mark="line" axis={axis} format={formatElapsed}>
            <LineChart axis={axis} series={testTime} format={formatElapsed} />
          </ChartCard>
        ) : (
          <div className="metrics-chart-card">
            <h3>Test time</h3>
            <p className="metrics-empty">No JUnit reports recorded for this project yet, so there's no per-test breakdown.</p>
          </div>
        )}
      </div>

      <div className="metrics-grid metrics-grid-spaced">
        <div className="metrics-chart-card">
          <h3>Slowest tests</h3>
          {slowest.length === 0 ? (
            <p className="metrics-empty">No per-test timings recorded.</p>
          ) : (
            <table className="metrics-table">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Median</th>
                  <th>p90</th>
                  <th>Runs</th>
                </tr>
              </thead>
              <tbody>
                {slowest.map((t) => (
                  <tr key={`${t.suite}\n${t.name}`}>
                    <td title={t.suite}>{t.name}</td>
                    <td>{formatElapsed(t.medianMs)}</td>
                    <td>{formatElapsed(t.p90Ms)}</td>
                    <td>{t.runs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="metrics-chart-card">
          <h3>Getting slower</h3>
          <div className="metrics-card-sub">Last 5 runs vs before: at least 1.5× and 0.5 s slower</div>
          {slower.length === 0 ? (
            <p className="metrics-empty">Nothing has slowed down noticeably.</p>
          ) : (
            <table className="metrics-table">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Before</th>
                  <th>Recently</th>
                </tr>
              </thead>
              <tbody>
                {slower.map((t) => (
                  <tr key={`${t.suite}\n${t.name}`}>
                    <td title={t.suite}>{t.name}</td>
                    <td>{formatElapsed(t.earlierMs)}</td>
                    <td>{formatElapsed(t.recentMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 className="metrics-card-gap">Flaky</h3>
          <div className="metrics-card-sub">Passed and failed on the same commit</div>
          {flaky.length === 0 ? (
            <p className="metrics-empty">No flaky tests seen.</p>
          ) : (
            <table className="metrics-table">
              <tbody>
                {flaky.map((t) => (
                  <tr key={`${t.suite}\n${t.name}`}>
                    <td title={t.suite}>{t.name}</td>
                    <td>{t.commit.slice(0, 7)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  )
}
