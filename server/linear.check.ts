// Runnable check for Linear retries, the OpenCode/Kilo runner permissions and
// backfill de-duplication: `node server/linear.check.ts`.
import { homedir } from 'node:os'
import { isTransientLinearError, mapRawIssue, withLinearRetry } from './linear.ts'
import { buildRunnerConfigContent } from './agent.ts'
import { dropLiveOverlap, type FrictionEntry } from './friction-store.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// 5. Which Linear errors are worth retrying.
expect('503 transient', isTransientLinearError(new Error('GraphQL Error (Code: 503) - upstream connect error or disconnect/reset before headers')), true)
expect('fetch failed transient', isTransientLinearError(new Error('UnknownLinearError: Fetch failed')), true)
expect('rate limit not transient', isTransientLinearError(new Error('Rate limit exceeded. Only 2500 requests are allowed per 1 hour.')), false)
expect('not found not transient', isTransientLinearError(new Error('Linear issue LAE-999 not found')), false)

// 6. Retry behaviour (no real waiting).
let calls = 0
const flaky = await withLinearRetry(async () => {
  calls++
  if (calls < 3) throw new Error('GraphQL Error (Code: 503) - upstream connect error')
  return 'ok'
}, [0, 0])
expect('succeeds after two 503s', [flaky, calls], ['ok', 3])
let notFoundCalls = 0
const notFound = await withLinearRetry(async () => {
  notFoundCalls++
  throw new Error('Linear issue LAE-999 not found')
}, [0, 0]).catch((err: Error) => err.message)
expect('not found fails fast', [notFound, notFoundCalls], ['Linear issue LAE-999 not found', 1])

// 7. OpenCode/Kilo may read what Claude sessions already can, but not edit it.
const projectsRoot = `${homedir()}/Workspace/perso`
const config = JSON.parse(await buildRunnerConfigContent(`${projectsRoot}/ldaahbevy`))
const external = config.permission.external_directory
const edit = config.permission.edit
expect('cargo registry readable', external[`${homedir()}/.cargo/registry/*`], 'allow')
expect('sibling projects readable', external[`${projectsRoot}/*`], 'allow')
expect('tmp readable', external['/tmp/*'], 'allow')
expect('sibling projects not editable', edit[`*${projectsRoot}/*`], 'deny')
// The edit rule sees the path relative to the project ("../gguy/…"), so an absolute pattern alone never matches a sibling — confirmed live, the sibling edit went through.
expect('anything outside the project not editable (relative form)', edit['../*'], 'deny')
expect('cargo registry not editable', edit[`*${homedir()}/.cargo/registry/*`], 'deny')
expect('own project still editable (listed after the sibling deny)', Object.keys(edit).indexOf(`*${projectsRoot}/ldaahbevy/*`) > Object.keys(edit).indexOf(`*${projectsRoot}/*`), true)
expect('own project edit allow', edit[`*${projectsRoot}/ldaahbevy/*`], 'allow')

// 8. Backfill keeps only tool events older than live capture.
const row = (timestamp: string, source?: 'backfill'): FrictionEntry => ({ kind: 'tool_denied', timestamp, detail: 'x', ...(source ? { source } : {}) })
const kept: FrictionEntry[] = dropLiveOverlap([row('2026-09-12T00:00:00Z', 'backfill'), row('2026-09-14T00:00:00Z', 'backfill'), { ...row('2026-09-14T00:00:00Z', 'backfill'), kind: 'check_infra' }], [row('2026-09-13T10:57:29Z')])
expect('drops tool events after live capture began', kept.map((e) => `${e.kind}@${e.timestamp.slice(0, 10)}`), ['tool_denied@2026-09-12', 'check_infra@2026-09-14'])

// 9. The batched board query maps to the same Issue shape as the per-issue SDK path.
const raw = {
  identifier: 'LAE-7', title: 'T', description: null, url: 'u', branchName: 'b', priority: 2, priorityLabel: 'High',
  createdAt: '2026-09-01T10:00:00.000Z', startedAt: '2026-09-02T10:00:00.000Z', completedAt: null, canceledAt: null, updatedAt: '2026-09-03T10:00:00.000Z',
  state: { name: 'In Progress' }, project: { id: 'p1' }, projectMilestone: { name: 'v1' }, parent: { id: 'x' },
  labels: { nodes: [{ name: 'ui', color: '#fff' }, { name: 'Claude', color: '#000' }] }, children: { nodes: [] },
}
expect('raw issue mapping', mapRawIssue(raw), {
  id: 'LAE-7', title: 'T', description: '', status: 'In Progress', url: 'u', branchName: 'b', updatedAt: new Date('2026-09-03T10:00:00.000Z'),
  createdAt: '2026-09-01T10:00:00.000Z', startedAt: '2026-09-02T10:00:00.000Z', project: 'p1', priority: 2, priorityLabel: 'High',
  milestone: 'v1', labels: [{ name: 'ui', color: '#fff' }], isSubIssue: true, hasSubIssues: false,
})
const bare = mapRawIssue({ ...raw, state: null, project: null, projectMilestone: null, parent: null, children: { nodes: [{ id: 'c' }] } })
expect('raw issue defaults', [bare.status, bare.project, bare.milestone, bare.isSubIssue, bare.hasSubIssues], ['Backlog', undefined, undefined, false, true])

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
