import type { Issue, Project } from './types.ts'

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
