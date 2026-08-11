import { LinearClient, type Issue as SdkIssue, type WorkflowState } from '@linear/sdk'
import type { AgentChoice, CreateIssueInput, Issue, IssueLabel, LinearStoreLike, Project, UpdateIssueInput } from './types.ts'

export const STATUS_COLUMNS = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done']

const PR_MARKER = 'opened-pr:'

// Matches the "Agent" grouped label in Linear (group label "Agent" with child
// labels "Claude" / "Free"). Default is Free; the label only overrides.
const AGENT_LABEL_GROUP = 'Agent'
const AGENT_LABEL_MAP: Record<string, AgentChoice> = { Claude: 'claude', Free: 'free' }
const AGENT_LABEL_NAMES = new Set(Object.keys(AGENT_LABEL_MAP))
const DEFAULT_AGENT: AgentChoice = 'free'

function toStatusName(state: WorkflowState | undefined): string {
  return state ? state.name : 'Backlog'
}

// ponytail: excludes the Agent routing labels by name instead of checking
// label.parent, to avoid an extra async round trip per label per issue in
// listIssues(). Ceiling: misfires if a different label group ever reuses the
// names "Claude"/"Free". Upgrade path: check label.parent === AGENT_LABEL_GROUP
// the way resolveAgentChoice() already does, if that happens.
async function mapLabels(issue: SdkIssue): Promise<IssueLabel[]> {
  const labels = await issue.labels({ first: 50 })
  const nodes = labels.nodes || labels
  return nodes.filter((l) => !AGENT_LABEL_NAMES.has(l.name)).map((l) => ({ name: l.name, color: l.color }))
}

export class LinearStore implements LinearStoreLike {
  client: LinearClient

