import React from 'react'
import { fetchDesignPreview, fetchDesignControls } from '../api.ts'
import { isColorToken, parseDesignTokens } from '../lib/designTokens.ts'
import type { DesignSession, Issue, Project } from '../types.ts'
import DesignChat from './DesignChat.tsx'
import DesignPreview from './DesignPreview.tsx'

// Mirrors IdeationView's isBlocked — a session is "blocked" iff its last
// message is the assistant's and its most recent status event still needs
// something from the user; self-clears the moment the user replies.
function isBlocked(session: DesignSession): boolean {
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

export default function DesignView({
  sessions,
  selectedId,
  running,
  committing,
  previewRefresh,
  projects,
  issues,
  connected,
  onSelect,
  onNew,
  onSend,
  onLinkIssue,
  onCommit,
  onDelete,
}: {
  sessions: Record<string, DesignSession>
  selectedId: string | null
  running: Set<string>
  committing: Set<string>
  previewRefresh: Record<string, number>
  projects: Project[]
  issues: Issue[]
  connected: boolean
  onSelect: (sessionId: string) => void
  onNew: (projectId: string, issueId?: string) => void
  onSend: (sessionId: string, message: string, images?: string[]) => void
  onLinkIssue: (sessionId: string, issueId: string) => void
  onCommit: (sessionId: string) => void
  onDelete: (sessionId: string) => void
}) {
  const [newProjectId, setNewProjectId] = React.useState('')
  const [newIssueId, setNewIssueId] = React.useState('')
  const [html, setHtml] = React.useState<string | null | undefined>(undefined)
  const [controlsHtml, setControlsHtml] = React.useState<string | null | undefined>(undefined)
  const [previewError, setPreviewError] = React.useState('')

  React.useEffect(() => {
    if (!newProjectId && projects.length > 0) setNewProjectId(projects[0].id)
  }, [projects, newProjectId])

  const sorted = Object.values(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const selected = selectedId ? sessions[selectedId] : null
  const projectIssues = issues.filter((i) => i.project === newProjectId)
  const linkableIssues = selected ? issues.filter((i) => i.project === selected.projectId) : []

  // Lifted up from DesignPreview so the design-tokens panel below can read
  // the same html string instead of fetching it a second time. Depends on
  // primitives, not the `selected` object itself — that object is replaced
  // on every new chat message, and refetching the preview on each message
  // (instead of only when previewRefresh bumps on design_turn_done) would be
  // pure waste.
  const selectedId_ = selected?.id
  const selectedProjectId = selected?.projectId
  const selectedIssueId = selected?.issueId
  const loadPreview = React.useCallback(() => {
    if (!selectedId_ || !selectedProjectId) return
    setPreviewError('')
    fetchDesignPreview(selectedId_, selectedProjectId, selectedIssueId)
      .then((res) => setHtml(res.html))
      .catch((err) => setPreviewError(err instanceof Error ? err.message : String(err)))
    fetchDesignControls(selectedId_, selectedProjectId, selectedIssueId)
      .then((res) => setControlsHtml(res.html))
      .catch(() => setControlsHtml(null))
  }, [selectedId_, selectedProjectId, selectedIssueId])

  React.useEffect(() => {
    setHtml(undefined)
    setControlsHtml(undefined)
    setPreviewError('')
    loadPreview()
  }, [loadPreview, selectedId_ && previewRefresh[selectedId_]])

  const tokens = React.useMemo(() => parseDesignTokens(html ?? ''), [html])

  return (
    <section className="design-view">
      <div className="design-toolbar">
        {projects.length > 0 && (
          <select
            className="design-project-picker"
            value={newProjectId}
            onChange={(e) => {
              setNewProjectId(e.target.value)
              setNewIssueId('')
            }}
            aria-label="Project for new design"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <select
          className="design-issue-picker"
          value={newIssueId}
          onChange={(e) => setNewIssueId(e.target.value)}
          aria-label="Issue to link the new design to"
        >
          <option value="">No issue (draft)</option>
          {projectIssues.map((i) => (
            <option key={i.id} value={i.id}>
              {i.id}: {i.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="design-new-btn"
          onClick={() => onNew(newProjectId, newIssueId || undefined)}
          disabled={!connected || !newProjectId}
        >
          + New design
        </button>
      </div>

      <div className="design-strip">
        {sorted.map((s) => (
          <div key={s.id} className="strip-item-wrap">
            <button type="button" className={`design-strip-item ${s.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(s.id)}>
              <div className="design-strip-title-row">
                {isBlocked(s) && <span className="design-strip-blocked-dot" />}
                <span className="design-strip-title">{s.title || 'New design'}</span>
                {s.issueId && <span className="design-issue-badge">{s.issueId}</span>}
              </div>
              <span className="design-strip-time">{formatRelativeTime(s.createdAt)}</span>
            </button>
            <button
              type="button"
              className="strip-item-delete"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(s.id)
              }}
              aria-label="Delete design"
            >
              ×
            </button>
          </div>
        ))}
        {sorted.length === 0 && <span className="hint">No designs yet.</span>}
      </div>

      <div className="design-main">
        {selected ? (
          <>
            {!selected.issueId && linkableIssues.length > 0 && (
              <div className="design-link-row">
                <select
                  value=""
                  onChange={(e) => e.target.value && onLinkIssue(selected.id, e.target.value)}
                  aria-label="Link this draft to an issue"
                >
                  <option value="">Link to an issue…</option>
                  {linkableIssues.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.id}: {i.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <details className="synthesis-panel design-tokens-panel">
              <summary className="synthesis-panel-header">
                <span className="synthesis-panel-title">Design tokens</span>
              </summary>
              <div className="synthesis-panel-body design-tokens-list">
                {tokens.length === 0 && <p className="hint">No design tokens declared in this mockup yet.</p>}
                {tokens.map((t) => (
                  <div key={t.name} className="design-token-row">
                    {isColorToken(t.value) && <span className="design-token-swatch" style={{ background: t.value }} />}
                    <code className="design-token-name">{t.name}</code>
                    <code className="design-token-value">{t.value}</code>
                  </div>
                ))}
              </div>
            </details>
            <div className="design-split">
              <DesignChat
                key={selected.id}
                messages={selected.messages}
                running={running.has(selected.id)}
                issueId={selected.issueId}
                committing={committing.has(selected.id)}
                onSend={(message, images) => onSend(selected.id, message, images)}
                onCommit={() => onCommit(selected.id)}
              />
              <DesignPreview html={html} controlsHtml={controlsHtml} error={previewError} onRefresh={loadPreview} />
            </div>
          </>
        ) : (
          <p className="hint">Pick a design, or start a new one.</p>
        )}
      </div>
    </section>
  )
}
