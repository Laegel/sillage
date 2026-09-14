import type { UsageEntry } from '../../types.ts'
import { formatCost, spendByBackend, spendWeeks } from '../../lib/metrics.ts'
import type { Week } from '../../lib/weeks.ts'
import { ChartCard, StackedBars, weekAxis, type Series } from './charts.tsx'
import { SERIES_COLORS } from './colors.ts'

// Was the Usage tab. `usage` is already scoped to the period and project by
// MetricsView; Driver/chat spend has no project, so it only appears under "All".
export default function CostSection({ weeks, usage }: { weeks: Week[]; usage: UsageEntry[] }) {
  const axis = weekAxis(weeks)
  const byKind = spendWeeks(usage, weeks)
  const series: Series[] = (
    [
      { key: 'issue', label: 'Issue work', color: SERIES_COLORS[0], values: byKind.issue },
      { key: 'driver', label: 'Driver', color: SERIES_COLORS[1], values: byKind.driver },
      { key: 'chat', label: 'Ideation & design', color: SERIES_COLORS[2], values: byKind.chat },
      { key: 'other', label: 'Other', color: 'var(--muted)', values: byKind.other },
    ] satisfies Series[]
  ).filter((s) => s.values.some((v) => (v ?? 0) > 0))
  const backends = spendByBackend(usage)
  const total = backends.reduce((sum, b) => sum + b.cost, 0)

  return (
    <section className="metrics-section">
      <h2 className="metrics-section-title">
        Cost <span className="metrics-muted">{formatCost(total)} this period</span>
      </h2>
      <div className="metrics-grid">
        <ChartCard title="Spend" subtitle="Per week, by what it was spent on" series={series} mark="bar" axis={axis} format={formatCost}>
          <StackedBars axis={axis} series={series} format={formatCost} />
        </ChartCard>
        <div className="metrics-chart-card">
          <h3>By backend</h3>
          <table className="metrics-table">
            <thead>
              <tr>
                <th>Backend</th>
                <th>Cost</th>
                <th>Tokens</th>
                <th>Runs</th>
              </tr>
            </thead>
            <tbody>
              {backends.map((b) => (
                <tr key={b.backend}>
                  <td>{b.backend}</td>
                  <td>{formatCost(b.cost)}</td>
                  <td>{b.tokens.toLocaleString()}</td>
                  <td>{b.runs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
