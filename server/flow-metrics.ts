import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FlowIssueBase, IssueTransition, LinearStoreLike } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = resolve(__dirname, '..', 'issue-history-cache.json')
const HISTORY_CONCURRENCY = 8

export interface FlowIssue extends FlowIssueBase {
  transitions: IssueTransition[]
}

type HistoryCache = Record<string, { updatedAt: string; transitions: IssueTransition[] }>

function loadCache(): HistoryCache {
  try {
    return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {}
  } catch {
    return {}
  }
}

// Issues for the Metrics flow charts, each with its status transitions. A
// transition log only changes when the issue does, so it's cached on disk by
// updatedAt: pilot restarts often, and refetching ~1 request per issue on
// every page load would eat into Linear's 2,500/hour budget for nothing.
export async function getFlowIssues(linear: LinearStoreLike, since: Date): Promise<FlowIssue[]> {
  const [issues, cache] = [await linear.listFlowIssues(since), loadCache()]
  const stale = issues.filter((i) => cache[i.id]?.updatedAt !== i.updatedAt)

  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(HISTORY_CONCURRENCY, stale.length) }, async () => {
      while (next < stale.length) {
        const issue = stale[next++]
        try {
          cache[issue.id] = { updatedAt: issue.updatedAt, transitions: await linear.listIssueHistory(issue.id) }
        } catch (err: any) {
          // Left uncached so the next load retries it; one failure shouldn't blank the page.
          console.error(`[flow-metrics] history for ${issue.id} failed:`, err.message)
        }
      }
    }),
  )
  if (stale.length) writeFileSync(CACHE_FILE, JSON.stringify(cache))

  return issues.map((i) => ({ ...i, transitions: cache[i.id]?.transitions ?? [] }))
}
