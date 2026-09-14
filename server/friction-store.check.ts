// Runnable check for friction classification, repeat detection and capture-param
// validation: `node server/friction-store.check.ts`.
import { classifyFriction, repeatTracker, type FrictionEntry } from './friction-store.ts'
import { validateCaptureParams, type CaptureConfig } from './project-map.ts'
import { buildConsolidatePrompt } from './agent.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
const kind = (payload: Record<string, unknown>) => classifyFriction(payload)?.kind

// 1-2. Pilot's own failures.
expect('tagged check_infra', kind({ type: 'error', issueId: 'LAE-1', message: 'Could not verify step', failure: 'check_infra' }), 'check_infra')
expect('untagged issue error', kind({ type: 'error', issueId: 'LAE-1', message: 'boom' }), 'run_failed')
expect('session error', kind({ type: 'error', sessionId: 'driver:x', message: 'boom' }), 'run_failed')
expect('a user stop is not friction', kind({ type: 'error', issueId: 'LAE-1', message: 'run was stopped before it completed', failure: 'stopped' }), undefined)
expect('unknown tag falls back', kind({ type: 'error', issueId: 'LAE-1', message: 'boom', failure: 'nonsense' }), 'run_failed')
expect('error detail is the message', classifyFriction({ type: 'error', issueId: 'LAE-1', message: 'boom', failure: 'step_exhausted' })?.detail, 'boom')

// 3. Previously declared-but-never-written kinds.
expect('stall', kind({ type: 'stall_detected', issueId: 'LAE-1', thresholdMs: 300000 }), 'stalled')
expect('driver action failed', kind({ type: 'driver_action', sessionId: 'driver:x', action: 'implement', issueId: 'LAE-1', status: 'failed', message: 'x' }), 'driver_action_failed')
expect('driver action skipped', kind({ type: 'driver_action', sessionId: 'driver:x', action: 'implement', issueId: 'LAE-1', status: 'skipped', message: 'x' }), undefined)
expect('ownership escalation', kind({ type: 'driver_action', sessionId: 'driver:x', action: 'flag', issueId: 'LAE-1', status: 'done', escalated: true, message: 'x' }), 'ownership_exhausted')

// 4. Agent events unchanged.
expect('tool denied', kind({ type: 'output', issueId: 'LAE-1', event: { kind: 'tool_call', id: '1', tool: 'bash', label: 'bash', status: 'error', error: 'Blocked: read-only' } }), 'tool_denied')
expect('agent blocked', kind({ type: 'output', issueId: 'LAE-1', event: { kind: 'status', category: 'blocked', detail: 'need input' } }), 'agent_blocked')
expect('plain output', kind({ type: 'output', issueId: 'LAE-1', event: { kind: 'text', text: 'hi' } }), undefined)

// 5-6. Same failure repeating on one issue.
const entry = (issueId: string, detail: string): FrictionEntry => ({ kind: 'check_infra', timestamp: 't', issueId, detail })
const tracker = repeatTracker([])
expect('first failure', tracker(entry('LAE-1', 'missing scene')), undefined)
expect('second identical', tracker(entry('LAE-1', 'missing scene'))?.detail, 'check_infra ×2: missing scene')
expect('third identical', tracker(entry('LAE-1', 'missing scene'))?.detail, 'check_infra ×3: missing scene')
expect('other issue independent', tracker(entry('LAE-2', 'missing scene')), undefined)
expect('different detail resets', tracker(entry('LAE-1', 'critic returned no verdict')), undefined)
const reseeded = repeatTracker([entry('LAE-9', 'same'), { kind: 'tool_denied', timestamp: 't', issueId: 'LAE-9', detail: 'unrelated' }])
expect('seeded from log across restart', reseeded(entry('LAE-9', 'same'))?.kind, 'repeated_failure')

// 7. Capture params against ldaahbevy's real command shape.
const cfg: CaptureConfig = { command: ['xvfb-run', 'run', '--', '--debug-scene={scene}', '--screenshot={out}'], viewport: [1280, 720] }
expect('scene ok', validateCaptureParams(cfg, { scene: 'ui-preview' }), { missing: [], unknown: [] })
expect('run instead of scene', validateCaptureParams(cfg, { run: 'scripts/cargo-capped.sh run' }), { missing: ['scene'], unknown: ['run'] })
expect('empty params', validateCaptureParams(cfg, {}), { missing: ['scene'], unknown: [] })

// 8. The consolidation prompt names the real keys.
expect('prompt names scene', buildConsolidatePrompt('LAE-1', ['scene']).includes('"scene"'), true)
// null = the project has no capture command at all ([] would be a command taking no params).
expect('prompt without capture config', /no visual check/i.test(buildConsolidatePrompt('LAE-1', null)), true)

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
