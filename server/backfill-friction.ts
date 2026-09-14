// One-shot, re-runnable: mines run-logs/*.ndjson into friction-log.jsonl so the
// Friction panel has history from before live capture was widened.
//
//   node backfill-friction.ts
//
// Reads raw backend stream lines, not pilot's AgentEvent payloads, so it can't
// reuse classifyFriction directly — but it shares toolFailureKind so a refusal
// is classified identically whether it was captured live or mined here.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FRICTION_FILE, MAX_DETAIL, dropLiveOverlap, loadFriction, repeatTracker, toolFailureKind, type FrictionEntry, type FrictionKind } from './friction-store.ts'
import { loadStepAttempts } from './step-metrics-store.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUN_LOGS = join(ROOT, 'run-logs')
const CHAT_SESSIONS = join(ROOT, 'chat-sessions.json')

// pilot's own prompts embed "identifier: LAE-180"; anchoring on that avoids
// picking up sibling issues merely mentioned in a description.
const IDENTIFIER = /identifier:\s*([A-Z][A-Z0-9]*-\d+)/

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('')
  return content == null ? '' : JSON.stringify(content)
}

function iso(ts: unknown): string | undefined {
  if (typeof ts === 'number') return new Date(ts).toISOString()
  if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) return new Date(ts).toISOString()
  return undefined
}

function sessionToIssue(): Map<string, string> {
  const map = new Map<string, string>()
  if (!existsSync(CHAT_SESSIONS)) return map
  const sessions = JSON.parse(readFileSync(CHAT_SESSIONS, 'utf8')) as Record<string, { sessionId?: string }>
  for (const [key, value] of Object.entries(sessions)) {
    const issue = key.replace(/^implement:/, '')
    if (value?.sessionId && /^[A-Z][A-Z0-9]*-\d+$/.test(issue)) map.set(value.sessionId, issue)
  }
  return map
}

function mineFile(file: string, bySession: Map<string, string>): FrictionEntry[] {
  const name = file.replace(/\.ndjson$/, '')
  const parts = name.split('-')
  const backend = parts[0]
  const fileEpoch = Number(parts[parts.length - 1])
  const fallbackTs = Number.isFinite(fileEpoch) && fileEpoch > 1e12
    ? new Date(fileEpoch).toISOString()
    : statSync(join(RUN_LOGS, file)).mtime.toISOString()

  const raw = readFileSync(join(RUN_LOGS, file), 'utf8')
  const issueId =
    raw.match(IDENTIFIER)?.[1] ??
    [...bySession.entries()].find(([sessionId]) => file.includes(sessionId))?.[1]

  const found: FrictionEntry[] = []
  // Claude reports a denial twice: as an is_error tool_result, and again in the
  // final result's permission_denials. Keyed by tool_use_id so each counts once.
  const byToolUse = new Map<string, FrictionEntry>()
  const toolNames = new Map<string, string>()
  let lastTs = fallbackTs

  const entry = (kind: FrictionEntry['kind'], detail: string): FrictionEntry => ({
    kind,
    timestamp: lastTs,
    issueId,
    backend,
    source: 'backfill',
    detail: detail.trim().slice(0, MAX_DETAIL),
  })

  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue
    let d: any
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    lastTs = iso(d.timestamp) ?? lastTs

    // --- Claude stream-json ---
    if (d.type === 'assistant') {
      for (const p of d.message?.content ?? []) {
        if (p?.type === 'tool_use' && p.id) toolNames.set(p.id, p.name)
      }
    } else if (d.type === 'user') {
      for (const p of d.message?.content ?? []) {
        if (p?.type === 'tool_result' && p.is_error && p.tool_use_id) {
          const err = text(p.content)
          byToolUse.set(p.tool_use_id, entry(toolFailureKind(err), `${toolNames.get(p.tool_use_id) ?? 'tool'}: ${err}`))
        }
      }
    } else if (d.type === 'system' && d.subtype === 'post_turn_summary') {
      if (d.needs_action || d.status_category === 'blocked') {
        found.push(entry('agent_blocked', d.needs_action || d.status_detail || ''))
      }
    } else if (d.type === 'result') {
      for (const denial of d.permission_denials ?? []) {
        const existing = denial?.tool_use_id ? byToolUse.get(denial.tool_use_id) : undefined
        if (existing) {
          existing.kind = 'tool_denied' // the result event confirms it was a refusal
        } else {
          const input = denial?.tool_input?.command ?? denial?.tool_input?.file_path ?? JSON.stringify(denial?.tool_input ?? {})
          const e = entry('tool_denied', `${denial?.tool_name ?? 'tool'}: permission denied — ${input}`)
          if (denial?.tool_use_id) byToolUse.set(denial.tool_use_id, e)
          else found.push(e)
        }
      }
    }

    // --- OpenCode / Kilo Code ---
    else if (d.type === 'tool_use' && d.part?.state?.status === 'error') {
      const err = text(d.part.state.error)
      const e = entry(toolFailureKind(err), `${d.part.tool ?? 'tool'}: ${err}`)
      if (d.part.callID) byToolUse.set(`${backend}:${d.part.callID}`, e)
      else found.push(e)
    }
  }

  return [...found, ...byToolUse.values()]
}