  constructor() {
    this.client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY })
  }

  async listIssues(): Promise<Issue[]> {
    const issues = await this.client.issues({ first: 100 })
    const nodes = issues.nodes || issues
    return Promise.all(
      nodes.map(async (issue: SdkIssue) => ({
        id: issue.identifier,
        title: issue.title,
        description: issue.description || '',
        status: toStatusName(await issue.state),
        url: issue.url,
        branchName: issue.branchName,
        updatedAt: issue.updatedAt,
        project: issue.projectId,
        priority: issue.priority,
        priorityLabel: issue.priorityLabel,
        milestone: (await issue.projectMilestone)?.name,
        labels: await mapLabels(issue),
      })),
    )
  }

  async getIssue(identifier: string): Promise<Issue> {
    const issue = await this.client.issue(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    return {
      id: issue.identifier,
      title: issue.title,
      description: issue.description || '',
      status: toStatusName(await issue.state),
      url: issue.url,
      branchName: issue.branchName,
      project: issue.projectId,
      priority: issue.priority,
      priorityLabel: issue.priorityLabel,
      milestone: (await issue.projectMilestone)?.name,
      labels: await mapLabels(issue),
    }
  }

  async listProjects(): Promise<Project[]> {
    const projects = await this.client.projects({ first: 100 })
    const nodes = projects.nodes || projects
    return nodes.map((p) => ({ id: p.id, name: p.name }))
  }

  async resolveAgentChoice(identifier: string): Promise<AgentChoice> {
    const issue = await this.client.issue(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    const labels = await issue.labels({ first: 50 })
    const nodes = labels.nodes || labels
    for (const label of nodes) {
      const parent = await label.parent
      if (parent?.name === AGENT_LABEL_GROUP && AGENT_LABEL_MAP[label.name]) {
        return AGENT_LABEL_MAP[label.name]
      }
    }
    return DEFAULT_AGENT
  }

  async createIssue({ title, description, projectId }: CreateIssueInput): Promise<Issue> {
    let teamId: string | undefined
    if (projectId) {
      const project = await this.client.project(projectId)
      const teams = await project.teams({ first: 1 })
      const team = (teams.nodes || teams)[0]
      if (!team) throw new Error(`Linear project ${projectId} has no team`)
      teamId = team.id
    } else {
      const teams = await this.client.teams({ first: 1 })
      const team = (teams.nodes || teams)[0]
      if (!team) throw new Error('No Linear team found')
      teamId = team.id
    }
    const created = await this.client.createIssue({
      teamId,
      projectId,
      title,
      description: description || '',
    })
    const issue = await created.issue
    if (!issue) throw new Error('Linear did not return the created issue')
    return this.getIssue(issue.identifier)
  }

  async updateIssue(identifier: string, { title, description }: UpdateIssueInput): Promise<Issue> {
    const issue = await this.client.issue(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    await this.client.updateIssue(issue.id, {
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
    })
    return this.getIssue(identifier)
  }

  async setStatus(identifier: string, statusName: string): Promise<Issue> {
    const issue = await this.client.issue(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    const team = await issue.team
    if (!team) throw new Error(`Linear issue ${identifier} has no team`)
    const states = await team.states()
    const nodes = states.nodes || states
    const target = nodes.find((s) => s.name.toLowerCase() === statusName.toLowerCase())
    if (!target) throw new Error(`Unknown Linear status: ${statusName}`)
    await this.client.updateIssue(issue.id, { stateId: target.id })
    return this.getIssue(identifier)
  }

  async addComment(identifier: string, body: string): Promise<boolean> {
    const issue = await this.client.issue(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    await this.client.createComment({ issueId: issue.id, body })
    return true
  }

  async attachPr(identifier: string, prUrl: string): Promise<boolean> {
    const issue = await this.client.issue(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    const comments = await issue.comments({ first: 100 })
    const nodes = comments.nodes || comments
    const existing = nodes.some((c) => (c.body || '').includes(`${PR_MARKER}${prUrl}`))
    if (existing) return false
    const body = `In Review — PR opened: ${prUrl}\n${PR_MARKER}${prUrl}`
    await this.client.createComment({ issueId: issue.id, body })
    await this.setStatus(identifier, 'In Review')
    return true
  }
}

const MOCK_PROJECTS: Project[] = [
  { id: 'mock-project-1', name: 'Demo Project' },
  { id: 'mock-project-2', name: 'Other Project' },
]

export class MockLinearStore implements LinearStoreLike {
  seq = 5
  issues: Map<string, Issue & { comments?: string[] }>

  constructor() {
    this.issues = new Map(
      (
        [
          { id: 'LIN-1', title: 'Add a dark-mode toggle to the dashboard', description: 'Users want a dark theme. Add a toggle in the top bar that persists in localStorage.', status: 'Backlog', url: 'http://localhost:4390/api/linear/issue/LIN-1', branchName: 'LIN-1', project: MOCK_PROJECTS[0].id, priority: 2, priorityLabel: 'High', milestone: 'v1.0', labels: [{ name: 'frontend', color: '#4f8cff' }] },
          { id: 'LIN-2', title: 'Expose a GET /api/stats endpoint', description: 'Backend endpoint returning issue counts per status. Return JSON with a `byStatus` map.', status: 'Todo', url: 'http://localhost:4390/api/linear/issue/LIN-2', branchName: 'LIN-2', project: MOCK_PROJECTS[0].id, priority: 3, priorityLabel: 'Medium', labels: [{ name: 'backend', color: '#3fb97f' }] },
          { id: 'LIN-3', title: 'Validate email format on the signup form', description: 'Frontend: block invalid emails client-side and show an inline error message.', status: 'Backlog', url: 'http://localhost:4390/api/linear/issue/LIN-3', branchName: 'LIN-3', project: MOCK_PROJECTS[1].id, priority: 1, priorityLabel: 'Urgent', milestone: 'v1.0', labels: [{ name: 'bug', color: '#e5534b' }] },
          { id: 'LIN-4', title: 'Add request logging middleware', description: 'Backend: log method, path, status and duration for every request.', status: 'In Progress', url: 'http://localhost:4390/api/linear/issue/LIN-4', branchName: 'LIN-4', project: MOCK_PROJECTS[1].id, priority: 0, priorityLabel: 'No priority', labels: [] },
        ] satisfies Issue[]
      ).map((i) => [i.id, i]),
    )
  }

  async listProjects(): Promise<Project[]> {
    return MOCK_PROJECTS.map((p) => ({ ...p }))
  }

  async resolveAgentChoice(): Promise<AgentChoice> {
    return DEFAULT_AGENT
  }

  async listIssues(): Promise<Issue[]> {
    return [...this.issues.values()].map((i) => ({ ...i }))
  }

  async getIssue(identifier: string): Promise<Issue> {
    const issue = this.issues.get(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    return { ...issue }
  }

  async createIssue({ title, description, projectId }: CreateIssueInput): Promise<Issue> {
    const id = `LIN-${this.seq++}`
    const issue: Issue = {
      id,
      title,
      description: description || '',
      status: 'Backlog',
      url: `http://localhost:4390/api/linear/issue/${id}`,
      branchName: id,
      project: projectId,
      priority: 0,
      priorityLabel: 'No priority',
      labels: [],
    }
    this.issues.set(id, issue)
    return { ...issue }
  }

  async updateIssue(identifier: string, { title, description }: UpdateIssueInput): Promise<Issue> {
    const issue = this.issues.get(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    if (title !== undefined) issue.title = title
    if (description !== undefined) issue.description = description
    return { ...issue }
  }

  async setStatus(identifier: string, statusName: string): Promise<Issue> {
    const issue = this.issues.get(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    issue.status = statusName
    return { ...issue }
  }

  async addComment(identifier: string, body: string): Promise<boolean> {
    const issue = this.issues.get(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    issue.comments = [...(issue.comments || []), body]
    return true
  }

  async attachPr(identifier: string, prUrl: string): Promise<boolean> {
    const issue = this.issues.get(identifier)
    if (!issue) throw new Error(`Linear issue ${identifier} not found`)
    if ((issue.comments || []).some((c) => c.includes(`${PR_MARKER}${prUrl}`))) return false
    await this.addComment(identifier, `In Review — PR opened: ${prUrl}\n${PR_MARKER}${prUrl}`)
    issue.status = 'In Review'
    return true
  }
}

export function getLinearStore(): LinearStoreLike {
  if (process.env.LINEAR_API_KEY) {
    console.log('[linear] using real Linear SDK store')
    return new LinearStore()
  }
  console.log('[linear] LINEAR_API_KEY not set — using in-memory mock store')
  return new MockLinearStore()
}
