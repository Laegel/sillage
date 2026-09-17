// Runnable check for Builder run completion and session scoping: `node server/builder-run.check.ts`.
import { runEndedCleanly } from './agent.ts'
import { implementSessionKey } from './chat-store.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// 1-2. OpenCode/Kilo end a finished run on step_finish reason "stop". LAE-219's
// attempts 2 and 3 ended on an empty "unknown" turn and were verified as if done.
expect('stop is finished', runEndedCleanly('stop'), true)
for (const reason of ['unknown', 'length', 'tool-calls', undefined]) {
  expect(`${reason ?? 'no finish event'} is not finished`, runEndedCleanly(reason), false)
}

// 3-4. Each step gets its own Builder session; LAE-219's s3 attempt 1 resumed
// s2's session and re-verified step 2 instead of starting the slab.
expect('steps get separate sessions', implementSessionKey('LAE-219', 's2') !== implementSessionKey('LAE-219', 's3'), true)
expect('same step resumes', implementSessionKey('LAE-219', 's3'), implementSessionKey('LAE-219', 's3'))
expect('no step keeps the card key', implementSessionKey('LAE-219'), 'implement:LAE-219')

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
