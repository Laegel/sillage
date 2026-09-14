import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Reads the gate timings each project writes for itself — see the projects'
// gate-timing.sh (ldaahbevy scripts/, songe tools/verify/). Sillage only reads:
// a project opts in by writing .gates/runs.jsonl, one JSON line per gate run,
// with its JUnit reports under .gates/junit/<runId>/.

export interface GateStep {
  name: string
  durationMs: number
  exitCode: number
}

export interface GateTest {
  suite: string
  name: string
  durationMs: number
  status: 'passed' | 'failed' | 'skipped'
}

export interface GateRun {
  runId: string
  gate: string
  startedAt: string
  durationMs: number
  exitCode: number
  commit: string
  branch: string
  trigger: string
  steps: GateStep[]
  junit: string[]
  tests: GateTest[]
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) =>
    entity[0] === '#'
      ? String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10))
      : ENTITIES[entity.toLowerCase()],
  )
}

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
  return match ? decode(match[1]) : undefined
}

// ponytail: regex over runner-generated JUnit (nextest, vitest, jest-junit), not a
// general XML parser — CDATA or attributes in single quotes would need a real one.
export function parseJUnit(xml: string): GateTest[] {
  const tests: GateTest[] = []
  const suites = xml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)
  for (const [, suiteAttrs, body] of suites) {
    const suiteName = attribute(suiteAttrs, 'name') ?? ''
    // Either <testcase …/> (no children) or <testcase …>…</testcase>.
    for (const [, selfClosingAttrs, pairedAttrs, children = ''] of body.matchAll(/<testcase\b([^>]*?)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g)) {
      const attrs = selfClosingAttrs ?? pairedAttrs
      tests.push({
        suite: suiteName,
        name: attribute(attrs, 'name') ?? '',
        durationMs: Math.round(Number(attribute(attrs, 'time') ?? 0) * 1e6) / 1e3,
        status: /<(failure|error)\b/.test(children) ? 'failed' : /<skipped\b/.test(children) ? 'skipped' : 'passed',
      })
    }
  }
  return tests
}

export function loadGateRuns(projectDir: string): GateRun[] {
  const file = join(projectDir, '.gates', 'runs.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const run = JSON.parse(line) as Omit<GateRun, 'tests'>
        if (typeof run?.runId !== 'string' || !Array.isArray(run.steps)) return []
        const tests = (run.junit ?? []).flatMap((relative) => {
          const report = join(projectDir, '.gates', relative)
          return existsSync(report) ? parseJUnit(readFileSync(report, 'utf8')) : []
        })
        return [{ ...run, tests }]
      } catch {
        return [] // a half-written or hand-edited line shouldn't hide the rest
      }
    })
}
