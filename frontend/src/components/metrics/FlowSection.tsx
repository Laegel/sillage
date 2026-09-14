import type { Project } from '../../types.ts'
import { formatDays, type FlowWeek } from '../../lib/metrics.ts'
import type { Week } from '../../lib/weeks.ts'
import { ChartCard, LineChart, StackedBars, weekAxis, type Series } from './charts.tsx'
import { projectColor, SERIES_COLORS } from './colors.ts'

const count = (v: number) => String(Math.round(v))

export default function FlowSection({ weeks, flow, projects }: { weeks: Week[]; flow: FlowWeek[]; projects: Project[] }) {
  // Color follows the project (its fixed position in the project list), never
  // its rank in this chart; only projects with work in the period get a series.
  const axis = weekAxis(weeks)
  const known = new Set(projects.map((p) => p.id))
  const projectSeries: Series[] = [
    ...projects.map((p, i) => ({ key: p.id, label: p.name, color: projectColor(i), values: flow.map((w) => w.byProject.get(p.id) ?? 0) })),
    // No project, or one missing from the project list (e.g. archived) — kept, not dropped.
    {
      key: 'other',
      label: 'Other / no project',
      color: 'var(--muted)',
      values: flow.map((w) => [...w.byProject].reduce((sum, [id, n]) => sum + (known.has(id) ? 0 : n), 0)),
    },
  ].filter((s) => s.values.some((v) => v > 0))

  const timeSeries: Series[] = [
    { key: 'progress', label: 'In Progress', color: SERIES_COLORS[0], values: flow.map((w) => w.inProgressDays) },
    { key: 'review', label: 'In Review (waiting on you)', color: SERIES_COLORS[1], values: flow.map((w) => w.inReviewDays) },
  ]
  const cycleSeries: Series[] = [{ key: 'cycle', label: 'Median cycle time', color: SERIES_COLORS[0], values: flow.map((w) => w.cycleMedianDays) }]
  const reworkSeries: Series[] = [{ key: 'rework', label: 'Rework moves', color: SERIES_COLORS[0], values: flow.map((w) => w.rework) }]

  return (
    <section className="metrics-section">
      <h2 className="metrics-section-title">Flow</h2>
      <div className="metrics-grid">
        <ChartCard title="Throughput" subtitle="Issues completed per week" series={projectSeries} mark="bar" axis={axis} format={count}>
          <StackedBars axis={axis} series={projectSeries} format={count} integer />
        </ChartCard>
        <ChartCard title="Where time goes" subtitle="Average days per completed issue, by status" series={timeSeries} mark="bar" axis={axis} format={formatDays}>
          <StackedBars axis={axis} series={timeSeries} format={formatDays} />
        </ChartCard>
        <ChartCard title="Cycle time" subtitle="Median days from started to done" series={cycleSeries} mark="line" axis={axis} format={formatDays}>
          <LineChart axis={axis} series={cycleSeries} format={formatDays} />
        </ChartCard>
        <ChartCard title="Rework" subtitle="Moves from In Review or Done back to active work" series={reworkSeries} mark="bar" axis={axis} format={count}>
          <StackedBars axis={axis} series={reworkSeries} format={count} integer />
        </ChartCard>
      </div>
    </section>
  )
}
