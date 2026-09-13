import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const FRICTION_FILE = resolve(__dirname, '..', 'friction-log.jsonl')

export type FrictionKind =
  | 'run_failed'
  | 'stalled'
  | 'rate_limited'
  | 'backend_fallback'
  | 'tool_denied'
  | 'tool_error'
  | 'agent_blocked'
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
  // Only known for backfilled rows (from the run-log filename) — a live
  // broadcast payload doesn't carry which backend produced the event.
  backend?: string
  // Marks rows written by scripts/backfill-friction.ts, so a re-run can drop
  // its own previous output without touching live-captured rows.
  source?: 'backfill'
  detail: string
}

export function appendFriction(entry: FrictionEntry): void {
  appendFileSync(FRICTION_FILE, JSON.stringify(entry) + '\n')
}

export function loadFriction(): FrictionEntry[] {
  if (!existsSync(FRICTION_FILE)) return []
  return readFileSync(FRICTION_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

// A failed tool call is either the harness itself refusing (pilot's own
// guard-scope/read-only hooks, a disabled tool, a permission prompt that can't
// be answered headlessly, a token without the scope) or the tool genuinely
// failing. Those are different problems with different fixes — mining the real
// run-logs showed most "failures" are the former — so the digest keeps them
// apart. Each backend words its refusals differently: OpenCode/Kilo say
// "specified a rule which prevents you from using this specific tool call",
// which a Claude-only pattern silently filed as 49 genuine tool errors.
const HARNESS_REFUSAL =
  /denied|Blocked:|read-only|outside the project|No such tool available|rule which prevents you from using|not accessible by personal access token/i

// Shared with backfill-friction.ts so live capture and historical mining
// can never disagree on what counts as a refusal.
export function toolFailureKind(errorText: string): 'tool_denied' | 'tool_error' {
  return HARNESS_REFUSAL.test(errorText) ? 'tool_denied' : 'tool_error'
}

export const MAX_DETAIL = 300

// Runs on every broadcast (see index.ts broadcast()), so it sees every agent
// event from every backend. Structured signals only: a status the agent itself
// reported as blocked/needing action, and tool calls that ended in error. Both
// are already parsed into AgentEvents by agent.ts — this just stops dropping
// them. `completed` and `review_ready` are healthy terminal states, not friction.
export function classifyFriction(payload: Record<string, unknown>): FrictionEntry | undefined {
  const event = payload.event as AgentEvent | undefined
  if (!event) return undefined

  const base = {
    timestamp: new Date().toISOString(),
    issueId: typeof payload.issueId === 'string' ? payload.issueId : undefined,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
  }

  if (event.kind === 'status') {
    if (event.category === 'rate_limited' || event.category === 'backend_fallback') {
      return { ...base, kind: event.category, detail: event.detail }
    }
    // needsAction is the agent's own unanswered question — the most useful
    // thing in the whole log, so it wins over the generic status detail.
    if (event.needsAction || event.category === 'blocked') {
      return { ...base, kind: 'agent_blocked', detail: (event.needsAction || event.detail).slice(0, MAX_DETAIL) }
    }
    return undefined
  }

  if (event.kind === 'tool_call' && event.status === 'error') {
    const text = (event.error || '').trim()
    return {
      ...base,
      kind: toolFailureKind(text),
      detail: `${event.tool}: ${text.slice(0, MAX_DETAIL)}`,
    }
  }

  return undefined
}
