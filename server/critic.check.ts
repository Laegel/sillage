// Runnable check for visual-check regions: `node server/critic.check.ts`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cropTo } from './critic.ts'
import { validateVisualRegion } from './project-map.ts'
import { buildConsolidatePrompt, buildCritiquePrompt, buildDesignPrompt } from './agent.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
const viewport: [number, number] = [1280, 720]

// 1-2. A region is [x, y, width, height] in viewport pixels, inside the frame.
expect('compass box valid', validateVisualRegion([500, 4, 280, 46], viewport), undefined)
expect('past the right edge', typeof validateVisualRegion([1200, 0, 200, 50], viewport), 'string')
expect('zero width', typeof validateVisualRegion([10, 10, 0, 50], viewport), 'string')
expect('not four numbers', typeof validateVisualRegion([10, 10, 50] as unknown, viewport), 'string')
expect('negative origin', typeof validateVisualRegion([-5, 0, 50, 50], viewport), 'string')

// 3. Cropping a real capture yields exactly the region's size.
// A generated 1280x720 frame, not a real capture — critic folders get reused as new rounds run.
const png = join(mkdtempSync(join(tmpdir(), 'crop-check-')), 'a.png')
execFileSync('convert', ['-size', '1280x720', 'xc:gray', png])
await cropTo(png, [500, 4, 280, 46])
expect('cropped size', execFileSync('identify', ['-format', '%w %h', png]).toString(), '280 46')

// 4. Refine is told regions exist.
expect('prompt mentions region', buildConsolidatePrompt('LAE-1', ['scene']).includes('"region"'), true)

// 5-7. Mockups keep context (backdrop, scene, other HUD) as ignorable noise: LAE-183
// spent 9 attempts matching a mockup's night-sky backdrop nobody asked for.
const design = buildDesignPrompt({ projectDir: '/repo', designDir: '/repo/design/LAE-1' })
expect('designer keeps context neutral', design.includes('data-mockup-context') && /key elements/i.test(design) && /placeholder/i.test(design), true)
const critique = buildCritiquePrompt({ intent: 'a compass', critiqueId: 'c1' })
expect('critic never judges context', /context placeholder/i.test(critique) && /never judge/i.test(critique), true)
const consolidate = buildConsolidatePrompt('LAE-1', ['scene'])
expect('refiner makes no steps for context', consolidate.includes('data-mockup-context') && /never .*step/i.test(consolidate), true)

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
