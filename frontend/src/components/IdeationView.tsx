import React from 'react'
import type { IdeationCandidate, IdeationSession, Project } from '../types.ts'
import IdeationChat from './IdeationChat.tsx'

// Mirrors DesignView's isBlocked — a session is "blocked" iff its last
// message is the assistant's and its most recent status event still needs
// something from the user; self-clears the moment the user replies.
function isBlocked(session: IdeationSession): boolean {
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

export default function IdeationView({
  sessions,
  selectedId,
  running,
  projects,
  connected,
  onSelect,
  onNew,
  onSend,
  onCreateCandidate,
  onDelete,
}: {
  sessions: Record<string, IdeationSession>
  selectedId: string | null
  running: Set<string>
  projects: Project[]
  connected: boolean
  onSelect: (sessionId: string) => void
  onNew: (projectId: string) => void
  onSend: (sessionId: string, message: string, images?: string[]) => void
  onCreateCandidate: (sessionId: string, candidate: IdeationCandidate, projectId: string) => Promise<void>
  onDelete: (sessionId: string) => void
}) {
  const [newProjectId, setNewProjectId] = React.useState('')

  React.useEffect(() => {
    if (!newProjectId && projects.length > 0) setNewProjectId(projects[0].id)
  }, [projects, newProjectId])

  const sorted = Object.values(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const selected = selectedId ? sessions[selectedId] : null

  return (
    <section className="ideation-view">
      <div className="ideation-toolbar">
        {projects.length > 0 && (
          <select
            className="ideation-project-picker"
            value={newProjectId}
            onChange={(e) => setNewProjectId(e.target.value)}
            aria-label="Project for new discussion"
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
          className="ideation-new-btn"
          onClick={() => onNew(newProjectId)}
          disabled={!connected || !newProjectId}
        >
          + New idea
        </button>
      </div>

      <div className="ideation-strip">
        {sorted.map((s) => (
          <div key={s.id} className="strip-item-wrap">
            <button type="button" className={`ideation-strip-item ${s.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(s.id)}>
              <div className="ideation-strip-title-row">
                {isBlocked(s) && <span className="ideation-strip-blocked-dot" />}
                <span className="ideation-strip-title">{s.title || 'New discussion'}</span>
              </div>
              <span className="ideation-strip-time">{formatRelativeTime(s.createdAt)}</span>
            </button>
            <button
              type="button"
              className="strip-item-delete"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(s.id)
              }}
              aria-label="Delete discussion"
            >
              ×
            </button>
          </div>
        ))}
        {sorted.length === 0 && <span className="hint">No discussions yet.</span>}
      </div>

      {selected ? (
        <IdeationChat
          key={selected.id}
          sessionId={selected.id}
          projectId={selected.projectId}
          messages={selected.messages}
          running={running.has(selected.id)}
          onSend={(message, images) => onSend(selected.id, message, images)}
          onCreateCandidate={onCreateCandidate}
        />
      ) : (
        <p className="hint">Pick a discussion, or start a new one.</p>
      )}
    </section>
  )
}
