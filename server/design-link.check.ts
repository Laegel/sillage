// Runnable check for design-session folder links: `node server/design-link.check.ts`.
import { designIssueFor, designTurnMessage, planDesignLink } from './design-link.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
const draft = '/repo/design/_drafts/d4e7db02'
const target = '/repo/design/LAE-183'
const existing = (...paths: string[]) => (p: string) => paths.includes(p)

// 1-5. What linking a design session to an issue does with the folders.
expect('same folder', planDesignLink(target, target, existing(target), false), 'link')
expect('draft into an empty slot', planDesignLink(draft, target, existing(draft), false), 'move')
expect('issue already has a mockup', planDesignLink(draft, target, existing(draft, target), false), 'conflict')
expect('confirmed replace', planDesignLink(draft, target, existing(draft, target), true), 'replace')
expect('no draft yet', planDesignLink(draft, target, existing(target), false), 'link')

// 6. The issue the frontend sends wins; the server's memory is only a fallback.
expect('payload issue wins', designIssueFor('LAE-183', undefined), 'LAE-183')
expect('memory fallback', designIssueFor(undefined, 'LAE-9'), 'LAE-9')

// 7. Every turn names the folder the preview reads.
expect('turn names the folder', designTurnMessage('make it grey', target).includes(target), true)

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
