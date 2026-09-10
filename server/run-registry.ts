import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_FILE = resolve(__dirname, '..', 'active-runs.json')

export type RunKind = 'task' | 'refine' | 'ideation' | 'driver' | 'design' | 'critic'
export type RunBackend = 'claude' | 'opencode' | 'kilocode' | 'mock'

export interface ActiveRunRecord {
  key: string
  kind: RunKind
  pid: number
  logFile: string
  backend: RunBackend
  sessionId?: string
  projectId?: string
}

function loadStore(): ActiveRunRecord[] {
  if (!existsSync(STORE_FILE)) return []
  return JSON.parse(readFileSync(STORE_FILE, 'utf8'))
}

function writeStore(records: ActiveRunRecord[]): void {
  writeFileSync(STORE_FILE, JSON.stringify(records, null, 2))
}

export function loadActiveRuns(): ActiveRunRecord[] {
  return loadStore()
}

export function saveActiveRun(record: ActiveRunRecord): void {
  const records = loadStore().filter((r) => r.key !== record.key)
  records.push(record)
  writeStore(records)
}

export function clearActiveRun(key: string): void {
  writeStore(loadStore().filter((r) => r.key !== key))
}
