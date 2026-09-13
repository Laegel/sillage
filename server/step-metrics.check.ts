// Runnable check for step-metrics-store.ts's helpers: `node server/step-metrics.check.ts`.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { builderFailureReason, modelFromRunLog } from './step-metrics-store.ts'
import { SILLAGE_ROOT } from './agent.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// Messages as runTask/startRun throw them (server/index.ts).
const agent = 'OpenCode'
expect('rate limit', builderFailureReason(`${agent} hit OpenCode/Kilo Code's "Rate limit exceeded" error and could not finish. Wait for the quota to reset, or switch backend.`), 'rate_limited')
expect('no changes', builderFailureReason(`${agent} finished without making any file changes — it likely got stuck exploring or ran out of budget before implementing anything.`), 'no_changes')
expect('no output', builderFailureReason(`${agent} never finished — it either produced no output at all or went silent partway through.`), 'no_output')
expect('stopped', builderFailureReason('run was stopped before it completed'), 'stopped')
expect('other error', builderFailureReason('spawn claude ENOENT'), 'error')

const logsDir = join(SILLAGE_ROOT, 'run-logs')
const claudeLog = readdirSync(logsDir)
  .filter((f) => f.startsWith('claude-'))
  .map((f) => join(logsDir, f))
  .sort((a, b) => statSync(b).size - statSync(a).size)[0]
if (!claudeLog || !existsSync(claudeLog)) throw new Error('no claude run log to check against')
expect('claude model from init line', modelFromRunLog('claude', claudeLog)?.startsWith('claude-'), true)
expect('opencode default model', modelFromRunLog('opencode', undefined), process.env.OPENCODE_MODEL || 'opencode/big-pickle')
expect('claude with missing log', modelFromRunLog('claude', join(logsDir, 'does-not-exist.ndjson')), undefined)

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
