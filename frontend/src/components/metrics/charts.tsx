import React from 'react'
import { niceTicks } from '../../lib/metrics.ts'
import { weekLabel, type Week } from '../../lib/weeks.ts'

// What sits along the x axis: a short label under each band, a fuller title for
// its tooltip, and the table's first column heading. Weeks for flow/cost charts,
// individual gate runs for the Gates section.
export interface Axis {
  labels: string[]
  titles: string[]
  heading: string
}

export function weekAxis(weeks: Week[]): Axis {
  const labels = weeks.map(weekLabel)
  return { labels, titles: labels.map((l) => `Week of ${l}`), heading: 'Week of' }
}

// Hand-rolled SVG charts for the Metrics page, following the dataviz skill's
// mark specs: ≤24px bars with 4px rounded caps and 2px surface gaps between
// stacked segments, 2px lines with ringed 8px dots, hairline grid, a hover
// tooltip on every week band, and a Table toggle as the no-hover equivalent.

export interface Series {
  key: string
  label: string
  color: string
  values: (number | undefined)[]
}

const PLOT_HEIGHT = 170
const AXIS_BAND = 22
const PAD = { top: 16, right: 8, left: 44 }
const GAP = 2

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    if (!ref.current) return
    // Measure now, not only on the observer's first callback — it doesn't fire in
    // a background tab, which left charts blank until the tab was shown.
    setWidth(Math.floor(ref.current.getBoundingClientRect().width))
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

type Tip = { x: number; y: number; title: string; rows: { label: string; value: string; color: string }[] }

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null
  return (
    <div className="metrics-tooltip" style={{ left: tip.x, top: tip.y }}>
      <div className="metrics-tooltip-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.label} className="metrics-tooltip-row">
          <span className="metrics-key-line" style={{ background: r.color }} />
          <strong>{r.value}</strong>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  )
}

