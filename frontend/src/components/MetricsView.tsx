import React from 'react'
import type { Issue, Project } from '../types.ts'

const WEEKS = 8
const CHART_WIDTH = 640
const CHART_HEIGHT = 200
const PADDING = { top: 10, right: 10, bottom: 24, left: 32 }

function projectColor(index: number): string {
  return `var(--project-color-${index % 8})`
}

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - day)
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

// A shared x-axis frame (gridlines + week labels) for both time-series charts.
function ChartFrame({
  weeks,
  maxY,
  yLabel,
  children,
}: {
  weeks: Date[]
  maxY: number
  yLabel: (v: number) => string
  children: React.ReactNode
}) {
  const innerW = CHART_WIDTH - PADDING.left - PADDING.right
  const innerH = CHART_HEIGHT - PADDING.top - PADDING.bottom
  const gridSteps = 4
  return (
    <div className="metrics-chart-scroll">
      <svg className="metrics-chart-svg" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} width={CHART_WIDTH} height={CHART_HEIGHT}>
        {Array.from({ length: gridSteps + 1 }, (_, i) => {
          const y = PADDING.top + (innerH * i) / gridSteps
          const value = maxY - (maxY * i) / gridSteps
          return (
            <g key={i}>
              <line className="metrics-gridline" x1={PADDING.left} x2={CHART_WIDTH - PADDING.right} y1={y} y2={y} />
              <text className="metrics-axis-label" x={PADDING.left - 6} y={y + 3} textAnchor="end">
                {yLabel(value)}
              </text>
            </g>
          )
        })}
        {weeks.map((w, i) => (
          <text
            key={i}
            className="metrics-axis-label"
            x={PADDING.left + (innerW * (i + 0.5)) / weeks.length}
            y={CHART_HEIGHT - 6}
            textAnchor="middle"
          >
            {weekLabel(w)}
          </text>
        ))}
        {children}
      </svg>
    </div>
  )
}

