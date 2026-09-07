import type { IdeationSession } from '../types.ts'
import { saveHistoryStore } from './historyStore.ts'

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
  saveHistoryStore(STORAGE_KEY, sessions)
}
