export interface Issue {
  id: string
  title: string
  description: string
  status: string
  url: string
  branchName: string
  updatedAt?: string
  project?: string
  prUrl?: string | null
  priority: number
  priorityLabel: string
  milestone?: string
  labels: IssueLabel[]
}

export interface IssueLabel {
  name: string
  color: string
}

export interface Project {
  id: string
  name: string
}

// Structured events emitted by a running agent, replacing pre-formatted output
// strings so each kind can be rendered as its own component. `id` on tool_call
// correlates a later status update (e.g. running -> complete) with the same
// card instead of appending a duplicate. Mirrors server/types.ts verbatim.
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

export interface StreamEntry {
  issueId: string
  classification: string
  events: AgentEvent[]
  done: boolean
  errored?: boolean
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
}

export type WsMessage =
  | { type: 'hello'; linear: string; activeIssueIds: string[]; activeRefineIssueIds: string[] }
  | { type: 'started'; issueId: string; classification: string }
  | { type: 'task_started'; issueId: string; classification: string; task: string }
  | { type: 'output'; issueId: string; event: AgentEvent }
  | { type: 'done'; issueId: string; exitCode: number | null }
  | { type: 'pr_created'; issueId: string; prUrl: string }
  | { type: 'issue_updated'; issueId: string }
  | { type: 'issue_created'; issue?: Issue; issueId?: string }
  | { type: 'issue_removed'; issueId: string }
  | { type: 'error'; issueId?: string; message: string }
  | { type: 'refine_turn_started'; issueId: string }
  | { type: 'refine_output'; issueId: string; event: AgentEvent }
  | { type: 'refine_turn_done'; issueId: string }
