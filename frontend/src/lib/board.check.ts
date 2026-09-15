// Runnable check for board card grouping: `node frontend/src/lib/board.check.ts`.
import { childCounts, groupByParent } from './board.ts'
import type { Issue } from '../types.ts'

let failed = 0
function expect(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failed++
    console.log(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}
const card = (id: string, parentId?: string) => ({ id, parentId }) as Issue
const ids = (issues: Issue[]) => issues.map((i) => i.id)

// 1. Linear lists newest first, so children came before their parent, under another card.
expect('children follow their parent', ids(groupByParent([card('LAE-195'), card('LAE-194', 'LAE-189'), card('LAE-193', 'LAE-189'), card('LAE-189')])), ['LAE-195', 'LAE-189', 'LAE-194', 'LAE-193'])
// 2. A parent in another column or filtered out: the child keeps its place.
expect('orphan keeps its place', ids(groupByParent([card('A'), card('B', 'ELSEWHERE'), card('C')])), ['A', 'B', 'C'])
// 3. Nested sub-issues follow their own parent.
expect('grandchild follows its parent', ids(groupByParent([card('G', 'C'), card('C', 'P'), card('P'), card('X')])), ['P', 'C', 'G', 'X'])
// 4. A malformed loop never drops cards.
expect('loop keeps every card', ids(groupByParent([card('A', 'B'), card('B', 'A')])).sort(), ['A', 'B'])
// 5. Sub-issue counts come from the board itself.
expect('child counts', childCounts([card('P'), card('C1', 'P'), card('C2', 'P'), card('Q')]), { P: 2 })

console.log(failed ? `${failed} failing` : 'all passing')
process.exit(failed ? 1 : 0)
