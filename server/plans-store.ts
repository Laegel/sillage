import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_FILE = resolve(__dirname, '..', 'plans.json')

export interface Plan {
  planId: string
  title?: string
  content: string
  issueId?: string
  sessionId?: string
  createdAt: string
  appliedAt?: string
}

type PlanStoreFile = Record<string, Plan>

function loadStore(): PlanStoreFile {
  if (!existsSync(STORE_FILE)) return {}
  return JSON.parse(readFileSync(STORE_FILE, 'utf8'))
}

export function listPlansForIssue(issueId: string): Plan[] {
  const all = loadStore()
  return Object.values(all)
    .filter((p) => p.issueId === issueId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getLatestUnappliedPlanForIssue(issueId: string): Plan | undefined {
  const plans = listPlansForIssue(issueId)
  return plans.find((p) => !p.appliedAt)
}

export function savePlan(plan: Omit<Plan, 'planId'>): Plan {
  const store = loadStore()
  const planId = randomUUID()
  const entry: Plan = { ...plan, planId }
  store[planId] = entry
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2))
  return entry
}

export function markPlanApplied(planId: string): Plan | undefined {
  const store = loadStore()
  const entry = store[planId]
  if (!entry) return undefined
  entry.appliedAt = new Date().toISOString()
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2))
  return entry
}
