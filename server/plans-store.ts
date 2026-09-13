import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { ExtractedElement } from './extract.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_FILE = resolve(__dirname, '..', 'plans.json')

export interface Step {
  id: string
  title: string
  criterion: string
  command?: string
  // Opt-in visual check. Absent (the overwhelming default) means this step is
  // verified by `command` or by a plain read-the-repo critic, exactly as
  // before. Present means an independent critic blind-compares a screenshot
  // of the running app against a mockup — a per-step decision, NOT a
  // property of the project (a backend step in a UI project needs no visual
  // check; a UI step in that same project does). See verifyStep.
  check?: 'visual'
  // Only meaningful alongside check:'visual'. `mockup` is repo-relative and
  // defaults to design/<issueId>/index.html — overridable because a real
  // mockup often lives wherever the design tool exported it (this is exactly
  // what made LAE-179's check silently impossible). `params` supplies the
  // project's capture-command placeholders, superseding the older
  // design/<issueId>/capture.json sidecar. `candidates` + `viewport` come
  // from extract.ts's DOM walk of the mockup, filtered down by the Refiner
  // during consolidation to the elements actually worth verifying (ignoring
  // chrome/decoration) — when present and the project is DOM-inspectable,
  // verifyStep diffs each candidate's position/style against the real
  // implementation instead of asking a critic for one holistic verdict.
  // `tolerance` overrides the per-property defaults for this step only.
  visual?: {
    mockup?: string
    params?: Record<string, string>
    candidates?: ExtractedElement[]
    viewport?: [number, number]
    tolerance?: { position?: number; color?: number; fontSize?: number; borderRadius?: number }
  }
  status: 'pending' | 'done'
  attempts: number
  lastFailure?: string
}

export interface Plan {
  planId: string
  title?: string
  content: string
  issueId?: string
  sessionId?: string
  createdAt: string
  appliedAt?: string
  steps?: Step[]
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

export function getActivePlanForIssue(issueId: string): Plan | undefined {
  const plans = listPlansForIssue(issueId)
  return plans.find((p) => p.steps && p.steps.length > 0)
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

export function setStep(planId: string, stepId: string, patch: Partial<Step>): void {
  const store = loadStore()
  const plan = store[planId]
  const step = plan?.steps?.find((s) => s.id === stepId)
  if (!step) return
  Object.assign(step, patch)
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2))
}
