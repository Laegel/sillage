import React from 'react'
import type { ChatMessage, Issue } from '../types.ts'
import RefineChat from './RefineChat.tsx'

export default function TaskPanel({
  issue,
  classification,
  connected,
  running,
  onStart,
  onUpdate,
  refineChat,
  refineRunning,
  draftPlan,
  onRefineStart,
  onRefineMessage,
  onConsolidate,
  onApplyPlan,
}: {
  issue: Issue | null
  classification: string | null
  connected: boolean
  running: boolean
  onStart: (issueId: string, task: string) => void
  onUpdate: (issueId: string, payload: { title?: string; description?: string }) => Promise<void>
  refineChat: ChatMessage[]
  refineRunning: boolean
  draftPlan: string | null
  onRefineStart: (issueId: string) => void
  onRefineMessage: (issueId: string, message: string) => void
  onConsolidate: (issueId: string) => void
  onApplyPlan: (issueId: string, planText: string) => void
}) {
  const [task, setTask] = React.useState('')
  const [editing, setEditing] = React.useState(false)
  const [editTitle, setEditTitle] = React.useState('')
  const [editDescription, setEditDescription] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (issue) {
      setTask(issue.description || '')
      setEditTitle(issue.title)
      setEditDescription(issue.description || '')
      setEditing(false)
    }
  }, [issue])

  if (!issue) {
    return (
      <aside className="task-panel empty">
        <h2>Task panel</h2>
        <p>Pick an issue from the tracker to turn it into a PR.</p>
      </aside>
    )
  }

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
    <aside className="task-panel">
      <h2>Task panel</h2>
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
          <button type="submit" disabled={!task.trim() || running || !connected}>
            {running ? 'Working…' : 'Start task'}
          </button>
          {!connected && <span className="hint">Connecting to orchestrator…</span>}
        </form>
      )}
      {classification && (
        <div className={`classification classification-${classification}`}>
          classified as <strong>{classification}</strong>
        </div>
      )}
    </aside>
  )
}
