import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_FILE = resolve(__dirname, '..', 'step-metrics.jsonl')
const MAX_DETAIL = 300

// One row per Builder attempt on a plan step (plus the wrap-up attempt that
// opens the PR), written by runCard — the only record of how each attempt
// went, since plans.json keeps just a step's latest attempts/lastFailure.
export type StepOutcome = 'passed' | 'retrying' | 'exhausted' | 'check_infra' | 'builder_failed'
export type BuilderFailure = 'rate_limited' | 'no_changes' | 'no_output' | 'stopped' | 'error'

export interface StepAttempt {
  timestamp: string
  issueId: string
  planId: string
  phase: 'step' | 'wrap_up'
  stepId?: string
  stepTitle?: string
  stepIndex?: number
  stepCount: number
  // 1-based; for builder_failed/check_infra it's the attempt that would have
  // been burned — neither actually counts against MAX_STEP_ATTEMPTS.
  attempt?: number
  backend?: string
  model?: string
  builderMs: number
  checkMs?: number
  checker?: 'command' | 'visual' | 'verifier'
  verdict?: 'pass' | 'fail' | 'infra'
  verdictDetail?: string
  outcome: StepOutcome
  builderFailure?: BuilderFailure
  builderDetail?: string
}

export function appendStepAttempt(entry: StepAttempt): void {
  const trim = (s?: string) => (s && s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s)
  appendFileSync(STORE_FILE, JSON.stringify({ ...entry, verdictDetail: trim(entry.verdictDetail), builderDetail: trim(entry.builderDetail) }) + '\n')
}

export function loadStepAttempts(): StepAttempt[] {
  if (!existsSync(STORE_FILE)) return []
  return readFileSync(STORE_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

// Keyed to the exact errors runTask/startRun raise (server/index.ts) — a
// reworded message there falls through to 'error' rather than misfiling.
export function builderFailureReason(message: string): BuilderFailure {
  if (/Rate limit exceeded/i.test(message)) return 'rate_limited'
  if (/without making any file changes/.test(message)) return 'no_changes'
  if (/never finished/.test(message)) return 'no_output'
  if (/stopped before it completed/.test(message)) return 'stopped'
  return 'error'
}

// Claude reports its model on the run log's system/init line; OpenCode/Kilo
// don't log one, so theirs is the model pilot passed (spawnOpencode/spawnKilocode).
export function modelFromRunLog(backend: string | undefined, logFile: string | undefined): string | undefined {
  if (backend === 'opencode') return process.env.OPENCODE_MODEL || 'opencode/big-pickle'
  if (backend === 'kilocode') return process.env.KILOCODE_MODEL || 'kilo/kilo-auto/free'
  if (backend !== 'claude' || !logFile || !existsSync(logFile)) return undefined
  // The init line comes within the first few events; don't read a whole multi-MB log for it.
  const fd = openSync(logFile, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
    const line = head.split('\n').find((l) => l.includes('"subtype":"init"'))
    return line ? JSON.parse(line).model : undefined
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}
