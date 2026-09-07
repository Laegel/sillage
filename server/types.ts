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
  isSubIssue: boolean
  hasSubIssues: boolean
  parent?: SubIssue
}

export interface IssueLabel {
  name: string
  color: string
}

export interface SubIssue {
  id: string
  title: string
  status: string
  url: string
}

export interface IssueTransition {
  fromStatus?: string
  toStatus: string
  timestamp: string
}

export interface Comment {
  authorName: string
  createdAt: string
  body: string
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
  | {
      kind: 'usage'
      backend: string
      cost?: number
      tokens?: { input?: number; output?: number; cacheRead?: number }
    }

// Manual: the Driver session UI drives one action at a time, waiting for the
// user. Autonomous: the Driver scans the backlog and acts on its own.
export type DriverMode = 'manual' | 'autonomous'

export type DriverActionKind = 'refine' | 'implement' | 'stop' | 'restart' | 'release' | 'merge' | 'flag' | 'create'

// 'create' has no existing issue yet — title is its required field, in place
// of issueId, which every other kind needs.
export type DriverAction =
  | { action: 'create'; title: string; description?: string }
  | { action: Exclude<DriverActionKind, 'create'>; issueId: string; task?: string; reason?: string }

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
  listComments(identifier: string): Promise<Comment[]>
  listSubIssues(identifier: string): Promise<SubIssue[]>
  listIssueHistory(identifier: string): Promise<IssueTransition[]>
  invalidateIssue(identifier: string): void
}
