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
  // Pilot's own step-loop failures, tagged by the broadcast's `failure` field.
  | 'builder_failed'
  | 'check_infra'
  | 'step_exhausted'
  | 'wrapup_failed'
  // The same failure (kind + detail) hitting one issue again in a row.
  | 'repeated_failure'

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

const FAILURE_TAGS = new Set<FrictionKind>(['builder_failed', 'check_infra', 'step_exhausted', 'wrapup_failed'])

// Runs on every broadcast (see index.ts broadcast()). Two sources, both
// structured: pilot's own orchestration signals (a failed run or step check,
// a stall, a failed Driver action, an ownership escalation) — which carry no
// agent `event` and were once silently dropped here — and the agent events
// agent.ts already parses (a status the agent reported as blocked, tool calls
// that ended in error). `completed` and `review_ready` are healthy terminal
// states, not friction.
export function classifyFriction(payload: Record<string, unknown>): FrictionEntry | undefined {
  const base = {
    timestamp: new Date().toISOString(),
    issueId: typeof payload.issueId === 'string' ? payload.issueId : undefined,
    sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
  }
  const message = typeof payload.message === 'string' ? payload.message.slice(0, MAX_DETAIL) : ''

  if (payload.type === 'error') {
    // A run someone deliberately stopped isn't an agent or pilot getting stuck.
    if (payload.failure === 'stopped') return undefined
    const tag = payload.failure as FrictionKind
    return { ...base, kind: FAILURE_TAGS.has(tag) ? tag : 'run_failed', detail: message }
  }
  if (payload.type === 'stall_detected') {
    const seconds = Math.round(Number(payload.thresholdMs) / 1000)
    return { ...base, kind: 'stalled', detail: `no activity for ${seconds}s` }
  }
  if (payload.type === 'driver_action') {
    if (payload.escalated) return { ...base, kind: 'ownership_exhausted', detail: message }
    if (payload.status === 'failed') return { ...base, kind: 'driver_action_failed', detail: `${payload.action}: ${message}` }
    return undefined
  }

  const event = payload.event as AgentEvent | undefined
  if (!event) return undefined

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

// Same issue, same failure kind and detail as its previous failure → a
// repeated_failure row with the running count: a loop retrying something that
// can't succeed (e.g. the Driver re-sending one fix three times) is invisible
// as three unrelated rows. Seeded from the existing log so a restart doesn't
// forget the streak.
const REPEATABLE = new Set<FrictionKind>([...FAILURE_TAGS, 'run_failed', 'stalled', 'driver_action_failed'])

export function repeatTracker(history: FrictionEntry[]): (entry: FrictionEntry) => FrictionEntry | undefined {
  const last = new Map<string, { signature: string; count: number }>()
  const track = (entry: FrictionEntry): FrictionEntry | undefined => {
    if (!entry.issueId || !REPEATABLE.has(entry.kind)) return undefined
    const signature = `${entry.kind}\n${entry.detail}`
    const previous = last.get(entry.issueId)
    const count = previous?.signature === signature ? previous.count + 1 : 1
    last.set(entry.issueId, { signature, count })
    if (count < 2) return undefined
    return { kind: 'repeated_failure', timestamp: entry.timestamp, issueId: entry.issueId, detail: `${entry.kind} ×${count}: ${entry.detail}`.slice(0, MAX_DETAIL) }
  }
  for (const entry of history) track(entry)
  return track
}

// Run-log mining re-finds tool events that live capture already recorded once it
// started (2026-09-13) — 25 events were in the log twice. Keep backfilled tool
// events only from before the first live one; other kinds come from sources
// live capture never saw.
const TOOL_KINDS = new Set<FrictionKind>(['tool_denied', 'tool_error', 'agent_blocked'])

export function dropLiveOverlap(mined: FrictionEntry[], live: FrictionEntry[]): FrictionEntry[] {
  const liveSince = live.filter((e) => TOOL_KINDS.has(e.kind)).map((e) => e.timestamp).sort()[0]
  if (!liveSince) return mined
  return mined.filter((e) => !TOOL_KINDS.has(e.kind) || e.timestamp < liveSince)
}
