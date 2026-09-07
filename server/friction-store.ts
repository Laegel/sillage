import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_FILE = resolve(__dirname, '..', 'friction-log.jsonl')

export type FrictionKind =
  | 'run_failed'
  | 'stalled'
  | 'rate_limited'
  | 'backend_fallback'
  | 'tool_denied'
  | 'driver_action_failed'
  | 'ownership_exhausted'
  | 'status_regression'
  | 'run_busy'

export interface FrictionEntry {
  kind: FrictionKind
  timestamp: string
  issueId?: string
  sessionId?: string
  project?: string
  detail: string
}

export function appendFriction(entry: FrictionEntry): void {
  appendFileSync(STORE_FILE, JSON.stringify(entry) + '\n')
}

export function classifyFriction(payload: Record<string, unknown>): FrictionEntry | undefined {
  const event = payload.event as AgentEvent | undefined
  if (event?.kind !== 'status') return undefined

  const category = event.category
  if (category !== 'rate_limited' && category !== 'backend_fallback') return undefined

  const issueId = typeof payload.issueId === 'string' ? payload.issueId : undefined
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined

  return {
    kind: category as FrictionKind,
    timestamp: new Date().toISOString(),
    issueId,
    sessionId,
    detail: event.detail,
  }
}
