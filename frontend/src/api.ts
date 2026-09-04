import type { Comment, Issue, IssueTransition, Project, SubIssue, SynthesisEntry, UsageEntry, Plan } from './types.ts'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `request failed: ${res.status}`)
  }
  return res.json()
}

export function fetchIssues(): Promise<{ issues: Issue[]; columns: string[] }> {
  return request('/api/linear/issues')
}

export function fetchIssue(issueId: string): Promise<{ issue: Issue }> {
  return request(`/api/linear/issue/${issueId}`)
}

export function fetchProjects(): Promise<{ projects: Project[] }> {
  return request('/api/linear/projects')
}

export function createIssue(payload: { title: string; description?: string; projectId?: string }): Promise<{ issue: Issue }> {
  return request('/api/linear/issues', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function setIssueStatus(issueId: string, status: string): Promise<{ issue: Issue }> {
  return request(`/api/linear/issue/${issueId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  })
}

export function updateIssue(issueId: string, payload: { title?: string; description?: string }): Promise<{ issue: Issue }> {
  return request(`/api/linear/issue/${issueId}/update`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function fetchComments(issueId: string): Promise<{ comments: Comment[] }> {
  return request(`/api/linear/issue/${issueId}/comments`)
}

export function fetchSubIssues(issueId: string): Promise<{ subIssues: SubIssue[] }> {
  return request(`/api/linear/issue/${issueId}/sub-issues`)
}

export function fetchIssueHistory(issueId: string): Promise<{ history: IssueTransition[] }> {
  return request(`/api/linear/issue/${issueId}/history`)
}

export function fetchUsage(): Promise<{ entries: UsageEntry[] }> {
  return request('/api/usage')
}

export function fetchSynthesis(projectId: string): Promise<{ synthesis: SynthesisEntry | null }> {
  return request(`/api/synthesis/${projectId}`)
}

export function generateSynthesis(projectId: string): Promise<{ synthesis: SynthesisEntry }> {
  return request(`/api/synthesis/${projectId}/generate`, { method: 'POST' })
}

export function fetchDesignPreview(sessionId: string, projectId: string, issueId?: string): Promise<{ html: string | null }> {
  const params = new URLSearchParams({ projectId, ...(issueId ? { issueId } : {}) })
  return request(`/api/design/${sessionId}/preview?${params}`)
}

export function fetchPlans(issueId: string): Promise<{ plans: Plan[] }> {
  return request(`/api/plans?issueId=${encodeURIComponent(issueId)}`)
}

export function applyPlan(planId: string): Promise<{ plan: Plan }> {
  return request(`/api/plans/${planId}/apply`, { method: 'POST' })
}
