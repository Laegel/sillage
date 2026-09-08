export interface Issue {
  id: string
  title: string
  description: string
  status: string
  url: string
  branchName: string
  updatedAt?: string
  createdAt?: string
  startedAt?: string | null
  completedAt?: string | null
  project?: string
  prUrl?: string | null
  priority: number
  priorityLabel: string
  milestone?: string
  labels: IssueLabel[]
  isSubIssue: boolean
  hasSubIssues: boolean
  parent?: SubIssue
}

export interface SubIssue {
  id: string
  title: string
  status: string
}

export interface IssueLabel {
  name: string
  color: string
}

export interface Project {
  id: string
  name: string
}

// One column move, from Linear's own Activity/history log for the issue.
export interface IssueTransition {
  fromStatus: string | null
  toStatus: string
  createdAt: string
}

// Structured events emitted by a running agent, replacing pre-formatted output
// strings so each kind can be rendered as its own component. `id` on tool_call
// correlates a later status update (e.g. running -> complete) with the same
// card instead of appending a duplicate. Mirrors server/types.ts verbatim,
// except `ideation_candidates`: a client-only synthetic event, never sent over
// the wire — IdeationChat.tsx injects it into a message's own events so its
// candidate cards render inline, in place, right after that specific message
// (see ChatThread.tsx's agentEventToPart/dataRenderers) instead of as a
// separate session-wide block that used to float to the bottom of the whole
// conversation regardless of which turn actually proposed it.
export type AgentEvent =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool_call'
      id: string
      tool: string
      label: string
      status: 'running' | 'complete' | 'error'
      input?: unknown
      output?: string
      error?: string
    }
  | { kind: 'status'; category: string; detail: string; needsAction?: string }
  | { kind: 'separator' }
  | { kind: 'orchestrator'; text: string }
  | { kind: 'ideation_candidates'; candidates: IdeationCandidate[] }
  | {
      kind: 'usage'
      backend: 'claude' | 'opencode' | 'kilocode'
      cost?: number
      tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }
    }

export interface UsageEntry {
  backend: 'claude' | 'opencode' | 'kilocode'
  timestamp: string
  id?: string
  cost?: number
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }
}

export interface SynthesisEntry {
  text: string
  updatedAt: string
  lastIssueId?: string
}

export interface StreamEntry {
  issueId: string
  events: AgentEvent[]
  done: boolean
  errored?: boolean
  stopped?: boolean
}

export interface Comment {
  id: string
  body: string
  createdAt: string
  authorName: string
}

export interface ToastMessage {
  id: number
  kind?: 'success' | 'error' | 'info'
  title: string
  body?: string
  prUrl?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  events: AgentEvent[]
  images?: string[]
}

export interface IdeationCandidate {
  title: string
  description: string
}

export type DriverMode = 'manual' | 'autonomous'
export type DriverActionKind = 'refine' | 'implement' | 'stop' | 'restart' | 'release' | 'merge' | 'flag' | 'create'

// Client-owned, same split as IdeationSession — the server only ever persists
// {backend, sessionId} for continuity plus the in-memory mode (see
// driverSessionModes on 'hello', which is the source of truth for mode after a
// reload, not this locally-cached value).
export interface DriverSession {
  id: string
  title: string
  projectId: string
  createdAt: string
  mode: DriverMode
  messages: ChatMessage[]
}

// Client-owned, mirroring how refine chat transcripts only ever live in
// localStorage (see refineHistory.ts) — the server never stores a session's
// title, projectId, or messages, only {backend, sessionId} for continuity.
export interface IdeationSession {
  id: string
  title: string
  projectId: string
  createdAt: string
  messages: ChatMessage[]
}

// Extends IdeationSession's shape with one field — the linked issue (if any)
// drives its output folder and whether "Commit to branch" is available.
export interface DesignSession {
  id: string
  title: string
  projectId: string
  issueId?: string
  createdAt: string
  messages: ChatMessage[]
}

export interface Plan {
  planId: string
  title?: string
  content: string
  issueId?: string
  sessionId?: string
  createdAt: string
  appliedAt?: string
}

export type WsMessage =
  | {
      type: 'hello'
      linear: string
      activeIssueIds: string[]
      activeRefineIssueIds: string[]
      activeIdeationSessionIds: string[]
      activeDriverSessionIds: string[]
      activeDesignSessionIds: string[]
      driverSessionModes: Record<string, DriverMode>
      driverOwnership: Record<string, string[]>
    }
  | { type: 'started'; issueId: string }
  | { type: 'task_started'; issueId: string; task: string }
  | { type: 'output'; issueId: string; event: AgentEvent }
  | { type: 'done'; issueId: string; exitCode: number | null }
  | { type: 'stopped'; issueId: string }
  | { type: 'pr_created'; issueId: string; prUrl: string }
  | { type: 'issue_updated'; issueId: string }
  | { type: 'issue_created'; issue?: Issue; issueId?: string }
  | { type: 'issue_removed'; issueId: string }
  | { type: 'error'; issueId?: string; sessionId?: string; message: string }
  | { type: 'refine_turn_started'; issueId: string }
  | { type: 'refine_output'; issueId: string; event: AgentEvent }
  // `summary` is the turn's accumulated text output, plain (not markdown-rendered)
  // and truncated server-side — it exists for the Driver's ownership status-update
  // prompt, not for the UI, which already has the full transcript via refine_output.
  | { type: 'refine_turn_done'; issueId: string; summary?: string }
  | { type: 'refine_ready_to_consolidate'; issueId: string }
  | { type: 'ideation_turn_started'; sessionId: string }
  | { type: 'ideation_output'; sessionId: string; event: AgentEvent }
  | { type: 'ideation_turn_done'; sessionId: string }
  | { type: 'driver_turn_started'; sessionId: string }
  | { type: 'driver_output'; sessionId: string; event: AgentEvent }
  | { type: 'driver_turn_done'; sessionId: string }
  | { type: 'driver_action'; sessionId: string; action: DriverActionKind; issueId?: string; status: 'started' | 'done' | 'failed' | 'skipped'; message?: string }
  | { type: 'driver_mode_changed'; sessionId: string; mode: DriverMode; reason?: string }
  | { type: 'driver_ownership_changed'; sessionId: string; ownedIssueIds: string[] }
  | { type: 'design_turn_started'; sessionId: string }
  | { type: 'design_output'; sessionId: string; event: AgentEvent }
  | { type: 'design_turn_done'; sessionId: string }
  | { type: 'design_issue_linked'; sessionId: string; issueId: string }
  | { type: 'design_committed'; sessionId: string; ok: boolean; message: string }
