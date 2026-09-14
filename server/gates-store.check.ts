// Runnable check for the gate-timing reader: `node server/gates-store.check.ts`.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadGateRuns, parseJUnit } from './gates-store.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// 1. Vitest (shape copied from songe's real shared.xml).
const vitest = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="0" errors="0" time="0.08">
    <testsuite name="__tests__/banners.test.ts" tests="2" failures="0" errors="0" skipped="0" time="0.007">
        <testcase classname="__tests__/banners.test.ts" name="getGaugeLevel &gt; returns level 1 for low gauge" time="0.00234627">
        </testcase>
    </testsuite>
</testsuites>`
expect('vitest testcase', parseJUnit(vitest), [{ suite: '__tests__/banners.test.ts', name: 'getGaugeLevel > returns level 1 for low gauge', durationMs: 2.346, status: 'passed' }])

// 2. nextest: failure and skipped children.
const nextest = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="nextest-run" tests="3" failures="1" errors="0" uuid="x" timestamp="2026-09-14T18:00:00Z" time="4.2">
  <testsuite name="voxel-starter::bin/voxel-starter" tests="3" disabled="1" errors="0" failures="1">
    <testcase name="terrain::edit::tests::places_block" classname="voxel-starter::bin/voxel-starter" timestamp="t" time="1.500">
    </testcase>
    <testcase name="combat::tests::reload" classname="voxel-starter::bin/voxel-starter" timestamp="t" time="0.250">
      <failure type="test failure">thread panicked &amp; stuff</failure>
      <system-out>out</system-out>
    </testcase>
    <testcase name="slow::tests::ignored_one" classname="voxel-starter::bin/voxel-starter" time="0.000">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`
expect('nextest statuses', parseJUnit(nextest).map((t) => [t.name, t.durationMs, t.status]), [
  ['terrain::edit::tests::places_block', 1500, 'passed'],
  ['combat::tests::reload', 250, 'failed'],
  ['slow::tests::ignored_one', 0, 'skipped'],
])

// 3-4. jest-junit, including a self-closing testcase.
const jest = `<testsuites name="jest tests" tests="2" failures="0" time="1.2">
  <testsuite name="Button" tests="2" time="1.2">
    <testcase classname="Button renders" name="Button renders" time="0.011"/>
    <testcase classname="Button clicks" name="Button clicks" time="0.5"></testcase>
  </testsuite>
</testsuites>`
expect('jest self-closing and paired', parseJUnit(jest).map((t) => [t.suite, t.name, t.durationMs, t.status]), [
  ['Button', 'Button renders', 11, 'passed'],
  ['Button', 'Button clicks', 500, 'passed'],
])

// 5. Runs file: garbage line skipped, junit read from the run's folder.
const repo = mkdtempSync(join(tmpdir(), 'gates-check-'))
mkdirSync(join(repo, '.gates', 'junit', 'r1'), { recursive: true })
writeFileSync(join(repo, '.gates', 'junit', 'r1', 'tests.xml'), jest)
const run = { runId: 'r1', gate: 'pre-push', startedAt: '2026-09-14T18:00:00.000Z', durationMs: 5000, exitCode: 0, commit: 'abc', branch: 'main', trigger: 'manual', steps: [{ name: 'tests', durationMs: 4000, exitCode: 0 }], junit: ['junit/r1/tests.xml'] }
writeFileSync(join(repo, '.gates', 'runs.jsonl'), `${JSON.stringify(run)}\n{not json\n${JSON.stringify({ ...run, runId: 'r2', junit: ['junit/r2/missing.xml'] })}\n`)
const runs = loadGateRuns(repo)
expect('valid runs only', runs.map((r) => r.runId), ['r1', 'r2'])
expect('tests attached', runs[0].tests.length, 2)
expect('missing report tolerated', runs[1].tests.length, 0)

// 6. Project that never opted in.
expect('no .gates folder', loadGateRuns(mkdtempSync(join(tmpdir(), 'gates-none-'))), [])

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
