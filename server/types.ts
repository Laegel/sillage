export interface Issue {
  id: string
  title: string
  description: string
  status: string
  url: string
  branchName: string
  updatedAt?: Date
  project?: string
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

export interface CreateIssueInput {
  title: string
  description?: string
  projectId?: string
}

export interface UpdateIssueInput {
  title?: string
  description?: string
}

export type AgentChoice = 'claude' | 'free'

// Structured events emitted by a running agent, replacing pre-formatted output
// strings so the frontend can render each kind as its own component instead of
// one flat text blob. `id` on tool_call correlates a later status update (e.g.
// running -> complete) with the same card instead of appending a duplicate.
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

export interface LinearStoreLike {
  listIssues(): Promise<Issue[]>
  getIssue(identifier: string): Promise<Issue>
  createIssue(input: CreateIssueInput): Promise<Issue>
  updateIssue(identifier: string, input: UpdateIssueInput): Promise<Issue>
  setStatus(identifier: string, statusName: string): Promise<Issue>
  addComment(identifier: string, body: string): Promise<boolean>
  attachPr(identifier: string, prUrl: string): Promise<boolean>
  listProjects(): Promise<Project[]>
  resolveAgentChoice(identifier: string): Promise<AgentChoice>
}
