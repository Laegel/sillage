import React from 'react'
import { DockviewReact, themeAbyss, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { fetchDesignPreview, fetchDesignControls } from '../api.ts'
import { parseDesignTokens, type DesignToken } from '../lib/designTokens.ts'
import type { ChatMessage, DesignSession, Issue, Project } from '../types.ts'
import DesignChat from './DesignChat.tsx'
import PreviewPanel from './panels/PreviewPanel.tsx'
import ControlsPanel from './panels/ControlsPanel.tsx'
import TokensPanel from './panels/TokensPanel.tsx'

type ChatPanelParams = {
  sessionId: string
  messages: ChatMessage[]
  running: boolean
  issueId?: string
  committing: boolean
  onSend: (message: string, images?: string[]) => void
  onCommit: () => void
}
type PreviewPanelParams = {
  html: string | null | undefined
  error: string
  onRefresh: () => void
  onIframeReady: (el: HTMLIFrameElement | null) => void
}
type ControlsPanelParams = { controlsHtml: string | null | undefined }
type TokensPanelParams = { tokens: DesignToken[] }

// Stable across renders — each panel component reads everything from
// `props.params`, so this map never needs to change identity. Defined once
// at module scope rather than memoized inside DesignView.
const dockComponents = {
  chat: (props: IDockviewPanelProps<ChatPanelParams>) => <DesignChat key={props.params.sessionId} {...props.params} />,
  preview: (props: IDockviewPanelProps<PreviewPanelParams>) => <PreviewPanel {...props.params} />,
  controls: (props: IDockviewPanelProps<ControlsPanelParams>) => <ControlsPanel {...props.params} />,
  tokens: (props: IDockviewPanelProps<TokensPanelParams>) => <TokensPanel {...props.params} />,
}

const DESIGN_LAYOUT_KEY = 'sillage.designLayout'

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

  // Bridges the controls iframe's postMessage commands into the preview
  // iframe now that they're separate dockview panels instead of siblings in
  // one flex row — moved up here since DesignView is the nearest shared
  // parent, same relay logic that used to live in DesignPreview.tsx.
  const previewIframeRef = React.useRef<HTMLIFrameElement | null>(null)
  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'design-command') return
      previewIframeRef.current?.contentWindow?.postMessage(data, '*')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // Only defined while a session is selected — the dock is only ever
  // rendered inside the `selected &&` branch below, so these are guaranteed
  // non-null by the time dockview actually mounts/updates panels.
  const chatParams: ChatPanelParams | null = selected
    ? {
        sessionId: selected.id,
        messages: selected.messages,
        running: running.has(selected.id),
        issueId: selected.issueId,
        committing: committing.has(selected.id),
        onSend: (message, images) => onSend(selected.id, message, images),
        onCommit: () => onCommit(selected.id),
      }
    : null
  const previewParams: PreviewPanelParams = {
    html,
    error: previewError,
    onRefresh: loadPreview,
    onIframeReady: (el) => (previewIframeRef.current = el),
  }
  const controlsParams: ControlsPanelParams = { controlsHtml }
  const tokensParams: TokensPanelParams = { tokens }

  // Keeps refs so `onReady` (fired once by dockview, never re-run — its own
  // deps stay `[]` so the panel arrangement isn't rebuilt on every session
  // switch) can still read the freshest params at the moment it actually
  // constructs the initial panels.
  const chatParamsRef = React.useRef(chatParams)
  chatParamsRef.current = chatParams
  const previewParamsRef = React.useRef(previewParams)
  previewParamsRef.current = previewParams
  const controlsParamsRef = React.useRef(controlsParams)
  controlsParamsRef.current = controlsParams
  const tokensParamsRef = React.useRef(tokensParams)
  tokensParamsRef.current = tokensParams

  const dockApiRef = React.useRef<DockviewReadyEvent['api'] | null>(null)

  // Keeps every already-open panel's content in sync as chat/preview/tokens
  // state changes — dockview only reads `params` again when explicitly told
  // to via `updateParameters`, it won't re-render a panel just because
  // DesignView re-rendered.
  React.useEffect(() => {
    const api = dockApiRef.current
    if (!api) return
    if (chatParams) api.getPanel('chat')?.api.updateParameters(chatParams)
    api.getPanel('preview')?.api.updateParameters(previewParams)
    api.getPanel('controls')?.api.updateParameters(controlsParams)
    api.getPanel('tokens')?.api.updateParameters(tokensParams)
  }, [chatParams, previewParams, controlsParams, tokensParams])

  const onReady = React.useCallback((event: DockviewReadyEvent) => {
    const api = event.api
    dockApiRef.current = api
    const saved = localStorage.getItem(DESIGN_LAYOUT_KEY)
    if (saved) {
      try {
        api.fromJSON(JSON.parse(saved))
      } catch {
        // corrupt/incompatible saved layout — fall through and build the
        // default arrangement below instead
      }
    }
    if (!api.getPanel('chat')) {
      api.addPanel({ id: 'chat', component: 'chat', title: 'Chat', params: chatParamsRef.current! })
    }
    if (!api.getPanel('preview')) {
      api.addPanel({
        id: 'preview',
        component: 'preview',
        title: 'Preview',
        params: previewParamsRef.current,
        position: { referencePanel: 'chat', direction: 'right' },
      })
    }
    if (!api.getPanel('controls')) {
      api.addPanel({
        id: 'controls',
        component: 'controls',
        title: 'Controls',
        params: controlsParamsRef.current,
        position: { referencePanel: 'preview', direction: 'right' },
        initialWidth: 320,
      })
    }
    if (!api.getPanel('tokens')) {
      api.addPanel({
        id: 'tokens',
        component: 'tokens',
        title: 'Tokens',
        params: tokensParamsRef.current,
        position: { referencePanel: 'controls', direction: 'within' },
      })
    }
    api.onDidLayoutChange(() => localStorage.setItem(DESIGN_LAYOUT_KEY, JSON.stringify(api.toJSON())))
  }, [])

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
            <div className="design-dock">
              <DockviewReact components={dockComponents} onReady={onReady} theme={themeAbyss} />
            </div>
          </>
        ) : (
          <p className="hint">Pick a design, or start a new one.</p>
        )}
      </div>
    </section>
  )
}
