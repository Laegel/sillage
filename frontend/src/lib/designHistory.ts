import type { DesignSession } from '../types.ts'

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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
}
