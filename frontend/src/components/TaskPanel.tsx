import React from 'react'
import type { ChatMessage, Issue, SubIssue } from '../types.ts'
import { fetchSubIssues } from '../api.ts'
import RefineChat from './RefineChat.tsx'

export default function TaskPanel({
  issue,
  connected,
  running,
  onStart,
  onStop,
  onRestart,
  onUpdate,
  onMove,
  onClose,
  refineChat,
  refineRunning,
  draftPlan,
  onRefineStart,
  onRefineMessage,
  onConsolidate,
  onApplyPlan,
}: {
  issue: Issue
  connected: boolean
  running: boolean
  onStart: (issueId: string, task: string) => void
  onStop: (issueId: string) => void
  onRestart: (issueId: string) => void
  onUpdate: (issueId: string, payload: { title?: string; description?: string }) => Promise<void>
  // Accepted for prop-shape parity with IssueTracker's own onMove (board drag-
  // and-drop) — this panel has no evidenced UI trigger for it yet.
  onMove: (issueId: string, status: string) => void
  onClose: () => void
  refineChat: ChatMessage[]
  refineRunning: boolean
  draftPlan: string | null
  onRefineStart: (issueId: string) => void
  onRefineMessage: (issueId: string, message: string) => void
  onConsolidate: (issueId: string) => void
  onApplyPlan: (issueId: string, planText: string) => void
}) {
  void onMove
  const [task, setTask] = React.useState('')
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const [editDescription, setEditDescription] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [width, setWidth] = React.useState<'sm' | 'md' | 'lg'>('md')
  const [subIssues, setSubIssues] = React.useState<SubIssue[]>([])

  React.useEffect(() => {
    setTask(issue.description || '')
    setEditTitle(issue.title)
    setEditDescription(issue.description || '')
    setEditing(false)
  }, [issue])

  React.useEffect(() => {
    if (!issue.hasSubIssues) {
      setSubIssues([])
      return
    }
    fetchSubIssues(issue.id)
      .then((data) => setSubIssues(data.subIssues))
      .catch(() => setSubIssues([]))
  }, [issue.id, issue.hasSubIssues])

  const handleStop = () => onStop(issue.id)
  const handleRestart = () => onRestart(issue.id)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!task.trim() || running) return
    onStart(issue.id, task)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await onUpdate(issue.id, { title: editTitle, description: editDescription })
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <aside className={`task-panel open width-${width}`}>
      <div className="task-panel-header">
        <h2>Task panel</h2>
        <div className="task-panel-header-actions">
          <div className="task-panel-width-toggle">
            {(['sm', 'md', 'lg'] as const).map((w) => (
              <button
                key={w}
                type="button"
                className={width === w ? 'active' : ''}
                onClick={() => setWidth(w)}
              >
                {w.toUpperCase()}
              </button>
            ))}
          </div>
          <button type="button" className="task-panel-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
      </div>
      {editing ? (
        <form className="edit-issue-form" onSubmit={handleSave}>
          <input
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            aria-label="Edit issue title"
          />
          <textarea
            rows={3}
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            aria-label="Edit issue description"
          />
          <div className="edit-issue-actions">
            <button type="submit" disabled={saving || !editTitle.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="selected-issue">
          <span className="issue-id">{issue.id}</span>
          <span>{issue.title}</span>
          <button type="button" className="edit-issue-toggle" onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      )}
      {issue.parent && (
        <div className="parent-issue-link">
          ↑ Parent: {issue.parent.id} — {issue.parent.title}
        </div>
      )}
      {issue.prUrl && (
        <div className="pr-link">
          <a href={issue.prUrl} target="_blank" rel="noreferrer">
            PR: {issue.prUrl} ↗
          </a>
        </div>
      )}
      {issue.status === 'Backlog' ? (
        refineChat.length === 0 && !refineRunning ? (
          <button type="button" className="refine-cta" onClick={() => onRefineStart(issue.id)} disabled={!connected}>
            Refine
          </button>
        ) : (
          <RefineChat
            key={issue.id}
            messages={refineChat}
            running={refineRunning}
            draftPlan={draftPlan}
            onSend={(message) => onRefineMessage(issue.id, message)}
            onConsolidate={() => onConsolidate(issue.id)}
            onApply={(planText) => onApplyPlan(issue.id, planText)}
          />
        )
      ) : (
        <form onSubmit={handleSubmit}>
          <label htmlFor="task">What should the agent do?</label>
          <textarea
            id="task"
            rows={4}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g. Add a dark-mode toggle to the dashboard"
          />
          <div className="task-panel-actions">
            {running ? (
              <button type="button" onClick={handleStop} disabled={!connected}>
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!task.trim() || !connected}>
                Start task
              </button>
            )}
            {!running && issue.prUrl && (
              <button type="button" onClick={handleRestart} disabled={!connected}>
                Restart
              </button>
            )}
          </div>
          {!connected && <span className="hint">Connecting to orchestrator…</span>}
        </form>
      )}
      {subIssues.length > 0 && (
        <div className="sub-issues">
          <h3>Sub-issues</h3>
          {subIssues.map((sub) => (
            <div key={sub.id} className="sub-issue">
              <span className="sub-issue-title">
                {sub.id} — {sub.title}
              </span>
              <span className="sub-issue-status">{sub.status}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}