export default function MetricsView({ issues, projects, columns }: { issues: Issue[]; projects: Project[]; columns: string[] }) {
  const weeks = React.useMemo(() => lastNWeeks(WEEKS), [])
  const projectIds = React.useMemo(() => projects.map((p) => p.id), [projects])
  const projectIndex = (id: string | undefined) => (id ? Math.max(0, projectIds.indexOf(id)) : projectIds.length)

  const completed = React.useMemo(() => issues.filter((i) => i.completedAt), [issues])

  // Throughput: completed issues per week, stacked by project.
  const throughput = React.useMemo(() => {
    return weeks.map((weekStart) => {
      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekEnd.getDate() + 7)
      const inWeek = completed.filter((i) => {
        const d = new Date(i.completedAt!)
        return d >= weekStart && d < weekEnd
      })
      const byProject = new Map<string, number>()
      for (const issue of inWeek) {
        const key = issue.project ?? '__none__'
        byProject.set(key, (byProject.get(key) ?? 0) + 1)
      }
      return { total: inWeek.length, byProject }
    })
  }, [weeks, completed])

  // Lead time: average days from createdAt to completedAt for issues completed that week.
  const leadTime = React.useMemo(() => {
    return weeks.map((weekStart) => {
      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekEnd.getDate() + 7)
      const inWeek = completed.filter((i) => {
        const d = new Date(i.completedAt!)
        return d >= weekStart && d < weekEnd && i.createdAt
      })
      if (inWeek.length === 0) return null
      const totalDays = inWeek.reduce((sum, i) => {
        const days = (new Date(i.completedAt!).getTime() - new Date(i.createdAt!).getTime()) / 86_400_000
        return sum + Math.max(0, days)
      }, 0)
      return totalDays / inWeek.length
    })
  }, [weeks, completed])

  const statusDistribution = React.useMemo(() => {
    return columns.map((status) => {
      const inStatus = issues.filter((i) => i.status === status)
      const byProject = new Map<string, number>()
      for (const issue of inStatus) {
        const key = issue.project ?? '__none__'
        byProject.set(key, (byProject.get(key) ?? 0) + 1)
      }
      return { status, total: inStatus.length, byProject }
    })
  }, [issues, columns])

  const maxThroughput = Math.max(1, ...throughput.map((w) => w.total))
  const maxLeadTime = Math.max(1, ...leadTime.filter((v): v is number => v !== null))
  const maxStatusCount = Math.max(1, ...statusDistribution.map((s) => s.total))

  const innerW = CHART_WIDTH - PADDING.left - PADDING.right
  const innerH = CHART_HEIGHT - PADDING.top - PADDING.bottom

  const avgLeadTimeOverall = completed.length
    ? completed.reduce((sum, i) => {
        if (!i.createdAt) return sum
        return sum + Math.max(0, (new Date(i.completedAt!).getTime() - new Date(i.createdAt).getTime()) / 86_400_000)
      }, 0) / completed.filter((i) => i.createdAt).length
    : 0

  return (
    <div className="metrics-view">
      <div className="metrics-stats">
        <div className="metrics-stat">
          <span className="metrics-stat-value">{issues.length}</span>
          <span className="metrics-stat-label">Total issues</span>
        </div>
        <div className="metrics-stat">
          <span className="metrics-stat-value">{completed.length}</span>
          <span className="metrics-stat-label">Completed</span>
        </div>
        <div className="metrics-stat">
          <span className="metrics-stat-value">{avgLeadTimeOverall.toFixed(1)}d</span>
          <span className="metrics-stat-label">Avg lead time</span>
        </div>
        <div className="metrics-stat">
          <span className="metrics-stat-value">{throughput[throughput.length - 1]?.total ?? 0}</span>
          <span className="metrics-stat-label">This week's throughput</span>
        </div>
      </div>

      {projects.length > 0 && (
        <div className="metrics-legend">
          {projects.map((p, i) => (
            <span key={p.id} className="metrics-legend-item">
              <span className="metrics-legend-swatch" style={{ background: projectColor(i) }} />
              {p.name}
            </span>
          ))}
        </div>
      )}

      <div className="metrics-chart-card">
        <h3>Throughput (completed issues per week)</h3>
        <ChartFrame weeks={weeks} maxY={maxThroughput} yLabel={(v) => String(Math.round(v))}>
          {throughput.map((week, wi) => {
            const barW = (innerW / weeks.length) * 0.6
            const x = PADDING.left + (innerW * (wi + 0.5)) / weeks.length - barW / 2
            let yOffset = 0
            return (
              <g key={wi}>
                {[...week.byProject.entries()].map(([projectKey, count], pi) => {
                  const h = (count / maxThroughput) * innerH
                  const y = PADDING.top + innerH - yOffset - h
                  yOffset += h
                  return (
                    <rect
                      key={pi}
                      className="metrics-bar"
                      style={{ fill: projectColor(projectIndex(projectKey === '__none__' ? undefined : projectKey)) }}
                      x={x}
                      y={y}
                      width={barW}
                      height={h}
                    />
                  )
                })}
                {week.total > 0 && (
                  <text className="metrics-bar-label" x={x + barW / 2} y={PADDING.top + innerH - yOffset - 4} textAnchor="middle">
                    {week.total}
                  </text>
                )}
              </g>
            )
          })}
        </ChartFrame>
      </div>

      <div className="metrics-chart-card">
        <h3>Lead time (avg days to complete)</h3>
        <ChartFrame weeks={weeks} maxY={maxLeadTime} yLabel={(v) => v.toFixed(0)}>
          <polyline
            className="metrics-line"
            points={leadTime
              .map((v, i) => {
                if (v === null) return null
                const x = PADDING.left + (innerW * (i + 0.5)) / weeks.length
                const y = PADDING.top + innerH - (v / maxLeadTime) * innerH
                return `${x},${y}`
              })
              .filter(Boolean)
              .join(' ')}
          />
          {leadTime.map((v, i) => {
            if (v === null) return null
            const x = PADDING.left + (innerW * (i + 0.5)) / weeks.length
            const y = PADDING.top + innerH - (v / maxLeadTime) * innerH
            return <circle key={i} className="metrics-dot" cx={x} cy={y} r={3} />
          })}
        </ChartFrame>
      </div>

      <div className="metrics-chart-card">
        <h3>Status distribution</h3>
        <div className="metrics-chart-scroll">
          <svg
            className="metrics-chart-svg"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            width={CHART_WIDTH}
            height={CHART_HEIGHT}
          >
            {Array.from({ length: 5 }, (_, i) => {
              const y = PADDING.top + (innerH * i) / 4
              const value = maxStatusCount - (maxStatusCount * i) / 4
              return (
                <g key={i}>
                  <line className="metrics-gridline" x1={PADDING.left} x2={CHART_WIDTH - PADDING.right} y1={y} y2={y} />
                  <text className="metrics-axis-label" x={PADDING.left - 6} y={y + 3} textAnchor="end">
                    {Math.round(value)}
                  </text>
                </g>
              )
            })}
            {statusDistribution.map((col, ci) => {
              const barW = (innerW / statusDistribution.length) * 0.6
              const x = PADDING.left + (innerW * (ci + 0.5)) / statusDistribution.length - barW / 2
              let yOffset = 0
              return (
                <g key={col.status}>
                  {[...col.byProject.entries()].map(([projectKey, count], pi) => {
                    const h = (count / maxStatusCount) * innerH
                    const y = PADDING.top + innerH - yOffset - h
                    yOffset += h
                    return (
                      <rect
                        key={pi}
                        className="metrics-bar"
                        style={{ fill: projectColor(projectIndex(projectKey === '__none__' ? undefined : projectKey)) }}
                        x={x}
                        y={y}
                        width={barW}
                        height={h}
                      />
                    )
                  })}
                  <text className="metrics-axis-label" x={x + barW / 2} y={CHART_HEIGHT - 6} textAnchor="middle">
                    {col.status}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      </div>
    </div>
  )
}
