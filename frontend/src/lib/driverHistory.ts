import type { DriverSession } from '../types.ts'

const STORAGE_KEY = 'sillage.driverHistory.v1'

export function loadDriverSessions(): Record<string, DriverSession> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveDriverSessions(sessions: Record<string, DriverSession>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
}
