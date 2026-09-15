import type { Issue } from '../types.ts'

// A column's cards with each sub-issue right after its parent. Linear lists
// newest first, so children used to sit above their parent, under whichever
// card came before them. A child whose parent isn't in the list keeps its place.
export function groupByParent(issues: Issue[]): Issue[] {
  const ids = new Set(issues.map((i) => i.id))
  const hasParentHere = (i: Issue) => Boolean(i.parentId && ids.has(i.parentId))
  const children = new Map<string, Issue[]>()
  for (const i of issues) if (hasParentHere(i)) children.set(i.parentId!, [...(children.get(i.parentId!) ?? []), i])
  const placed = new Set<string>()
  const out: Issue[] = []
  const place = (i: Issue) => {
    if (placed.has(i.id)) return
    placed.add(i.id)
    out.push(i)
    for (const child of children.get(i.id) ?? []) place(child)
  }
  for (const i of issues) if (!hasParentHere(i)) place(i)
  // Only a parent loop leaves cards unplaced; keep them rather than drop them.
  for (const i of issues) place(i)
  return out
}

export function childCounts(issues: Issue[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const i of issues) if (i.parentId) counts[i.parentId] = (counts[i.parentId] ?? 0) + 1
  return counts
}
