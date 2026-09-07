import type { DesignSession } from '../types.ts'
import { saveHistoryStore } from './historyStore.ts'

const STORAGE_KEY = 'sillage.designHistory.v1'

export function loadDesignSessions(): Record<string, DesignSession> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveDesignSessions(sessions: Record<string, DesignSession>): void {
  saveHistoryStore(STORAGE_KEY, sessions)
}
