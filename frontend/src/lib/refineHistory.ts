import type { ChatMessage } from '../types.ts'

const STORAGE_KEY = 'sillage.refineHistory.v1'

export interface RefineHistoryEntry {
  messages: ChatMessage[]
  draftPlan?: string
}

export function loadRefineHistory(): Record<string, RefineHistoryEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveRefineHistory(store: Record<string, RefineHistoryEntry>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
}

export function toRefineHistoryStore(
  messagesByIssue: Record<string, ChatMessage[]>,
  draftPlansByIssue: Record<string, string>,
): Record<string, RefineHistoryEntry> {
  const store: Record<string, RefineHistoryEntry> = {}
  for (const [issueId, messages] of Object.entries(messagesByIssue)) {
    store[issueId] = { messages, draftPlan: draftPlansByIssue[issueId] }
  }
  return store
}