// Step-loop failures only ever existed as step-metrics rows until the live
// classifier learned pilot's own error broadcasts. Only rows older than the
// first live row of these kinds, so the two sources never double-count.
const STEP_FAILURE_KIND: Partial<Record<string, FrictionKind>> = { check_infra: 'check_infra', exhausted: 'step_exhausted', builder_failed: 'builder_failed' }

function mineStepMetrics(live: FrictionEntry[]): FrictionEntry[] {
  const liveSince = live.filter((e) => ['check_infra', 'step_exhausted', 'builder_failed', 'wrapup_failed'].includes(e.kind)).map((e) => e.timestamp).sort()[0]
  const rows = loadStepAttempts().filter((r) => (!liveSince || r.timestamp < liveSince) && r.builderFailure !== 'stopped')
  const entries = rows.flatMap((r): FrictionEntry[] => {
    const kind = r.phase === 'wrap_up' && r.outcome === 'builder_failed' ? 'wrapup_failed' : STEP_FAILURE_KIND[r.outcome]
    if (!kind) return []
    const detail = kind === 'check_infra' ? `Could not verify step "${r.stepTitle}": ${r.verdictDetail}` : r.builderDetail ?? r.verdictDetail ?? r.outcome
    return [{ kind, timestamp: r.timestamp, issueId: r.issueId, backend: r.backend, source: 'backfill', detail: detail.slice(0, MAX_DETAIL) }]
  })
  const track = repeatTracker([])
  return entries.flatMap((e) => {
    const repeated = track(e)
    return repeated ? [e, { ...repeated, source: 'backfill' as const }] : [e]
  })
}

const bySession = sessionToIssue()
const files = readdirSync(RUN_LOGS).filter((f) => f.endsWith('.ndjson'))
const liveRows = loadFriction().filter((e) => e.source !== 'backfill')
const mined = dropLiveOverlap([...files.flatMap((f) => mineFile(f, bySession)), ...mineStepMetrics(liveRows)], liveRows)

// Parse everything first, then read-and-rewrite back to back: the live server
// appends to this same file, so keep the window between the two tiny.
// ponytail: not locked — run it while no agent is mid-run; a lock is overkill
// for a manual one-shot.
const live = loadFriction().filter((e) => e.source !== 'backfill')
const all = [...live, ...mined].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
writeFileSync(FRICTION_FILE, all.map((e) => JSON.stringify(e)).join('\n') + (all.length ? '\n' : ''))

const tally = (key: (e: FrictionEntry) => string) =>
  Object.entries(mined.reduce<Record<string, number>>((acc, e) => ((acc[key(e)] = (acc[key(e)] ?? 0) + 1), acc), {}))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join('  ')

console.log(`scanned ${files.length} logs → ${mined.length} backfilled entries (kept ${live.length} live entries)`)
console.log(`  by kind:    ${tally((e) => e.kind)}`)
console.log(`  by backend: ${tally((e) => e.backend ?? '?')}`)
console.log(`  attributed to an issue: ${mined.filter((e) => e.issueId).length}/${mined.length}`)
