import React from 'react'
import { fetchFriction } from '../api.ts'
import type { FrictionEntry, FrictionKind } from '../types.ts'

// Grouped by *who can fix it*, not by raw kind — the question this panel
// exists to answer is "where are agents getting stuck, and is it my own
// harness doing it?". Mining the real run-logs showed most failures are the
// harness refusing (guards, read-only sessions, disabled tools), which is a
// very different fix from a tool genuinely breaking or a backend rate-limiting.
type Bucket = 'blocked' | 'harness' | 'tool' | 'backend' | 'orchestration'

const BUCKET_OF: Record<FrictionKind, Bucket> = {
  agent_blocked: 'blocked',
  tool_denied: 'harness',
  run_busy: 'harness',
  tool_error: 'tool',
  rate_limited: 'backend',
  backend_fallback: 'backend',
  stalled: 'backend',
  run_failed: 'backend',
  status_regression: 'orchestration',
  driver_action_failed: 'orchestration',
  ownership_exhausted: 'orchestration',
}

const BUCKETS: { key: Bucket; label: string; sub: string }[] = [
  { key: 'blocked', label: 'Agents blocked', sub: 'waiting on a decision' },
  { key: 'harness', label: 'Harness refused', sub: 'guards, read-only, busy' },
  { key: 'tool', label: 'Tool errors', sub: 'a tool genuinely failed' },
  { key: 'backend', label: 'Backend', sub: 'rate limits, stalls, crashes' },
  { key: 'orchestration', label: 'Orchestration', sub: 'driver, status drift' },
]

// Enough to see patterns without turning the panel back into a transcript.
const RECENT_LIMIT = 60

function when(ts: string): string {
  return new Date(ts).toLocaleString()
}

function owner(e: FrictionEntry): string {
  return e.issueId ?? e.sessionId ?? 'unattributed'
}

export default function FrictionView() {
  const [entries, setEntries] = React.useState<FrictionEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [filter, setFilter] = React.useState<Bucket | null>(null)

  React.useEffect(() => {
    fetchFriction()
      .then((res) => setEntries(res.entries))
      .finally(() => setLoading(false))
  }, [])

  const newestFirst = React.useMemo(
    () => [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [entries],
  )

  const counts = React.useMemo(() => {
    const c: Record<Bucket, number> = { blocked: 0, harness: 0, tool: 0, backend: 0, orchestration: 0 }
    for (const e of entries) c[BUCKET_OF[e.kind] ?? 'orchestration'] += 1
    return c
  }, [entries])

  const blocked = React.useMemo(() => newestFirst.filter((e) => e.kind === 'agent_blocked'), [newestFirst])

  // Everything else, grouped by the issue/session it happened on.
  const recentByOwner = React.useMemo(() => {
    const groups = new Map<string, FrictionEntry[]>()
    const rows = newestFirst
      .filter((e) => e.kind !== 'agent_blocked')
      .filter((e) => !filter || BUCKET_OF[e.kind] === filter)
      .slice(0, RECENT_LIMIT)
    for (const e of rows) {
      const key = owner(e)
      const list = groups.get(key) ?? []
      list.push(e)
      groups.set(key, list)
    }
    return [...groups.entries()]
  }, [newestFirst, filter])

  if (loading) return <div className="usage-view">Loading friction…</div>

  return (
    <div className="usage-view">
      <div className="usage-stats">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`usage-stat friction-stat${filter === b.key ? ' active' : ''}`}
            onClick={() => setFilter(filter === b.key ? null : b.key)}
            title={filter === b.key ? 'Clear filter' : `Show only ${b.label.toLowerCase()}`}
          >
            <span className="usage-stat-value">{counts[b.key]}</span>
            <span className="usage-stat-label">{b.label}</span>
            <span className="usage-stat-sub">{b.sub}</span>
          </button>
        ))}
      </div>

      {entries.length === 0 && (
        <div className="usage-chart-card">
          <h3>No friction recorded yet</h3>
          <p className="friction-empty">Blocked agents, refused tools and failed runs will show up here as they happen.</p>
        </div>
      )}

      {blocked.length > 0 && (!filter || filter === 'blocked') && (
        <div className="usage-chart-card">
          <h3>Agents waiting on a decision ({blocked.length})</h3>
          {blocked.map((e, i) => (
            <div key={i} className="friction-entry friction-entry-blocked">
              <span className="friction-owner">{owner(e)}</span>
              <span className="friction-detail">{e.detail}</span>
              <span className="friction-when">{when(e.timestamp)}</span>
            </div>
          ))}
        </div>
      )}

      {filter !== 'blocked' && recentByOwner.length > 0 && (
        <div className="usage-chart-card">
          <h3>Recent friction{filter ? ` — ${BUCKETS.find((b) => b.key === filter)?.label.toLowerCase()}` : ''}</h3>
          {recentByOwner.map(([key, rows]) => (
            <div key={key} className="friction-group">
              <div className="friction-group-title">
                {key} <span className="friction-count">{rows.length}</span>
              </div>
              {rows.map((e, i) => (
                <div key={i} className="friction-entry">
                  <span className={`friction-kind friction-kind-${BUCKET_OF[e.kind] ?? 'orchestration'}`}>{e.kind}</span>
                  <span className="friction-detail">{e.detail}</span>
                  <span className="friction-when">{when(e.timestamp)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
