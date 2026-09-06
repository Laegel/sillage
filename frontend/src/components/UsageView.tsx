import React from 'react'
import { fetchUsage } from '../api.ts'
import type { UsageEntry } from '../types.ts'

const WEEKS = 8
const CHART_WIDTH = 640
const CHART_HEIGHT = 200
const PADDING = { top: 10, right: 10, bottom: 24, left: 40 }

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  d.setDate(d.getDate() - d.getDay())
  d.setHours(0, 0, 0, 0)
  return d
}

function weekLabel(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function lastNWeeks(n: number): Date[] {
  const weeks: Date[] = []
  const start = startOfWeek(new Date())
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(start)
    d.setDate(d.getDate() - i * 7)
    weeks.push(d)
  }
  return weeks
}

function tokenTotal(entry: UsageEntry): number {
  if (!entry.tokens) return 0
  return entry.tokens.input + entry.tokens.output
}

export default function UsageView() {
  const [entries, setEntries] = React.useState<UsageEntry[]>([])
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    fetchUsage()
      .then((res) => setEntries(res.entries))
      .finally(() => setLoading(false))
  }, [])

  const weeks = React.useMemo(() => lastNWeeks(WEEKS), [])

  const costByWeek = React.useMemo(() => {
    return weeks.map((weekStart) => {
      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekEnd.getDate() + 7)
      return entries
        .filter((e) => {
          const d = new Date(e.timestamp)
          return d >= weekStart && d < weekEnd
        })
        .reduce((sum, e) => sum + (e.cost ?? 0), 0)
    })
  }, [weeks, entries])

  const byBackend = React.useMemo(() => {
    const map = new Map<string, { cost: number; tokens: number; count: number }>()
    for (const e of entries) {
      const cur = map.get(e.backend) ?? { cost: 0, tokens: 0, count: 0 }
      cur.cost += e.cost ?? 0
      cur.tokens += tokenTotal(e)
      cur.count += 1
      map.set(e.backend, cur)
    }
    return [...map.entries()]
  }, [entries])

  const totalCost = entries.reduce((sum, e) => sum + (e.cost ?? 0), 0)
  const totalTokens = entries.reduce((sum, e) => sum + tokenTotal(e), 0)
  const totalInput = entries.reduce((sum, e) => sum + (e.tokens?.input ?? 0), 0)
  const totalOutput = entries.reduce((sum, e) => sum + (e.tokens?.output ?? 0), 0)

  const maxCost = Math.max(0.01, ...costByWeek)
  const innerW = CHART_WIDTH - PADDING.left - PADDING.right
  const innerH = CHART_HEIGHT - PADDING.top - PADDING.bottom

  if (loading) return <div className="usage-view">Loading usage…</div>

  return (
    <div className="usage-view">
      <div className="usage-stats">
        <div className="usage-stat">
          <span className="usage-stat-value">${totalCost.toFixed(2)}</span>
          <span className="usage-stat-label">Total cost</span>
          <span className="usage-stat-sub">{entries.length} runs</span>
        </div>
        <div className="usage-stat">
          <span className="usage-stat-value">{totalTokens.toLocaleString()}</span>
          <span className="usage-stat-label">Total tokens</span>
          <span className="usage-stat-sub">
            {totalInput.toLocaleString()} in / {totalOutput.toLocaleString()} out
          </span>
        </div>
      </div>

      <div className="usage-chart-card">
        <h3>Cost per week</h3>
        <div className="usage-chart-scroll">
          <svg className="usage-chart-svg" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} width={CHART_WIDTH} height={CHART_HEIGHT}>
            {Array.from({ length: 5 }, (_, i) => {
              const y = PADDING.top + (innerH * i) / 4
              const value = maxCost - (maxCost * i) / 4
              return (
                <g key={i}>
                  <line className="usage-gridline" x1={PADDING.left} x2={CHART_WIDTH - PADDING.right} y1={y} y2={y} />
                  <text className="usage-axis-label" x={PADDING.left - 6} y={y + 3} textAnchor="end">
                    ${value.toFixed(2)}
                  </text>
                </g>
              )
            })}
            {weeks.map((w, i) => (
              <text
                key={i}
                className="usage-axis-label"
                x={PADDING.left + (innerW * (i + 0.5)) / weeks.length}
                y={CHART_HEIGHT - 6}
                textAnchor="middle"
              >
                {weekLabel(w)}
              </text>
            ))}
            {costByWeek.map((cost, i) => {
              const barW = (innerW / weeks.length) * 0.6
              const x = PADDING.left + (innerW * (i + 0.5)) / weeks.length - barW / 2
              const h = (cost / maxCost) * innerH
              const y = PADDING.top + innerH - h
              return <rect key={i} className="metrics-bar" x={x} y={y} width={barW} height={h} />
            })}
          </svg>
        </div>
      </div>

      {byBackend.map(([backend, stats]) => (
        <div key={backend} className="usage-line">
          <strong>{backend}</strong>
          <span>${stats.cost.toFixed(2)}</span>
          <span>{stats.tokens.toLocaleString()} tokens</span>
          <span>{stats.count} runs</span>
        </div>
      ))}
    </div>
  )
}
