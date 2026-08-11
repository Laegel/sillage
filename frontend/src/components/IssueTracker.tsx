import React from 'react'
import type { Issue, Project } from '../types.ts'

export default function IssueTracker({
  issues,
  columns,
  projects,
  selectedId,
  runningIds,
  onSelect,
  onCreate,
  onMove,
}: {
  issues: Issue[]
  columns: string[]
  projects: Project[]
  selectedId: string | null
  runningIds: Set<string>
  onSelect: (issue: Issue) => void
  onCreate: (payload: { title: string; description?: string; projectId?: string }) => Promise<void>
  onMove: (issueId: string, status: string) => void
}) {
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [newIssueProjectId, setNewIssueProjectId] = React.useState('')
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState('')
  const [selectedProjectId, setSelectedProjectId] = React.useState('all')

  React.useEffect(() => {
    if (!newIssueProjectId && projects.length > 0) setNewIssueProjectId(projects[0].id)
  }, [projects, newIssueProjectId])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    setCreating(true)
    setError('')
    try {
      await onCreate({ title, description, projectId: newIssueProjectId || undefined })
      setTitle('')
      setDescription('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const visibleIssues = issues.filter(
    (issue) => selectedProjectId === 'all' || issue.project === selectedProjectId,
  )

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name || id

  const priorityLevel = (priority: number) => ({ 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' }[priority] || 'low')

  return (
    <section className="tracker">
      <form className="create-form" onSubmit={handleCreate}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New issue title"
          aria-label="Issue title"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          aria-label="Issue description"
        />
        {projects.length > 0 && (
          <select
            value={newIssueProjectId}
            onChange={(e) => setNewIssueProjectId(e.target.value)}
            aria-label="Project"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <button type="submit" disabled={creating || !title.trim()}>
          {creating ? 'Saving…' : 'Create issue'}
        </button>
        {error && <span className="form-error">{error}</span>}
      </form>

      {projects.length > 0 && (
        <div className="project-filter">
          <label htmlFor="project-filter">Project</label>
          <select
            id="project-filter"
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
          >
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="columns">
        {columns.map((column) => {
          const columnIssues = visibleIssues.filter((issue) => issue.status === column)
          return (
            <div
              key={column}
              className={`column column-${column.toLowerCase().replace(/\s+/g, '-')}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const issueId = e.dataTransfer.getData('text/plain')
                if (issueId) onMove(issueId, column)
              }}
            >
              <header className="column-header">
                <span>{column}</span>
                <span className="column-count">{columnIssues.length}</span>
              </header>
              {columnIssues.map((issue) => (
                <button
                  key={issue.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', issue.id)}
                  className={`issue-card ${selectedId === issue.id ? 'selected' : ''} ${runningIds.has(issue.id) ? 'running' : ''}`}
                  onClick={() => onSelect(issue)}
                >
                  <div className="issue-id">{issue.id}</div>
                  <div className="issue-title">{issue.title}</div>
                  {issue.description && <div className="issue-description">{issue.description}</div>}
                  {(issue.project || issue.milestone || issue.priority > 0) && (
                    <div className="issue-meta">
                      {issue.project && (
                        <span className="issue-meta-badge project">▤ {projectName(issue.project)}</span>
                      )}
                      {issue.milestone && <span className="issue-meta-badge milestone">◆ {issue.milestone}</span>}
                      {issue.priority > 0 && (
                        <span className={`issue-meta-badge priority-${priorityLevel(issue.priority)}`}>
                          ● {issue.priorityLabel}
                        </span>
                      )}
                    </div>
                  )}
                  {issue.labels.length > 0 && (
                    <div className="issue-labels">
                      {issue.labels.map((label) => (
                        <span key={label.name} className="issue-label-chip">
                          <span className="issue-label-dot" style={{ background: label.color }} />
                          {label.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {runningIds.has(issue.id) && <div className="issue-badge">running</div>}
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}
