import type { IdeationSession } from '../types.ts'

const STORAGE_KEY = 'sillage.ideationHistory.v1'

export function loadIdeationSessions(): Record<string, IdeationSession> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveIdeationSessions(sessions: Record<string, IdeationSession>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
}