export function ChartCard({
  title,
  subtitle,
  series,
  mark,
  axis,
  format,
  children,
}: {
  title: string
  subtitle?: string
  series: Series[]
  mark: 'bar' | 'line'
  axis: Axis
  format: (v: number) => string
  children: React.ReactNode
}) {
  const [table, setTable] = React.useState(false)
  return (
    <div className="metrics-chart-card">
      <div className="metrics-card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <div className="metrics-card-sub">{subtitle}</div>}
        </div>
        <button type="button" className="metrics-table-toggle" onClick={() => setTable(!table)}>
          {table ? 'Chart' : 'Table'}
        </button>
      </div>
      {series.length >= 2 && (
        <div className="metrics-legend">
          {series.map((s) => (
            <span key={s.key} className="metrics-legend-item">
              <span className={mark === 'bar' ? 'metrics-legend-swatch' : 'metrics-key-line'} style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      {table ? (
        <div className="metrics-table-scroll">
          <table className="metrics-table">
            <thead>
              <tr>
                <th>{axis.heading}</th>
                {series.map((s) => (
                  <th key={s.key}>{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {axis.labels.map((label, i) => (
                <tr key={i}>
                  <td>{axis.titles[i] ?? label}</td>
                  {series.map((s) => (
                    <td key={s.key}>{s.values[i] === undefined ? '—' : format(s.values[i]!)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </div>
  )
}

function Frame({
  width,
  labels,
  ticks,
  format,
  children,
}: {
  width: number
  labels: string[]
  ticks: number[]
  format: (v: number) => string
  children: React.ReactNode
}) {
  const top = ticks[ticks.length - 1]
  const innerW = width - PAD.left - PAD.right
  const labelEvery = Math.ceil(labels.length / Math.max(1, Math.floor(innerW / 44)))
  return (
    <svg className="metrics-chart-svg" width={width} height={PAD.top + PLOT_HEIGHT + AXIS_BAND}>
      {ticks.map((t) => {
        const y = PAD.top + PLOT_HEIGHT - (t / top) * PLOT_HEIGHT
        return (
          <g key={t}>
            <line className={t === 0 ? 'metrics-baseline' : 'metrics-gridline'} x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} />
            <text className="metrics-axis-label" x={PAD.left - 6} y={y + 3} textAnchor="end">
              {format(t)}
            </text>
          </g>
        )
      })}
      {labels.map((label, i) =>
        (labels.length - 1 - i) % labelEvery === 0 ? (
          <text key={i} className="metrics-axis-label" x={PAD.left + (innerW * (i + 0.5)) / labels.length} y={PAD.top + PLOT_HEIGHT + 15} textAnchor="middle">
            {label}
          </text>
        ) : null,
      )}
      {children}
    </svg>
  )
}

// Column with only its top corners rounded — square where it meets the baseline or the segment below.
function columnPath(x: number, y: number, w: number, h: number, rounded: boolean): string {
  const r = rounded ? Math.min(4, h, w / 2) : 0
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
}

export function StackedBars({
  axis,
  series,
  format,
  integer,
}: {
  axis: Axis
  series: Series[]
  format: (v: number) => string
  integer?: boolean
}) {
  const [ref, width] = useWidth()
  const [tip, setTip] = React.useState<Tip | null>(null)
  const totals = axis.labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0))
  const ticks = niceTicks(Math.max(...totals, 0), { integer })
  const top = ticks[ticks.length - 1]
  const innerW = width - PAD.left - PAD.right
  const band = innerW / axis.labels.length
  const barW = Math.min(24, band * 0.6)
  const last = totals.length - 1

  return (
    <div ref={ref} className="metrics-plot" onMouseLeave={() => setTip(null)}>
      {width > 0 && (
        <Frame width={width} labels={axis.labels} ticks={ticks} format={format}>
          {axis.labels.map((_, i) => {
            const x = PAD.left + band * i + (band - barW) / 2
            let base = PAD.top + PLOT_HEIGHT
            const segments = series.filter((s) => (s.values[i] ?? 0) > 0)
            return (
              <g key={i}>
                {segments.map((s, si) => {
                  const h = ((s.values[i] ?? 0) / top) * PLOT_HEIGHT
                  const gap = si > 0 ? GAP : 0
                  const y = base - h
                  base = y
                  return <path key={s.key} d={columnPath(x, y + gap, barW, Math.max(0, h - gap), si === segments.length - 1)} style={{ fill: s.color }} />
                })}
                {i === last && totals[i] > 0 && (
                  <text className="metrics-bar-label" x={x + barW / 2} y={base - 5} textAnchor="middle">
                    {format(totals[i])}
                  </text>
                )}
                <rect
                  className="metrics-hit"
                  x={PAD.left + band * i}
                  y={PAD.top}
                  width={band}
                  height={PLOT_HEIGHT}
                  onMouseMove={() =>
                    setTip({
                      x: Math.min(PAD.left + band * (i + 0.5), width - 170),
                      y: 8,
                      title: axis.titles[i],
                      // Many-series stacks list only what's in that week; small ones list every series.
                      rows: series
                        .filter((s) => series.length <= 3 || (s.values[i] ?? 0) > 0)
                        .map((s) => ({ label: s.label, value: format(s.values[i] ?? 0), color: s.color })),
                    })
                  }
                />
              </g>
            )
          })}
        </Frame>
      )}
      <Tooltip tip={tip} />
    </div>
  )
}

export function LineChart({ axis, series, format }: { axis: Axis; series: Series[]; format: (v: number) => string }) {
  const [ref, width] = useWidth()
  const [hover, setHover] = React.useState<number | null>(null)
  const max = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== undefined)))
  const ticks = niceTicks(max)
  const top = ticks[ticks.length - 1]
  const innerW = width - PAD.left - PAD.right
  const band = innerW / axis.labels.length
  const xAt = (i: number) => PAD.left + band * (i + 0.5)
  const yAt = (v: number) => PAD.top + PLOT_HEIGHT - (v / top) * PLOT_HEIGHT

  return (
    <div ref={ref} className="metrics-plot" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <Frame width={width} labels={axis.labels} ticks={ticks} format={format}>
          {hover !== null && <line className="metrics-crosshair" x1={xAt(hover)} x2={xAt(hover)} y1={PAD.top} y2={PAD.top + PLOT_HEIGHT} />}
          {series.map((s) => {
            // Break the line across points with no value rather than drawing through them.
            const runs: string[][] = [[]]
            s.values.forEach((v, i) => (v === undefined ? runs.push([]) : runs[runs.length - 1].push(`${xAt(i)},${yAt(v)}`)))
            return (
              <g key={s.key}>
                {runs.filter((r) => r.length > 1).map((r, ri) => (
                  <polyline key={ri} className="metrics-line" points={r.join(' ')} style={{ stroke: s.color }} />
                ))}
                {s.values.map((v, i) => (v === undefined ? null : <circle key={i} className="metrics-dot" cx={xAt(i)} cy={yAt(v)} r={4} style={{ fill: s.color }} />))}
              </g>
            )
          })}
          {axis.labels.map((_, i) => (
            <rect key={i} className="metrics-hit" x={PAD.left + band * i} y={PAD.top} width={band} height={PLOT_HEIGHT} onMouseMove={() => setHover(i)} />
          ))}
        </Frame>
      )}
      <Tooltip
        tip={
          hover === null
            ? null
            : {
                x: Math.min(xAt(hover), width - 170),
                y: 8,
                title: axis.titles[hover],
                rows: series.map((s) => ({ label: s.label, value: s.values[hover] === undefined ? '—' : format(s.values[hover]!), color: s.color })),
              }
        }
      />
    </div>
  )
}
