// Runnable check for step exhaustion and reset: `node server/plans-store.check.ts`.
import { isStepExhausted, resetStepFields, type Step } from './plans-store.ts'
import { buildStepExhaustedReason } from './agent.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const step: Step = { id: 's2b', title: 'Backdrop', criterion: 'dark sky', check: 'visual', status: 'pending', attempts: 3, lastFailure: 'pink' }

// 1. Exhausted at the cap, not below it.
expect('exhausted at max', isStepExhausted(step, 3), true)
expect('exhausted past max', isStepExhausted({ ...step, attempts: 9 }, 3), true)
expect('not exhausted below max', isStepExhausted({ ...step, attempts: 2 }, 3), false)
expect('a done step is never exhausted', isStepExhausted({ ...step, status: 'done' }, 3), false)

// 2. Reset clears attempts and last failure only.
const reset = resetStepFields(step)
expect('reset attempts and failure', [reset.attempts, reset.lastFailure], [0, undefined])
expect('reset keeps the rest', [reset.id, reset.title, reset.criterion, reset.check, reset.status], ['s2b', 'Backdrop', 'dark sky', 'visual', 'pending'])

// 3-4. The Driver is told to stop, not retry.
const reason = buildStepExhaustedReason({ message: 'Step "Backdrop" failed verification after 9 attempts', steps: { failedStep: 'Backdrop', lastFailure: 'pink' } })
expect('forbids re-implementing', /do not propose implementing/i.test(reason), true)
expect('asks to release', /release/i.test(reason), true)
expect('names the step and failure', reason.includes('Backdrop') && reason.includes('pink'), true)

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
