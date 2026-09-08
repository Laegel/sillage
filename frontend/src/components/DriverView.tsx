import React from 'react'
import type { DriverMode, DriverSession, Project } from '../types.ts'
import DriverChat from './DriverChat.tsx'

function isBlocked(session: DriverSession): boolean {
  const last = session.messages[session.messages.length - 1]
  if (!last || last.role !== 'assistant') return false
  for (let i = last.events.length - 1; i >= 0; i--) {
    const event = last.events[i]
    if (event.kind === 'status') return Boolean(event.needsAction)
  }
  return false
}

function formatRelativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

export default function DriverView({
  sessions,
  selectedId,
  running,
  ownership,
  projects,
  connected,
  onSelect,
  onNew,
  onSend,
  onSetMode,
  onDelete,
}: {
  sessions: Record<string, DriverSession>
  selectedId: string | null
  running: Set<string>
  ownership: Record<string, string[]>
  projects: Project[]
  connected: boolean
  onSelect: (sessionId: string) => void
  onNew: (projectId: string) => void
  onSend: (sessionId: string, message: string, images?: string[]) => void
  onSetMode: (sessionId: string, mode: DriverMode) => void
  onDelete: (sessionId: string) => void
}) {
  const [newProjectId, setNewProjectId] = React.useState('')

  React.useEffect(() => {
    if (!newProjectId && projects.length > 0) setNewProjectId(projects[0].id)
  }, [projects, newProjectId])

  const sorted = Object.values(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const selected = selectedId ? sessions[selectedId] : null
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name || id

  return (
    <section className="driver-view">
      <div className="driver-toolbar">
        {projects.length > 0 && (
          <select
            className="driver-project-picker"
            value={newProjectId}
            onChange={(e) => setNewProjectId(e.target.value)}
            aria-label="Project for new driver session"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="driver-new-btn"
          onClick={() => onNew(newProjectId)}
          disabled={!connected || !newProjectId}
        >
          + New driver
        </button>
        {selected && <span className="driver-watching">watching {projectName(selected.projectId)}</span>}
      </div>

      <div className="driver-strip">
        {sorted.map((s) => {
          const owned = ownership[s.id] ?? []
          return (
            <div key={s.id} className="strip-item-wrap">
              <button type="button" className={`driver-strip-item ${s.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(s.id)}>
                <div className="driver-strip-title-row">
                  {isBlocked(s) && <span className="driver-strip-blocked-dot" />}
                  {running.has(s.id) && <span className="driver-running-dot" />}
                  <span className="driver-strip-title">{s.title || 'New driver'}</span>
                </div>
                <div className="driver-strip-meta-row">
                  <span className={`driver-mode-pill ${s.mode}`}>{s.mode}</span>
                  {owned.length > 0 && <span className="driver-owned-badge">{owned.length} owned</span>}
                </div>
                <span className="driver-strip-time">{formatRelativeTime(s.createdAt)}</span>
              </button>
              <button
                type="button"
                className="strip-item-delete"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(s.id)
                }}
                aria-label="Delete driver session"
              >
                ×
              </button>
            </div>
          )
        })}
        {sorted.length === 0 && <span className="hint">No driver sessions yet.</span>}
      </div>

      {selected ? (
        <>
          <div className="driver-mode-toggle">
            <button type="button" className={selected.mode === 'manual' ? 'active' : ''} onClick={() => onSetMode(selected.id, 'manual')}>
              Manual
            </button>
            <button type="button" className={selected.mode === 'autonomous' ? 'active' : ''} onClick={() => onSetMode(selected.id, 'autonomous')}>
              Autonomous
            </button>
          </div>
          <DriverChat
            key={selected.id}
            messages={selected.messages}
            running={running.has(selected.id)}
            onSend={(message, images) => onSend(selected.id, message, images)}
            draftKey={selected.id}
          />
        </>
      ) : (
        <p className="hint">Pick a driver session, or start a new one.</p>
      )}
    </section>
  )
}
