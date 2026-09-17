import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { designIssueFor, designTurnMessage, planDesignLink } from './design-link.ts'
import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocketServer, type WebSocket } from 'ws'
import { getLinearStore, STATUS_COLUMNS } from './linear.ts'
import { startWebhookListener } from './webhook-listener.ts'
import {
  buildPrompt,
  buildRefinePrompt,
  buildIdeationPrompt,
  buildDriverFirstTurnPrompt,
  buildDriverOwnershipUpdatePrompt,
  buildDesignPrompt,
  buildFullSynthesisPrompt,
  buildIncrementalSynthesisPrompt,
  buildRefineReadyRule,
  buildConsolidatePrompt,
  RESUME_RECAP_PROMPT,
  buildStepExhaustedReason,
  parseClaudeChoice,
  type ClaudeChoice,
  runClaude,
  runFree,
  runOpencode,
  runKilocode,
  runMockAgent,
  SILLAGE_ROOT,
} from './agent.ts'
import { captureConfigFor, captureParamNames, checkRequiredTools, mappedProjects, resolveProjectDir, stepCommandPrefixFor, supportsWorktrees, validateCaptureParams, validateVisualRegion, type CaptureConfig } from './project-map.ts'
import {
  captureRound,
  CaptureSideFailure,
  findDivergedBarBranch,
  recordVerdict,
  recordVerifyResult,
  resolveBar,
  runCritique,
  verifyStep,
  type BarResolution,
  type CaptureRoundResult,
  type Verdict,
} from './critic.ts'
import { deleteChatSession, getChatSession, implementSessionKey, saveChatSession, type ChatBackend } from './chat-store.ts'
import { extractElements } from './extract.ts'
import { getFlowIssues } from './flow-metrics.ts'
import { loadGateRuns } from './gates-store.ts'
import { appendStepAttempt, builderFailureReason, loadStepAttempts, modelFromRunLog, type StepAttempt } from './step-metrics-store.ts'
import { isStepExhausted, resetStep, savePlan, markPlanApplied, getLatestUnappliedPlanForIssue, listPlansForIssue, getActivePlanForIssue, setStep, type Plan, type Step } from './plans-store.ts'
import { appendUsage, loadUsage } from './usage-store.ts'
import { getSynthesis, saveSynthesis, type SynthesisEntry } from './synthesis-store.ts'
import { classifyFriction, appendFriction, loadFriction, repeatTracker, type FrictionEntry } from './friction-store.ts'
import { loadActiveRuns, saveActiveRun, clearActiveRun, type RunBackend, type RunKind, type ActiveRunRecord } from './run-registry.ts'
import type { AgentEvent, DriverAction, DriverActionKind, DriverMode, Issue } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const PORT = Number(process.env.PORT || 4390)
const linear = getLinearStore()

// Step.command is LLM-authored and re-executed on every attempt (see the
// per-step verify loop coming in Phase 2) — this is a coarse net, not a
// sandbox; the real backstop is the human "Apply" gate before anything runs.
const STEP_COMMAND_DENYLIST = /\b(git\s+(commit|push|checkout|reset)|gh\s+pr\s+(create|merge)|rm|mv|cp|tee|sudo|sed\s+-i|npm\s+publish|cargo\s+publish)\b/

type ActiveState = {
  issueId: string
  task: string
  events: AgentEvent[]
  done: boolean
  proc: ChildProcess | null
  // Set for a recovered run, which has no live ChildProcess to kill — lets
  // stop/restart still work by pid instead of silently no-op'ing.
  pid?: number
  stopped: boolean
  pendingRestart: boolean
  lastEventAt: number
}

const clients = new Set<WebSocket>()

// One implement run at a time per project FOLDER (not per issue) — `active`
// below only ever asked "is this issue running," never "is this project's
// working tree already in use by a different issue." A project without git
// worktrees (see supportsWorktrees) has exactly one checkout, so two implement
// runs on two different issues in it would race on the same branch/files.
// FIFO by construction: each acquire captures the current tail before
// installing its own, so a third caller queues behind the second, not the
// first. Skipped entirely for a project marked supportsWorktrees — see runTask.
const projectSlot = new Map<string, Promise<void>>()

async function acquireProjectSlot(folder: string, onOutput: (event: AgentEvent) => void): Promise<() => void> {
  const waitFor = projectSlot.get(folder)
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  projectSlot.set(folder, held)
  if (waitFor) {
    onOutput({ kind: 'orchestrator', text: 'Waiting — another issue is currently being implemented in this project; this run will start once it finishes.' })
    await waitFor
  }
  return () => {
    release()
    if (projectSlot.get(folder) === held) projectSlot.delete(folder)
  }
}

const active = new Map<string, ActiveState>()
const activeRefine = new Map<string, { issueId: string; lastEventAt: number; textParts: string[]; events: AgentEvent[] }>()
// Set by the refine agent itself via POST /api/refine/:issueId/ready when it
// judges its own just-finished reply to be a complete plan — a tool call the
// model reliably makes, unlike the fenced-block-in-prose convention this
// replaced (models kept "finishing" a plan without remembering to also format
// it a specific way inline). Consumed once, in runRefine's completion branch.
const refineReadyToConsolidate = new Set<string>()
const activeIdeation = new Map<string, { sessionId: string; events: AgentEvent[] }>()
const activeDriver = new Map<string, { sessionId: string; events: AgentEvent[] }>()
const activeDesign = new Map<string, { sessionId: string; events: AgentEvent[] }>()
// Which Linear issue (if any) a design session is linked to — drives its
// output folder and whether "Commit to branch" is available. Memory-only:
// the frontend owns the durable copy (persisted in its own localStorage
// history), this is just the server's working copy for the run.
const designSessionIssue = new Map<string, string>()

// ponytail: memory-only, deliberately not persisted — a server restart always
// resets every Driver session back to manual rather than silently resuming an
// unattended autonomous loop nobody knows is still armed.
const driverSessionMode = new Map<string, DriverMode>()
const driverAutonomyBudget = new Map<string, number>()

// A Driver session's set of cards it's actively watching end-to-end, plus a
// reverse index for O(1) "who owns this card" lookups from inside
// broadcast(). Memory-only like the maps above — but unlike a run's own
// active* entry, ownership doesn't need to survive a restart to stay correct:
// recoverActiveRuns() re-populates active*/activeRefine/etc. from disk, and
// this map gets rebuilt the normal way as those recovered runs finish and
// their outcomes flow through executeDriverActions/claimOwnership again.
const driverOwnership = new Map<string, Set<string>>()
const issueOwner = new Map<string, string>()
// Server-initiated reprompts (event-driven, timer-driven) have no client WS
// message to carry projectId on, so it's cached here whenever a session's
// mode is set.
const driverSessionProject = new Map<string, string>()
// Per-card watchdog: ownership status-update turns this card has been
// carried through since it was last (re)claimed, without reaching a
// terminal status — force-released past MAX_OWNERSHIP_REPROMPTS_PER_CARD so
// a card that never resolves doesn't loop forever.
const driverRepromptCount = new Map<string, number>()
// Which PR belongs to which issue, so the Driver's 'merge' action knows what to
// merge. Populated by handleHookEvent when notify-pr.js reports a PR.
// Memory-only — if lost to a restart, merge fails cleanly instead of guessing.
const issuePrUrl = new Map<string, string>()

type DriverPendingEvent = { kind: 'ownership'; issueId: string; reason: string } | { kind: 'board_scan' }
const pendingDriverEvents = new Map<string, DriverPendingEvent[]>()
const driverDebounceTimer = new Map<string, ReturnType<typeof setTimeout>>()
// Fires stall_detected once per stall episode, not once per poll tick —
// cleared once the run leaves active/activeRefine so it can re-arm.
const stallFlagged = new Set<string>()
// Single-flight guard for runSynthesisJob, same idiom as activeRefine/activeIdeation
// — keyed by Linear project id since that's the store's own key.
const processingSynthesis = new Set<string>()

const MAX_ACTIONS_PER_TURN = 10
const MAX_AUTONOMOUS_ACTIONS_PER_ACTIVATION = 5
const MAX_OWNERSHIP_REPROMPTS_PER_CARD = 20
const AUTONOMOUS_OWNED_CAP = 3
const AUTONOMOUS_IDLE_RESCAN_MS = 30 * 60_000
const DRIVER_DEBOUNCE_MS = 3_000
const STALL_THRESHOLD_MS = 5 * 60_000
const STALL_POLL_INTERVAL_MS = 60_000

// Shared by both the manual "regenerate" endpoint (no opts — always a full
// re-explore) and the automatic Done-triggered patch (opts.issue set — cheap,
// no re-explore). Always runs on Claude, not the free-tier Kilo/OpenCode pool
// real refine/implement work needs.
//
// Unlike runRefine (which joins every `text` event into one live-streamed
// log — narration IS the point there), this is a one-shot job with nobody
// watching: each `text` event is one full assistant message, and a run that
// narrates progress before its real answer ("Exploring the codebase now...",
// "Now let me dig into...") would otherwise get that narration glued onto
// the front of what's persisted and shown as *the* synthesis. Only the last
// message is kept — the prompts explicitly ask for "ONLY the synthesis
// text" as the final answer, so whatever came before it is throwaway.
// Even the final message sometimes opens with one throwaway meta-sentence
// despite the prompt explicitly forbidding it ("Now writing the synthesis as
// plain text...", "Here's the synthesis:") — confirmed live. Backstop for
// what the prompt alone doesn't reliably suppress: strip a short first line
// matching the common phrasings, but only when it's followed by a real
// paragraph break, so a legitimate one-line synthesis is never touched.
function stripPreamble(text: string): string {
  const match = text.match(/^([^\n]{1,200})\n\n([\s\S]+)$/)
  if (match && /^(now |here'?s|here is|i have|i'll|i will|this is a|based on)/i.test(match[1])) {
    return match[2].trim()
  }
  return text
}

async function runSynthesisJob(projectId: string, opts?: { issue: Issue; prUrl?: string }): Promise<SynthesisEntry> {
  const projectDir = resolveProjectDir(projectId)
  const prompt = opts
    ? buildIncrementalSynthesisPrompt({ projectDir, priorSynthesis: getSynthesis(projectId)?.text ?? '', issue: opts.issue, prUrl: opts.prUrl })
    : buildFullSynthesisPrompt({ projectDir })
  let lastText = ''
  await runClaude({
    prompt,
    projectDir,
    onOutput: (event) => {
      if (event.kind === 'text') lastText = event.text
    },
    session: { id: randomUUID(), resume: false },
    readOnly: true,
  })
  const entry: SynthesisEntry = { text: stripPreamble(lastText.trim()), updatedAt: new Date().toISOString(), lastIssueId: opts?.issue.id }
  saveSynthesis(projectId, entry)
  return entry
}

// Fired from broadcast() below on every issue_updated — covers both completion
// paths that already emit that exact event: mergePr's own broadcast after it
// sets status to Done, and a human manually dragging the card to Done in
// Linear (generic issue_updated via the webhook listener). One fresh
// getIssue + status check (mirrors isSelfDrivenInProgress) tells them apart
// from any other field edit.
async function maybeUpdateSynthesis(payload: Record<string, unknown>): Promise<void> {
  if (payload.type !== 'issue_updated') return
  const issueId = payload.issueId
  if (typeof issueId !== 'string') return
  const issue = await linear.getIssue(issueId)
  if (issue.status !== 'Done' || !issue.project) return
  if (getSynthesis(issue.project)?.lastIssueId === issueId) return
  if (processingSynthesis.has(issue.project)) return
  processingSynthesis.add(issue.project)
  try {
    await runSynthesisJob(issue.project, { issue, prUrl: issuePrUrl.get(issueId) })
  } finally {
    processingSynthesis.delete(issue.project)
  }
}

// Cheap trigger, not the source of truth — costs nothing extra since
// maybeUpdateSynthesis (above) already makes this exact getIssue() call
// (15s cache). Losing this map to a restart costs at most one missed
// detection; the authoritative listIssueHistory count below corrects it on
// the card's next move.
const lastSeenStatus = new Map<string, string>()
// Last count actually recorded per issue, so a repeat backward move that
// hasn't increased the lifetime count doesn't append a duplicate line.
const recordedRegressions = new Map<string, number>()
const REGRESSION_THRESHOLD = 2

// Sibling to maybeUpdateSynthesis above — same "react to issue_updated, do
// one async thing, swallow errors" shape. Detects a card moving backward on
// the board (e.g. repeatedly bounced back to Todo), which is otherwise
// invisible: nothing else in this file tracks a card's status trajectory.
async function maybeRecordRegression(payload: Record<string, unknown>): Promise<void> {
  if (payload.type !== 'issue_updated') return
  const issueId = payload.issueId
  if (typeof issueId !== 'string') return
  const issue = await linear.getIssue(issueId)
  const previous = lastSeenStatus.get(issueId)
  lastSeenStatus.set(issueId, issue.status)
  if (!previous || previous === issue.status) return
  if (STATUS_COLUMNS.indexOf(issue.status) >= STATUS_COLUMNS.indexOf(previous)) return

  // Only now, on a confirmed backward move, pay the 2 requests for the
  // authoritative lifetime count — this also recovers regressions that
  // happened while this process was down, since it's not derived from
  // lastSeenStatus at all.
  const history = await linear.listIssueHistory(issueId)
  const count = history.filter(
    (t) => t.fromStatus && STATUS_COLUMNS.indexOf(t.toStatus) < STATUS_COLUMNS.indexOf(t.fromStatus),
  ).length
  if (count < REGRESSION_THRESHOLD) return
  if ((recordedRegressions.get(issueId) ?? 0) >= count) return
  recordedRegressions.set(issueId, count)
  appendFriction({
    kind: 'status_regression',
    timestamp: new Date().toISOString(),
    issueId,
    project: issue.project,
    detail: `moved backward ${count}× (latest: ${previous} → ${issue.status})`,
  })
}

const GITHUB_PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

// Attaches a PR to its issue and tells everyone (Linear, the UI, the Driver)
// regardless of which of the two ways this got noticed: the Claude-specific
// PostToolUse hook (notify-pr.js -> /hook-event -> handleHookEvent), or the
// generic tool-call scan in broadcast() below (the only signal that exists
// for OpenCode/Kilocode runs, which have no hook system at all — previously
// a PR opened during one of those runs, the common case since the free tier
// is tried first, was only ever mentioned in the agent's own narrated text,
// never attached to the issue or surfaced to the Driver). Idempotent so
// either path firing first doesn't duplicate the Linear write.
function recordPrCreated(issueId: string, prUrl: string) {
  if (issuePrUrl.get(issueId) === prUrl) return
  issuePrUrl.set(issueId, prUrl)
  linear.attachPr(issueId, prUrl).catch((err: any) => console.error('[pr] linear update failed:', err.message))
  broadcast({ type: 'pr_created', prUrl, issueId })
  broadcast({ type: 'issue_updated', issueId })
}

// Built on first use from the existing log, so a repeat streak survives restarts.
let trackRepeat: ((entry: FrictionEntry) => FrictionEntry | undefined) | undefined

function broadcast(payload: Record<string, unknown>) {
  const message = JSON.stringify(payload)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(message)
  }
  const event = payload.event as AgentEvent | undefined
  if (event?.kind === 'usage') {
    appendUsage({
      backend: event.backend,
      timestamp: new Date().toISOString(),
      id: typeof payload.issueId === 'string' ? payload.issueId : typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
      cost: event.cost,
      tokens: event.tokens,
    })
  }
  if (event?.kind === 'tool_call' && event.status === 'complete' && typeof payload.issueId === 'string') {
    const match = event.output?.match(GITHUB_PR_URL)
    if (match) recordPrCreated(payload.issueId, match[0])
  }
  const friction = classifyFriction(payload)
  if (friction) {
    appendFriction(friction)
    trackRepeat ??= repeatTracker(loadFriction())
    const repeated = trackRepeat(friction)
    if (repeated) appendFriction(repeated)
  }
  routeDriverSignal(payload).catch((err) => console.error('[routeDriverSignal] failed:', err))
  maybeUpdateSynthesis(payload).catch((err) => console.error('[maybeUpdateSynthesis] failed:', err))
  maybeRecordRegression(payload).catch((err) => console.error('[maybeRecordRegression] failed:', err))
}

// Real-time changes arrive via Linear webhooks, handled by the separate
// listener started at the bottom of this file (see webhook-listener.ts).

function send(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload))
}

// Every "already running" rejection across implement/refine/ideation/driver/
// design/delete used to go out via plain send() — which never passes through
// broadcast(), so classifyFriction never saw it and these collisions vanished
// with no trace. This is the one place all of them now go through, so a
// repeat offender on the same issue/session is actually visible afterward
// instead of just a one-off toast the user has no way to correlate later.
function rejectBusy(ws: WebSocket, payload: { issueId?: string; sessionId?: string }, message: string) {
  appendFriction({
    kind: 'run_busy',
    timestamp: new Date().toISOString(),
    issueId: payload.issueId,
    sessionId: payload.sessionId,
    detail: message,
  })
  send(ws, { type: 'error', ...payload, message })
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

async function readBody(req: IncomingMessage): Promise<any> {
  const raw = await readRawBody(req)
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    throw new Error('invalid JSON body')
  }
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(data))
}

async function handleHookEvent(req: IncomingMessage, res: ServerResponse) {
  try {
    const body = await readBody(req)
    const prUrl = body.prUrl || ''
    const issueId = body.issueId || body.issue?.identifier || ''
    if (!prUrl) {
      json(res, 400, { ok: false, error: 'missing prUrl' })
      return
    }
    if (issueId) recordPrCreated(issueId, prUrl)
    json(res, 200, { ok: true })
  } catch (err: any) {
    json(res, 500, { ok: false, error: err.message })
  }
}

async function handleLinearApi(req: IncomingMessage, res: ServerResponse, path: string) {
  const issueMatch = path.match(/^\/api\/linear\/issue\/([^/]+)(\/.*)?$/)
  try {
    if (path === '/api/linear/projects' && req.method === 'GET') {
      const projects = await linear.listProjects()
      return json(res, 200, { projects })
    }
    if (path === '/api/linear/issues' && req.method === 'GET') {
      const issues = await linear.listIssues()
      return json(res, 200, { issues, columns: STATUS_COLUMNS })
    }
    if (path === '/api/linear/issues' && req.method === 'POST') {
      const body = await readBody(req)
      const issue = await linear.createIssue(body)
      broadcast({ type: 'issue_created', issue })
      return json(res, 201, { issue })
    }
    if (issueMatch) {
      const [, issueId, rest] = issueMatch
      if ((!rest || rest === '/') && req.method === 'GET') {
        const issue = await linear.getIssue(issueId)
        return json(res, 200, { issue })
      }
      if (rest === '/status' && req.method === 'POST') {
        const body = await readBody(req)
        const issue = await linear.setStatus(issueId, body.status)
        broadcast({ type: 'issue_updated', issueId })
        return json(res, 200, { issue })
      }
      if (rest === '/update' && req.method === 'POST') {
        const body = await readBody(req)
        const issue = await linear.updateIssue(issueId, body)
        broadcast({ type: 'issue_updated', issueId })
        return json(res, 200, { issue })
      }
      if (rest === '/comment' && req.method === 'POST') {
        const body = await readBody(req)
        await linear.addComment(issueId, body.body)
        return json(res, 200, { ok: true })
      }
      if (rest === '/comments' && req.method === 'GET') {
        const comments = await linear.listComments(issueId)
        return json(res, 200, { comments })
      }
      if (rest === '/sub-issues' && req.method === 'GET') {
        const subIssues = await linear.listSubIssues(issueId)
        return json(res, 200, { subIssues })
      }
      if (rest === '/history' && req.method === 'GET') {
        const history = await linear.listIssueHistory(issueId)
        return json(res, 200, { history })
      }
      return json(res, 405, { error: 'method not allowed' })
    }
    return json(res, 404, { error: 'not found' })
  } catch (err: any) {
    // Distinguished from a generic 500 so the frontend can skip its retry —
    // retrying against an exhausted hourly quota can't succeed and only
    // burns more of it.
    const status = /rate limit exceeded/i.test(err.message || '') ? 429 : 500
    return json(res, status, { error: err.message })
  }
}

const execFileAsync = promisify(execFile)

// Snapshot of a git repo's state, used to verify an implement run actually
// changed something instead of trusting the agent's own "I'm done" signal —
// see runTask below for why (a Kilo Code run that read 6 files, wrote
// nothing, and exited cleanly was still reported as a successful "done").
// Returns null (rather than throwing) if git isn't available or the project
// isn't a repo — the caller skips the check entirely in that case, since a
// git-tooling problem is unrelated to whether the agent actually worked.
async function gitSnapshot(projectDir: string): Promise<{ head: string; dirty: boolean } | null> {
  try {
    const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectDir })
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: projectDir })
    return { head: head.trim(), dirty: status.trim().length > 0 }
  } catch {
    return null
  }
}

// Persists {pid, logFile} for a just-spawned agent process so recoverActiveRuns()
// can find and reattach to it if this server restarts mid-run — see
// server/run-registry.ts and agent.ts's openRunLog/tailLines for the other half.
// Called from every run* function's onProcess callback, right after spawn.
function registerRun(
  key: string,
  kind: RunKind,
  backend: RunBackend,
  sessionId: string | undefined,
  proc: ChildProcess,
  logFile: string,
  projectId?: string,
): void {
  if (typeof proc.pid !== 'number') return
  saveActiveRun({ key, kind, pid: proc.pid, logFile, backend, sessionId, projectId })
}

async function runTask({
  issueId,
  task,
  onOutput,
  onProcess,
  fresh,
  openPr,
  requireChanges,
  sessionScope,
}: {
  issueId: string
  task: string
  onOutput: (event: AgentEvent) => void
  onProcess?: (proc: ChildProcess, logFile: string, backend: RunBackend, sessionId: string | undefined) => void
  // Skips the resume-if-one-exists check below — a deliberate clean-slate
  // run, e.g. when a prior attempt's session went off in a bad direction and
  // resuming it would just drag the same dead end back in.
  fresh?: boolean
  // Threaded straight to buildPrompt — see its own comment for why this has
  // to be a structural param, not a sentence in the task text.
  openPr?: boolean
  // false only for runCard's wrap-up run (see there) — that run's whole job
  // is push + open PR, which legitimately makes no new commits when the last
  // real step already committed everything, so "no changes" must not read
  // as stuck for that one call.
  requireChanges?: boolean
  // A plan step's id: its Builder session is kept apart from other steps' (implementSessionKey).
  sessionScope?: string
}) {
  const issue = await linear.getIssue(issueId)

  // Orchestrator-driven, not agent-driven (unlike the In Review/Todo transitions,
  // which the agent sets itself via Linear MCP): this needs to be reliable regardless
  // of which agent is running or whether its Linear MCP happens to be authenticated,
  // since the whole point is "the user can trust the board reflects reality."
  try {
    await linear.setStatus(issueId, 'In Progress')
    broadcast({ type: 'issue_updated', issueId })
  } catch (err: any) {
    onOutput({ kind: 'orchestrator', text: `Could not move issue to "In Progress": ${err.message}` })
  }

  if (process.env.USE_MOCK_AGENT === 'true') {
    onOutput({ kind: 'orchestrator', text: 'USE_MOCK_AGENT=true — using simulated agent for the demo.' })
    return runMockAgent({ issueId, onOutput, onProcess: (proc, logFile) => onProcess?.(proc, logFile, 'mock', undefined) })
  }

  const projectDir = resolveProjectDir(issue.project)
  const folder = basename(projectDir)
  const releaseProjectSlot = supportsWorktrees(folder) ? undefined : await acquireProjectSlot(folder, onOutput)

  try {
    await checkRequiredTools(folder)
    const comments = await linear.listComments(issueId)
    const approvedPlan = getLatestUnappliedPlanForIssue(issueId)
    const planBlock = approvedPlan
      ? `APPROVED PLAN\n${approvedPlan.content}\n\n`
      : ''
    const prompt = await buildPrompt({ issue, comments, task: `${planBlock}${task}`, projectDir, openPr })
    onOutput({
      kind: 'tool_call',
      id: 'prompt',
      tool: 'prompt',
      label: `Prompt sent (${prompt.length} chars)`,
      status: 'complete',
      output: prompt,
    })

    // Keyed separately from refine's plain `issueId` key (chat-store.ts) — a
    // refine turn's read-only session and an implement run's writing session
    // for the same issue must never collide under one entry.
    const sessionKey = implementSessionKey(issueId, sessionScope)
    const existing = fresh ? undefined : getChatSession(sessionKey)

    const before = await gitSnapshot(projectDir)
    if (!before) {
      onOutput({ kind: 'orchestrator', text: 'Could not read git status for this project — skipping the post-run change-verification check.' })
    }

    // No silent mock-agent fallback here on purpose: falling back to the demo mock when
    // a real, configured agent fails would make it write a fabricated PR link and a real
    // Linear status change for work that never happened — misleading, not helpful. The
    // mock agent only ever runs when USE_MOCK_AGENT=true is explicitly set above; a real
    // agent failing here is reported as a real failure instead.
    let run: { exitCode: number | null; needsFallback: boolean; rateLimited?: boolean; sessionId?: string }
    let backend: ChatBackend
    let agentLabel: string
    try {
      // Same resume-or-fresh dispatch runRefineTurn already uses (below) — a
      // restart after a stalled/incomplete run resumes here instead of
      // re-exploring the same files from scratch.
      if (existing?.backend === 'claude') {
        agentLabel = 'Claude Code (resumed session)'
        backend = 'claude'
        onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })
        run = await runClaude({
          prompt,
          projectDir,
          onOutput,
          session: { id: existing.sessionId, resume: true },
          onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, existing.sessionId),
        })
      } else if (existing?.backend === 'opencode') {
        agentLabel = 'OpenCode (resumed session)'
        backend = 'opencode'
        onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })
        run = await runOpencode({
          prompt,
          projectDir,
          onOutput,
          sessionId: existing.sessionId,
          onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, existing.sessionId),
        })
      } else if (existing?.backend === 'kilocode') {
        agentLabel = 'Kilo Code (resumed session)'
        backend = 'kilocode'
        onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })
        run = await runKilocode({
          prompt,
          projectDir,
          onOutput,
          sessionId: existing.sessionId,
          onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, existing.sessionId),
        })
      } else {
        const agentChoice = await linear.resolveAgentChoice(issueId)
        if (agentChoice === 'claude') {
          agentLabel = 'Claude Code'
          backend = 'claude'
          const freshId = randomUUID()
          onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })
          run = await runClaude({
            prompt,
            projectDir,
            onOutput,
            session: { id: freshId, resume: false },
            onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, freshId),
          })
        } else {
          agentLabel = 'Free (OpenCode, falling back to Kilo Code if needed)'
          onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })
          const freeRun = await runFree({
            prompt,
            projectDir,
            onOutput,
            onProcess: (proc, logFile, freeBackend) => onProcess?.(proc, logFile, freeBackend, undefined),
          })
          run = freeRun
          backend = freeRun.backend
        }
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(`${agentLabel!} binary not found on this machine.`)
      }
      throw err
    }

    if (run.sessionId) saveChatSession(sessionKey, backend, run.sessionId)

    if (run.needsFallback) {
      if (run.rateLimited) {
        throw new Error(`${agentLabel} hit OpenCode/Kilo Code's "Rate limit exceeded" error and could not finish. Wait for the quota to reset, or switch backend.`)
      }
      throw new Error(`${agentLabel} never finished — it either produced no output at all or went silent partway through. This can happen from an exhausted free-tier quota, an auth problem, or a crash; check the agent's own logs.`)
    }

    if (before && requireChanges !== false) {
      const after = await gitSnapshot(projectDir)
      if (after && after.head === before.head && !after.dirty) {
        throw new Error(`${agentLabel} finished without making any file changes — it likely got stuck exploring or ran out of budget before implementing anything. Its session has been saved, so restarting will resume from here instead of re-exploring from scratch.`)
      }
    }

    return run
  } finally {
    releaseProjectSlot?.()
  }
}

// Joins a run's narrated text (kind:'text' events only — tool calls/status/
// separators are noise for this purpose) into the same shape refine's
// `summary` field already uses. Without this, the Driver's ownership trigger
// for a finished/failed implementation run said only "exit code 1" or a bare
// thrown-error string — no idea what the agent actually did or why it
// stopped, which is exactly the information it needs to avoid re-requesting
// the same failed approach in a loop.
function summarizeEvents(events: AgentEvent[]): string {
  const text = events
    .filter((e): e is Extract<AgentEvent, { kind: 'text' }> => e.kind === 'text')
    .map((e) => e.text)
    .join('')
    .trim()
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text
}

// Shared by a fresh start and a restart. Runs one attempt in the background;
// if `pendingRestart` gets set on the state before this attempt settles (by
// handleRestart), the .finally() below immediately launches a fresh attempt
// for the same task — synchronously, right after active.delete(), so there's
// no window for a stray 'start' message to race into the gap.
// backend/logFile: whichever process actually ran last (after a free-tier
// fallback or a restart) — step metrics record them per attempt.
type StartRunResult = { ok: boolean; message: string; exitCode?: number | null; summary?: string; backend?: RunBackend; logFile?: string }

// silent skips this function's own done/error/stopped broadcasts — used by
// runGauntlet, which drives multiple attempts per issue and must control
// exactly when the Driver (via routeDriverSignal) hears about a result: never
// per-round, only once the whole gauntlet concludes. task_started is NOT
// silenced — it has no OWNERSHIP_TRIGGER_REASONS entry, so it only ever
// affects the live UI, where showing "a new round started" for each retry is
// correct, not noise.
function startRun(
  issueId: string,
  task: string,
  onDone?: (result: StartRunResult) => void,
  fresh?: boolean,
  silent?: boolean,
  openPr?: boolean,
  requireChanges?: boolean,
  sessionScope?: string,
) {
  const state: ActiveState = { issueId, task, events: [], done: false, proc: null, stopped: false, pendingRestart: false, lastEventAt: Date.now() }
  active.set(issueId, state)

  // Recorded here rather than calling onDone directly in .then()/.catch() —
  // see the contract note in .finally() below.
  let outcome: StartRunResult | null = null
  let spawned: { backend: RunBackend; logFile: string } | undefined

  runTask({
    issueId,
    task,
    fresh,
    openPr,
    requireChanges,
    sessionScope,
    onOutput: (event) => {
      state.events.push(event)
      state.lastEventAt = Date.now()
      broadcast({ type: 'output', issueId, event })
    },
    onProcess: (proc, logFile, backend, sessionId) => {
      state.proc = proc
      state.pid = proc.pid
      spawned = { backend, logFile }
      registerRun(issueId, 'task', backend, sessionId, proc, logFile)
    },
  })
    .then((result) => {
      state.done = true
      if (state.stopped) {
        if (!state.pendingRestart && !silent) broadcast({ type: 'stopped', issueId })
      } else {
        const summary = summarizeEvents(state.events)
        if (!silent) broadcast({ type: 'done', issueId, exitCode: result?.exitCode, summary })
        outcome = { ok: true, message: `exitCode ${result?.exitCode}`, exitCode: result?.exitCode, summary }
      }
    })
    .catch((err) => {
      state.done = true
      if (state.stopped) {
        if (!state.pendingRestart && !silent) broadcast({ type: 'stopped', issueId })
      } else {
        console.error(`[task ${issueId}] failed:`, err)
        const summary = summarizeEvents(state.events)
        if (!silent) broadcast({ type: 'error', issueId, message: err.message, summary })
        outcome = { ok: false, message: err.message, summary }
      }
    })
    .finally(() => {
      active.delete(issueId)
      clearActiveRun(issueId)
      // Contract: onDone fires exactly once, after the issue is no longer
      // active. A restart inherits the *original* onDone rather than dropping
      // it — the caller (e.g. executeDriverActions awaiting startDriverImplement)
      // is waiting on the task finishing, not on one particular attempt. A plain
      // stop with no pending restart still has to resolve that same await
      // instead of hanging it forever — `outcome` is null in that branch (the
      // stopped path above never sets it), so it resolves with an explicit
      // "stopped before completion" rather than silently never settling.
      if (state.pendingRestart) {
        startRun(issueId, state.task, onDone, undefined, silent, openPr, requireChanges, sessionScope)
      } else {
        onDone?.({ ...(outcome ?? { ok: false, message: 'run was stopped before it completed' }), ...spawned })
      }
    })

  broadcast({ type: 'task_started', issueId, task })
}

// Cap is a per-card lifetime bound, not per-invocation — deliberately NOT
// reset when runGauntlet is called again for the same issue. A Driver (or a
// human) retrying a card whose gauntlet already exhausted all its rounds
// must be told "already exhausted, needs a human look" again, not silently
// restart the counter and ping-pong on the same unwinnable comparison
// forever. The only way this clears is a win (see below) — an exhausted
// card stays exhausted until the server restarts (memory-only, same as
// driverAutonomyBudget/driverRepromptCount elsewhere in this file).
const MAX_GAUNTLET_ROUNDS = 3
const gauntletRounds = new Map<string, number>()

// Promise-ifies one startRun attempt via its onDone callback — the same
// "await one attempt" shape startDriverImplement already uses, reused here
// for the loop's own internal stepping between rounds.
function runGauntletAttempt(issueId: string, task: string, fresh: boolean | undefined): Promise<StartRunResult> {
  return new Promise((resolve) => startRun(issueId, task, resolve, fresh, true))
}

// Wraps the implement/critic/retry cycle described in the gauntlet-loop
// plan: after each implementation attempt, if the issue has a linked design
// mockup, an independent critic blind-compares a screenshot of the running
// app against it, and — if the mockup still wins — the critic's own gap
// becomes the next attempt's task, until the critic picks the app's version
// or the round cap is hit. Every attempt inside the loop runs SILENT
// (startRun's own done/error broadcast suppressed): the Driver must never
// see a round's raw exit code and decide the card looks done on its own —
// that is exactly the "builder grades its own work" failure this whole
// feature exists to remove. runGauntlet emits exactly one done/error itself,
// once the loop actually concludes.
//
// Falls back to plain startRun's ordinary (non-silent) behavior the instant
// resolveBar says there's no bar for this issue — identical to how implement
// always worked before this feature existed. That fallback is checked fresh
// on every attempt, not cached, so a mockup linked mid-run is picked up by
// the very next round.
function runGauntlet(issueId: string, task: string, onDone?: (result: { ok: boolean; message: string }) => void, fresh?: boolean): void {
  ;(async () => {
    const alreadyExhausted = (gauntletRounds.get(issueId) ?? 0) >= MAX_GAUNTLET_ROUNDS
    if (alreadyExhausted) {
      const message = `This card's gauntlet already used all ${MAX_GAUNTLET_ROUNDS} rounds without the implementation beating its design mockup — needs a human look before trying again.`
      await flagIncomplete(issueId, message).catch((err: any) => console.error(`[gauntlet ${issueId}] flag-on-already-exhausted failed:`, err.message))
      broadcast({ type: 'error', issueId, message, failure: 'step_exhausted' })
      onDone?.({ ok: false, message })
      return
    }

    let currentTask = task
    let currentFresh = fresh

    while (true) {
      const result = await runGauntletAttempt(issueId, currentTask, currentFresh)
      currentFresh = undefined // only the very first attempt honors an explicit "fresh" request

      if (!result.ok) {
        // Crash, rate limit, or an external stop — the implement side never
        // genuinely finished, so there is nothing to capture or judge yet.
        // No round burned, no flag: quota exhaustion isn't an implementation
        // defect, and an external stop means a human already took over.
        broadcast({ type: 'error', issueId, message: result.message, summary: result.summary, failure: builderFailureTag(result.message) })
        onDone?.(result)
        return
      }

      let projectDir: string
      let bar: BarResolution
      try {
        const issue = await linear.getIssue(issueId)
        projectDir = resolveProjectDir(issue.project)
        bar = resolveBar(issueId, projectDir)
      } catch {
        // Can't even resolve which project/bar this is — behave exactly as
        // if no bar exists rather than hang the run on a Linear/config hiccup.
        broadcast({ type: 'done', issueId, exitCode: result.exitCode, summary: result.summary })
        onDone?.(result)
        return
      }

      if (!bar.ok) {
        // A bar existing on some feat/<issueId>-* branch that isn't the one
        // currently checked out is a git-state problem, not "no design was
        // intended" — conflating the two would silently disable this whole
        // feature the moment design-then-implement ordering slips.
        const divergedBranch = await findDivergedBarBranch(issueId, projectDir)
        if (divergedBranch) {
          const message = `A design mockup exists on branch ${divergedBranch} but not on the branch this run is working from — the design and implementation branches have diverged. Merge or rebase them onto one branch; the gauntlet loop can't judge against a mockup it can't see.`
          await flagIncomplete(issueId, message).catch((err: any) => console.error(`[gauntlet ${issueId}] flag-on-divergence failed:`, err.message))
          broadcast({ type: 'error', issueId, message, failure: 'check_infra' })
          onDone?.({ ok: false, message })
          return
        }
        // Genuinely no bar for this issue — exactly today's behavior.
        broadcast({ type: 'done', issueId, exitCode: result.exitCode, summary: result.summary })
        onDone?.(result)
        return
      }

      const round = (gauntletRounds.get(issueId) ?? 0) + 1
      gauntletRounds.set(issueId, round)
      broadcast({ type: 'output', issueId, event: { kind: 'orchestrator', text: `Gauntlet round ${round}/${MAX_GAUNTLET_ROUNDS}: capturing a screenshot of the app and comparing it against the design mockup…` } })

      let capture: CaptureRoundResult
      try {
        capture = await captureRound(bar, projectDir, issueId, round)
      } catch (err: any) {
        if (err instanceof CaptureSideFailure) {
          // The app itself didn't build/launch/render — that's the
          // builder's gap, feed it back as the next task rather than
          // escalating. Doesn't consume a round beyond the one already
          // counted above; the retry reuses the same round number's slot
          // conceptually, but simplest correct behavior is just: try again.
          currentTask = `The previous attempt didn't produce a working, screenshot-able build: ${err.message}\n\nFix this before anything else.`
          continue
        }
        // Our own capture infra broke (chromium/identify/convert missing, a
        // blank render, a genuinely pixel-identical mockup+app pair) — a bar
        // that exists must never be silently skipped, so this escalates
        // rather than quietly finishing as if the visual check passed.
        const message = `The visual comparison pipeline failed and could not judge this implementation: ${err.message}`
        await flagIncomplete(issueId, message).catch((e: any) => console.error(`[gauntlet ${issueId}] flag-on-infra-failure failed:`, e.message))
        broadcast({ type: 'error', issueId, message, failure: 'check_infra' })
        onDone?.({ ok: false, message })
        return
      }

      broadcast({ type: 'output', issueId, event: { kind: 'orchestrator', text: 'Asking an independent critic to compare the two, blind…' } })

      let verdict: Verdict | undefined
      try {
        verdict = await runCritique({
          roundDir: capture.roundDir,
          intent: `${issueId}: the screen depicted in its linked design mockup`,
          onOutput: (event) => broadcast({ type: 'output', issueId, event }),
        })
      } catch (err: any) {
        const message = `The critic run itself failed: ${err.message}`
        await flagIncomplete(issueId, message).catch(() => {})
        broadcast({ type: 'error', issueId, message, failure: 'check_infra' })
        onDone?.({ ok: false, message })
        return
      }

      if (!verdict) {
        // Neither the verdict endpoint nor the text-fallback produced
        // anything usable — discard this comparison. Silence must never be
        // treated as a pass, or the whole point of an independent check
        // evaporates the one time the critic actually fails to report.
        const message = 'The visual critic produced no usable verdict for this round.'
        await flagIncomplete(issueId, message).catch(() => {})
        broadcast({ type: 'error', issueId, message, failure: 'check_infra' })
        onDone?.({ ok: false, message })
        return
      }

      const winnerIsMockup = (verdict.winner === 'A') === capture.mockupIsA
      const oursWon = !winnerIsMockup

      if (oursWon) {
        broadcast({ type: 'done', issueId, exitCode: result.exitCode, summary: result.summary, critique: { winner: 'ours', rounds: round } })
        gauntletRounds.delete(issueId)
        onDone?.(result)
        return
      }

      if (round >= MAX_GAUNTLET_ROUNDS) {
        broadcast({ type: 'done', issueId, exitCode: result.exitCode, summary: result.summary, critique: { winner: 'mockup', exhausted: true, rounds: round, gap: verdict.gap } })
        await flagIncomplete(
          issueId,
          `The implementation ran ${round} round(s) against its design mockup and an independent visual critic still preferred the mockup every time. Last remaining gap: ${verdict.gap}`,
        ).catch((err: any) => console.error(`[gauntlet ${issueId}] flag-on-exhaustion failed:`, err.message))
        onDone?.({ ok: false, message: `gauntlet exhausted after ${round} rounds` })
        return
      }

      // Not won yet, rounds remain — the critic's own gap sentence becomes
      // the next attempt's task, and runTask resumes the implement:<issueId>
      // session (the builder keeps its context; the critic never does).
      currentTask = verdict.gap
    }
  })()
}

// Cap is per-step, not per-card — a card with 6 steps gets up to 6*3 = 18
// attempts total, bounded by the 8-step max enforced at plan-creation time
// (POST /api/plans), same reasoning as MAX_GAUNTLET_ROUNDS above but scoped
// one level finer.
const MAX_STEP_ATTEMPTS = 3

function runCardAttempt(issueId: string, task: string, fresh: boolean | undefined, openPr: boolean, requireChanges: boolean, sessionScope?: string): Promise<StartRunResult> {
  return new Promise((resolve) => startRun(issueId, task, resolve, fresh, true, openPr, requireChanges, sessionScope))
}

// Frames one step as its own self-contained task — "step N of M" plus the
// criterion restated as a DONE condition (not a to-do description) keeps the
// resumed session from re-litigating steps already marked done, and the
// verbatim lastFailure gives a retry the exact reason the previous attempt
// didn't pass instead of making it re-derive that from scratch.
// The capture command for the project an issue belongs to — undefined when the
// project has none or the issue can't be resolved.
async function captureConfigForIssue(issueId: string): Promise<CaptureConfig | undefined> {
  const issue = await linear.getIssue(issueId)
  return captureConfigFor(basename(resolveProjectDir(issue.project)))
}

// For the consolidation prompt: the argv the project's step commands run through.
async function stepCommandPrefixForIssue(issueId: string): Promise<string[] | undefined> {
  try {
    const issue = await linear.getIssue(issueId)
    return stepCommandPrefixFor(basename(resolveProjectDir(issue.project)))
  } catch {
    return undefined
  }
}

// For the consolidation prompt: the exact param keys, null when the project has
// no capture command, undefined when the lookup itself failed (prompt stays generic).
async function captureParamNamesForIssue(issueId: string): Promise<string[] | null | undefined> {
  try {
    const cfg = await captureConfigForIssue(issueId)
    return cfg ? captureParamNames(cfg) : null
  } catch {
    return undefined
  }
}

// A Builder attempt that never reached a check: a deliberate stop isn't friction.
function builderFailureTag(message: string): 'builder_failed' | 'stopped' {
  return builderFailureReason(message) === 'stopped' ? 'stopped' : 'builder_failed'
}

// `instructions`: the task text whoever started this run gave (a Driver implement
// action, the Task panel) — it used to reach only cards without a step plan, so a
// Driver's precise fix for a stepped card (LAE-183) never got to the Builder.
function buildStepTask(step: Step, index: number, total: number, instructions?: string): string {
  const commandBlock = step.command
    ? `\n\nYou can check your own work with this command — it should exit 0 once this step is genuinely done:\n${step.command}`
    : ''
  const failureBlock = step.lastFailure
    ? `\n\nThe previous attempt at this step did NOT pass verification. What was found:\n${step.lastFailure}`
    : ''
  return `This is step ${index} of ${total} in a multi-step plan for this card. Earlier steps are already verified done — do not redo or second-guess them, only do this one.

STEP: ${step.title}

This step is DONE when: ${step.criterion}${commandBlock}${failureBlock}${instructions?.trim() ? `\n\nINSTRUCTIONS FOR THIS RUN (from whoever started it — follow them where they apply to this step):\n${instructions.trim()}` : ''}`
}

const STEPS_BLOCK_START = '<!-- steps:start -->'
const STEPS_BLOCK_END = '<!-- steps:end -->'

// Server-side twin of the frontend's own mergeStepsIntoDescription
// (App.tsx) — same marker-delimited block, same regex-replace-or-append, so
// either side can update just the checklist without clobbering the rest of
// a human-editable field that updateIssue itself blind-overwrites.
function mergeStepsIntoDescription(description: string, steps: Step[]): string {
  const checklist = steps.map((s) => `- [${s.status === 'done' ? 'x' : ' '}] ${s.title} — ${s.criterion}`).join('\n')
  const block = `${STEPS_BLOCK_START}\n## Steps\n${checklist}\n${STEPS_BLOCK_END}`
  const pattern = new RegExp(`${STEPS_BLOCK_START}[\\s\\S]*?${STEPS_BLOCK_END}`)
  if (pattern.test(description)) return description.replace(pattern, block)
  const separator = description.trim() ? '\n\n' : ''
  return `${description}${separator}${block}`
}

// Called unconditionally at the start of every runCard invocation — the
// guarantee this exists for. If the description has never been merged
// before (no marker block yet), the plan's own consolidated content becomes
// the base, so a card that skipped Apply entirely (the actual LAE-177 bug)
// still ends up with its real goal/approach text, not just a checklist
// grafted onto nothing. Once a block exists, later calls preserve whatever's
// currently in Linear (including a human's own edits) and only refresh the
// checklist itself — never re-inject plan.content over something someone
// may have since changed by hand.
async function ensureDescriptionHasSteps(issueId: string, plan: Plan): Promise<void> {
  if (!plan.steps || plan.steps.length === 0) return
  const issue = await linear.getIssue(issueId)
  const current = issue.description || ''
  const hasBlock = new RegExp(`${STEPS_BLOCK_START}[\\s\\S]*?${STEPS_BLOCK_END}`).test(current)
  const base = hasBlock ? current : plan.content || current
  const merged = mergeStepsIntoDescription(base, plan.steps)
  if (merged !== current) {
    await linear.updateIssue(issueId, { description: merged })
    broadcast({ type: 'issue_updated', issueId })
  }
}

// Replaces runGauntlet at both call sites for any card Refine has split into
// steps (see the "Per-step Builder→Critic loop" plan) — a card with no steps
// falls straight through to the unchanged visual-gauntlet-or-plain-implement
// behavior below, so un-refined work is never blocked on this being wired up.
// Same onDone-fires-once contract as startRun/runGauntlet: exactly one
// done/error broadcast for the whole call, regardless of how many step
// attempts happened inside it — every attempt runs silent for exactly that
// reason (see startRun's own comment on `silent`).
// Returns false only when the card was refused outright (an exhausted step).
function runCard(issueId: string, task: string, onDone?: (result: { ok: boolean; message: string }) => void, fresh?: boolean): boolean {
  const plan = getActivePlanForIssue(issueId)
  if (!plan?.steps || plan.steps.length === 0) {
    runGauntlet(issueId, task, onDone, fresh)
    return true
  }
  const steps = plan.steps

  // Steps run in order, so the first unfinished step decides. Out of attempts
  // from an earlier run, it waits for a human reset (TaskPanel / POST
  // /api/plans/:id/steps/:stepId/reset): re-running granted one more attempt per
  // re-issued implement — LAE-183's s2b reached 9. Refused before any Linear
  // call: no Builder run, no new comment (the card was flagged when it ran out).
  const next = steps.find((s) => s.status !== 'done')
  if (next && isStepExhausted(next, MAX_STEP_ATTEMPTS)) {
    const message = `Step "${next.title}" has used all ${next.attempts} attempts and is waiting for a human reset — not running it again.`
    broadcast({ type: 'error', issueId, message, failure: 'step_exhausted', alreadyExhausted: true, steps: { done: steps.length - steps.filter((s) => s.status !== 'done').length, total: steps.length, failedStep: next.title, lastFailure: next.lastFailure } })
    onDone?.({ ok: false, message })
    return false
  }

  ;(async () => {
    let projectDir: string
    try {
      const issue = await linear.getIssue(issueId)
      projectDir = resolveProjectDir(issue.project)
    } catch (err: any) {
      broadcast({ type: 'error', issueId, message: err.message })
      onDone?.({ ok: false, message: err.message })
      return
    }

    // The Linear description is only ever written by a human clicking "Apply"
    // in the frontend — nothing here required that to have happened. A card
    // can reach runCard via the Driver, a raw start message, or a resumed
    // session with the description still blank or stale (confirmed live:
    // LAE-177 ran 3 real attempts with an empty description the whole time).
    // Guarantee it here instead, unconditionally, every time real step work
    // is about to begin — not optional, not skippable.
    try {
      await ensureDescriptionHasSteps(issueId, plan)
    } catch (err: any) {
      broadcast({ type: 'output', issueId, event: { kind: 'orchestrator', text: `Could not update the issue description with its step checklist: ${err.message}` } })
    }

    let usedFresh = false

    // Step metrics (step-metrics-store.ts): one row per attempt, so whether
    // this loop works can be judged from data. Never allowed to break the loop.
    const record = (row: Omit<StepAttempt, 'timestamp' | 'issueId' | 'planId' | 'stepCount'>) => {
      try {
        appendStepAttempt({ timestamp: new Date().toISOString(), issueId, planId: plan.planId, stepCount: steps.length, ...row })
      } catch (err: any) {
        console.error(`[runCard ${issueId}] step metrics write failed:`, err.message)
      }
    }
    const agentOf = (result: StartRunResult) => ({ backend: result.backend, model: modelFromRunLog(result.backend, result.logFile) })

    for (const step of steps) {
      if (step.status === 'done') continue // already verified in a prior runCard call


      while (true) {
        const stepFresh = usedFresh ? undefined : fresh
        usedFresh = true

        const builderStartedAt = Date.now()
        const result = await runCardAttempt(issueId, buildStepTask(step, steps.indexOf(step) + 1, steps.length, task), stepFresh, false, true, step.id)
        const attemptRow = {
          phase: 'step' as const,
          stepId: step.id,
          stepTitle: step.title,
          stepIndex: steps.indexOf(step) + 1,
          attempt: step.attempts + 1,
          ...agentOf(result),
          builderMs: Date.now() - builderStartedAt,
        }
        if (!result.ok) {
          record({ ...attemptRow, outcome: 'builder_failed', builderFailure: builderFailureReason(result.message), builderDetail: result.message })
          // Crash, rate limit, or an external stop — same reasoning as
          // runGauntlet's identical branch: nothing to verify yet, no
          // attempt burned.
          broadcast({ type: 'error', issueId, message: result.message, summary: result.summary, failure: builderFailureTag(result.message) })
          onDone?.(result)
          return
        }

        broadcast({ type: 'output', issueId, event: { kind: 'orchestrator', text: `Verifying step "${step.title}"…` } })
        const checkStartedAt = Date.now()
        const verdict = await verifyStep(step, projectDir, issueId, (event) => broadcast({ type: 'output', issueId, event }))
        // Same precedence verifyStep itself uses: visual, then command, then the verifier.
        const checkedRow = {
          ...attemptRow,
          checkMs: Date.now() - checkStartedAt,
          checker: step.check === 'visual' ? ('visual' as const) : step.command ? ('command' as const) : ('verifier' as const),
          verdictDetail: verdict.detail,
        }

        if (verdict.kind === 'infra') {
          record({ ...checkedRow, verdict: 'infra', outcome: 'check_infra' })
          // The check itself didn't run (missing binary, timeout, no verdict
          // from the critic) — this says nothing about whether the step is
          // actually done, so it must never burn an attempt or read as a fail.
          const message = `Could not verify step "${step.title}": ${verdict.detail}`
          await flagIncomplete(issueId, message).catch((err: any) => console.error(`[runCard ${issueId}] flag-on-infra failed:`, err.message))
          broadcast({ type: 'error', issueId, message, failure: 'check_infra' })
          onDone?.({ ok: false, message })
          return
        }

        step.attempts += 1
        step.lastFailure = verdict.pass ? undefined : verdict.detail
        setStep(plan.planId, step.id, { attempts: step.attempts, lastFailure: step.lastFailure })
        record({
          ...checkedRow,
          verdict: verdict.pass ? 'pass' : 'fail',
          outcome: verdict.pass ? 'passed' : step.attempts >= MAX_STEP_ATTEMPTS ? 'exhausted' : 'retrying',
        })

        if (verdict.pass) {
          step.status = 'done'
          setStep(plan.planId, step.id, { status: 'done' })
          break
        }

        if (step.attempts >= MAX_STEP_ATTEMPTS) {
          const doneCount = steps.filter((s) => s.status === 'done').length
          const message = `Step "${step.title}" failed verification after ${step.attempts} attempts and needs a human look. Criterion: ${step.criterion}\nLast failure: ${step.lastFailure}`
          await flagIncomplete(issueId, message).catch((err: any) => console.error(`[runCard ${issueId}] flag-on-exhaustion failed:`, err.message))
          broadcast({ type: 'error', issueId, message, failure: 'step_exhausted', steps: { done: doneCount, total: steps.length, failedStep: step.title, lastFailure: step.lastFailure } })
          onDone?.({ ok: false, message })
          return
        }
        // Attempts remain — loop again on the SAME step, with lastFailure now
        // feeding the next attempt's task via buildStepTask.
      }
    }

    // Every step independently verified — only now is it safe to let a run
    // open the PR (see buildPrompt's openPr comment for why not sooner).
    broadcast({ type: 'output', issueId, event: { kind: 'orchestrator', text: 'All steps verified — opening the PR…' } })
    const wrapUpStartedAt = Date.now()
    const wrapUp = await runCardAttempt(
      issueId,
      'Every implementation step for this card is complete and has been independently verified. There is nothing left to build — push your commits and open the PR now (or update the existing one if you already opened it earlier), per your standing rules.',
      undefined,
      true,
      false,
    )
    record({
      phase: 'wrap_up',
      ...agentOf(wrapUp),
      builderMs: Date.now() - wrapUpStartedAt,
      outcome: wrapUp.ok ? 'passed' : 'builder_failed',
      ...(wrapUp.ok ? {} : { builderFailure: builderFailureReason(wrapUp.message), builderDetail: wrapUp.message }),
    })
    if (!wrapUp.ok) {
      const message = `All steps passed verification, but opening the PR failed: ${wrapUp.message}`
      await flagIncomplete(issueId, message).catch((err: any) => console.error(`[runCard ${issueId}] flag-on-wrapup failed:`, err.message))
      broadcast({ type: 'error', issueId, message, failure: 'wrapup_failed' })
      onDone?.({ ok: false, message })
      return
    }

    broadcast({ type: 'done', issueId, exitCode: wrapUp.exitCode, summary: wrapUp.summary, steps: { done: steps.length, total: steps.length } })
    onDone?.(wrapUp)
  })()
  return true
}

function handleStart(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  const task = payload.task
  if (!issueId || !task) {
    send(ws, { type: 'error', message: 'issueId and task are required' })
    return
  }
  if (active.has(issueId)) {
    rejectBusy(ws, { issueId }, 'A task is already running for this issue')
    return
  }

  if (runCard(issueId, task, undefined, Boolean(payload.fresh))) send(ws, { type: 'started', issueId })
}

// Lets a finished run be corrected without starting over: startRun/runTask
// already resume the issue's existing implement: chat session when one
// exists, so the feedback text lands as the next turn with full context of
// what was already built, rather than a fresh describe-the-task prompt.
// Posting the comment is best-effort — a Linear hiccup here shouldn't block
// the actual re-run, same tolerance runTask already has for its own
// setStatus('In Progress') call.
function handleFeedback(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  const message = payload.message
  if (!issueId || !message) {
    send(ws, { type: 'error', message: 'issueId and message are required' })
    return
  }
  if (active.has(issueId)) {
    rejectBusy(ws, { issueId }, 'A task is already running for this issue')
    return
  }

  linear.addComment(issueId, `Feedback on this implementation:\n\n${message}`).catch((err: any) => {
    console.error(`[feedback ${issueId}] comment failed:`, err)
  })
  startRun(issueId, message)
  send(ws, { type: 'started', issueId })
}

// Stop leaves the issue's Linear status untouched — runTask already moved it
// to "In Progress" and nothing here should second-guess that; only a genuinely
// finished/blocked run changes status again, same as an ordinary completion.
function killActiveState(state: ActiveState): void {
  if (state.proc) state.proc.kill('SIGTERM')
  else if (state.pid) {
    try {
      process.kill(state.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

function stopIssueRun(issueId: string): boolean {
  const state = active.get(issueId)
  if (!state) return false
  state.stopped = true
  killActiveState(state)
  return true
}

function restartIssueRun(issueId: string): boolean {
  const state = active.get(issueId)
  if (!state) return false
  state.stopped = true
  state.pendingRestart = true
  killActiveState(state)
  return true
}

function handleStop(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  if (!issueId) return send(ws, { type: 'error', message: 'issueId is required' })
  if (!stopIssueRun(issueId)) send(ws, { type: 'error', issueId, message: 'No running task for this issue' })
}

function handleRestart(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  if (!issueId) return send(ws, { type: 'error', message: 'issueId is required' })
  if (!restartIssueRun(issueId)) send(ws, { type: 'error', issueId, message: 'No running task for this issue' })
}

// Runs one turn of a "Refine" chat. Dispatches to whichever concrete backend
// already owns this issue's session (recorded in chat-store) so a continuation
// talks to the exact same tool/session instead of re-running the free-tier
// fallback race every turn; only a brand-new chat resolves the agent choice
// fresh, the same way runTask() does for a real implementation run.
async function runRefineTurn({
  issueId,
  prompt,
  onOutput,
  onProcess,
}: {
  issueId: string
  prompt: string
  onOutput: (event: AgentEvent) => void
  onProcess?: (proc: ChildProcess, logFile: string, backend: RunBackend, sessionId: string | undefined) => void
}) {
  const issue = await linear.getIssue(issueId)
  const projectDir = resolveProjectDir(issue.project)
  await checkRequiredTools(basename(projectDir))
  const existing = getChatSession(issueId)

  let run: { exitCode: number | null; needsFallback: boolean; rateLimited?: boolean; sessionId?: string }
  let backend: ChatBackend

  // A refine turn must never write — see server/agent.ts's spawnClaude/spawnOpencode/
  // spawnKilocode for how readOnly is mechanically enforced per backend.
  if (existing?.backend === 'claude') {
    backend = 'claude'
    run = await runClaude({
      prompt,
      projectDir,
      onOutput,
      session: { id: existing.sessionId, resume: true },
      readOnly: true,
      onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, existing.sessionId),
    })
  } else if (existing?.backend === 'opencode') {
    backend = 'opencode'
    run = await runOpencode({
      prompt,
      projectDir,
      onOutput,
      sessionId: existing.sessionId,
      readOnly: true,
      onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, existing.sessionId),
    })
  } else if (existing?.backend === 'kilocode') {
    backend = 'kilocode'
    run = await runKilocode({
      prompt,
      projectDir,
      onOutput,
      sessionId: existing.sessionId,
      readOnly: true,
      onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, existing.sessionId),
    })
  } else {
    // Brand-new refine sessions are always Claude, not resolveAgentChoice's usual
    // free/Claude split: Refine now authors every step's acceptance criterion
    // (see buildConsolidatePrompt), and consolidate resumes this exact session —
    // an opencode session can't be resumed by Claude, so the split can't be
    // deferred to later either. Existing opencode/kilocode refine sessions above
    // keep resuming their own backend; only new sessions are affected.
    backend = 'claude'
    const freshId = randomUUID()
    run = await runClaude({
      prompt,
      projectDir,
      onOutput,
      session: { id: freshId, resume: false },
      readOnly: true,
      onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, freshId),
    })
  }

  if (run.needsFallback) {
    if (run.rateLimited) {
      throw new Error('OpenCode/Kilo Code hit "Rate limit exceeded" on this refine turn and could not finish. Wait for the quota to reset, or switch backend.')
    }
    throw new Error('The agent exited without producing any output for this refine turn — no real response was generated. Check the agent\'s own logs.')
  }
  if (run.sessionId) saveChatSession(issueId, backend, run.sessionId)
  return run
}

// Shared by the three refine WS handlers below: runs one turn in the background,
// streaming output the same way handleStart/runTask does for implementation runs,
// but against the separate activeRefine map since a card can only be refining or
// implementing, never both, and the two must not be confused.
function runRefine(
  issueId: string,
  buildTurnPrompt: () => Promise<string> | string,
  onDone?: (result: { ok: boolean; message: string }) => void,
  isConsolidation = false,
  // Set only for the consolidation the agent triggered itself via /ready: its
  // posted plan is written straight to Linear (what the Refine panel's Apply
  // button does), since nobody may be watching the draft box — a Driver-run
  // refine otherwise never reached Linear at all (LAE-181, LAE-182). A manual
  // "Consolidate" click still stops at the draft box for review.
  autoApply = false,
): boolean {
  if (activeRefine.has(issueId)) return false
  activeRefine.set(issueId, { issueId, lastEventAt: Date.now(), textParts: [], events: [] })
  const turnStartedAt = new Date().toISOString()

  ;(async () => {
    try {
      const prompt = await buildTurnPrompt()
      broadcast({ type: 'refine_turn_started', issueId })
      await runRefineTurn({
        issueId,
        prompt,
        onOutput: (event) => {
          const entry = activeRefine.get(issueId)
          if (entry) {
            entry.lastEventAt = Date.now()
            entry.events.push(event)
            if (event.kind === 'text') entry.textParts.push(event.text)
          }
          broadcast({ type: 'refine_output', issueId, event })
        },
        onProcess: (proc, logFile, backend, sessionId) => registerRun(issueId, 'refine', backend, sessionId, proc, logFile),
      })
      // The Driver's later ownership status-update turn (routeDriverSignal ->
      // OWNERSHIP_TRIGGER_REASONS.refine_turn_done) is the only other place this
      // run's outcome ever gets surfaced, and it has no other way to see what
      // was actually said — the transcript itself only ever lives in the
      // connected browser's state, never on the server. Without this, a
      // perfectly real, useful refine response looks indistinguishable from
      // silence to anything that isn't a live WS client.
      const summary = (activeRefine.get(issueId)?.textParts.join('') ?? '').trim()
      const trimmedSummary = summary.length > 4000 ? `${summary.slice(0, 4000)}\n… (truncated)` : summary
      // isConsolidation travels ON this same message rather than as a separate
      // earlier broadcast — a client that wasn't connected at the exact moment
      // of an earlier signal would permanently miss it (confirmed live: the
      // agent's curl call and the auto-fired consolidate turn both genuinely
      // succeeded server-side, but the browser still showed no draft-plan box
      // because it missed the one-time "about to consolidate" message). Any
      // client connected by the time THIS message arrives gets the full fact.
      let autoApplied: 'applied' | 'no_plan' | undefined
      if (autoApply) {
        // Only a plan posted during this very turn — never an older one.
        const plan = listPlansForIssue(issueId).find((p) => p.createdAt >= turnStartedAt)
        if (plan) {
          const description = plan.steps?.length ? mergeStepsIntoDescription(plan.content, plan.steps) : plan.content
          await linear.updateIssue(issueId, { description })
          await linear.setStatus(issueId, 'Todo')
          broadcast({ type: 'issue_updated', issueId })
          autoApplied = 'applied'
        } else {
          autoApplied = 'no_plan'
        }
      }
      const consolidationQueued = refineReadyToConsolidate.has(issueId)
      broadcast({ type: 'refine_turn_done', issueId, summary: trimmedSummary, isConsolidation, autoApplied, consolidationQueued })
      if (refineReadyToConsolidate.delete(issueId)) {
        // Deferred past this run's own `finally` (which hasn't executed yet —
        // we're still inside its `try` block) so the busy-check in runRefine
        // doesn't reject it as already-active.
        queueMicrotask(() => runRefine(issueId, async () => buildConsolidatePrompt(issueId, await captureParamNamesForIssue(issueId), await stepCommandPrefixForIssue(issueId)), undefined, true, true))
      }
      onDone?.({ ok: true, message: trimmedSummary || 'refine turn complete (no text output)' })
    } catch (err: any) {
      console.error(`[refine ${issueId}] failed:`, err)
      broadcast({ type: 'error', issueId, message: err.message })
      onDone?.({ ok: false, message: err.message })
    } finally {
      activeRefine.delete(issueId)
      clearActiveRun(issueId)
    }
  })()

  return true
}

function handleRefineStart(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  if (!issueId) return send(ws, { type: 'error', message: 'issueId is required' })
  const started = runRefine(issueId, async () => {
    const existing = getChatSession(issueId)
    if (existing) return RESUME_RECAP_PROMPT
    const issue = await linear.getIssue(issueId)
    const projectDir = resolveProjectDir(issue.project)
    const comments = await linear.listComments(issueId)
    return buildRefinePrompt({ issue, comments, projectDir })
  })
  if (!started) rejectBusy(ws, { issueId }, 'A refine turn is already running for this issue')
}

function handleRefineMessage(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  const message = payload.message
  if (!issueId || !message) return send(ws, { type: 'error', message: 'issueId and message are required' })
  const started = runRefine(issueId, () => `${message}\n\n${buildRefineReadyRule(issueId)}`)
  if (!started) rejectBusy(ws, { issueId }, 'A refine turn is already running for this issue')
}

function handleRefineConsolidate(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  if (!issueId) return send(ws, { type: 'error', message: 'issueId is required' })
  const started = runRefine(issueId, async () => buildConsolidatePrompt(issueId, await captureParamNamesForIssue(issueId), await stepCommandPrefixForIssue(issueId)), undefined, true)
  if (!started) rejectBusy(ws, { issueId }, 'A refine turn is already running for this issue')
}

// Mirrors runRefineTurn(), except there's no Linear issue to derive a project or
// an Agent-label choice from — the session carries its own projectId (chosen at
// creation). Unlike implementation runs and refine, ideation always starts on
// Claude: this is meant to feel like a live discussion with a coding assistant,
// not a task handed to whichever free-tier backend is available.
async function runIdeationTurn({
  sessionId,
  projectId,
  prompt,
  onOutput,
  onProcess,
  choice,
}: {
  sessionId: string
  projectId: string
  prompt: string
  onOutput: (event: AgentEvent) => void
  onProcess?: (proc: ChildProcess, logFile: string, backend: RunBackend, sessionId: string | undefined) => void
  // Claude-only: an OpenCode/Kilo-resumed session keeps its server-wide model.
  choice?: ClaudeChoice
}) {
  const projectDir = resolveProjectDir(projectId)
  await checkRequiredTools(basename(projectDir))
  const existing = getChatSession(sessionId)

  let run: { exitCode: number | null; needsFallback: boolean; rateLimited?: boolean; sessionId?: string }
  let backend: ChatBackend

  if (existing?.backend === 'claude') {
    backend = 'claude'
    run = await runClaude({
      prompt,
      projectDir,
      onOutput,
      session: { id: existing.sessionId, resume: true },
      readOnly: true,
      choice,
      onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, existing.sessionId),
    })
  } else if (existing?.backend === 'opencode') {
    backend = 'opencode'
    run = await runOpencode({
      prompt,
      projectDir,
      onOutput,
      sessionId: existing.sessionId,
      readOnly: true,
      onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, existing.sessionId),
    })
  } else if (existing?.backend === 'kilocode') {
    backend = 'kilocode'
    run = await runKilocode({
      prompt,
      projectDir,
      onOutput,
      sessionId: existing.sessionId,
      readOnly: true,
      onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, existing.sessionId),
    })
  } else {
    backend = 'claude'
    const freshId = randomUUID()
    run = await runClaude({
      prompt,
      projectDir,
      onOutput,
      session: { id: freshId, resume: false },
      readOnly: true,
      choice,
      onProcess: (proc, logFile) => onProcess?.(proc, logFile, backend, freshId),
    })
  }

  if (run.needsFallback) {
    if (run.rateLimited) {
      throw new Error('OpenCode/Kilo Code hit "Rate limit exceeded" on this ideation turn and could not finish. Wait for the quota to reset, or switch backend.')
    }
    throw new Error('The agent exited without producing any output for this ideation turn — no real response was generated. Check the agent\'s own logs.')
  }
  if (run.sessionId) saveChatSession(sessionId, backend, run.sessionId)
  return run
}

// Mirrors runRefine(), against the separate activeIdeation map keyed by session id
// (not issueId) — two different ideation sessions can run turns simultaneously
// since they don't share a lock, but the same session can't have two in flight.
function runIdeation(sessionId: string, projectId: string, choice: ClaudeChoice, buildTurnPrompt: () => Promise<string> | string): boolean {
  if (activeIdeation.has(sessionId)) return false
  activeIdeation.set(sessionId, { sessionId, events: [] })

  ;(async () => {
    try {
      const prompt = await buildTurnPrompt()
      broadcast({ type: 'ideation_turn_started', sessionId })
      await runIdeationTurn({
        sessionId,
        projectId,
        prompt,
        choice,
        onOutput: (event) => {
          activeIdeation.get(sessionId)?.events.push(event)
          broadcast({ type: 'ideation_output', sessionId, event })
        },
        onProcess: (proc, logFile, backend, backendSessionId) => registerRun(sessionId, 'ideation', backend, backendSessionId, proc, logFile),
      })
      broadcast({ type: 'ideation_turn_done', sessionId })
    } catch (err: any) {
      console.error(`[ideation ${sessionId}] failed:`, err)
      broadcast({ type: 'error', sessionId, message: err.message })
    } finally {
      activeIdeation.delete(sessionId)
      clearActiveRun(sessionId)
    }
  })()

  return true
}

const UPLOADS_DIR = join(SILLAGE_ROOT, 'uploads')

// ponytail: write-once, no cleanup — fine for a single-operator local tool;
// add a TTL sweep over UPLOADS_DIR if disk usage ever becomes real.
function saveIdeationImages(sessionId: string, images: string[]): string[] {
  if (images.length === 0) return []
  const dir = join(UPLOADS_DIR, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  mkdirSync(dir, { recursive: true })
  return images.map((dataUrl, i) => {
    const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl)
    if (!match) throw new Error('Invalid image data URL')
    const [, ext, base64] = match
    const filePath = join(dir, `${Date.now()}-${i}.${ext}`)
    writeFileSync(filePath, Buffer.from(base64, 'base64'))
    return filePath
  })
}

function handleIdeationMessage(ws: WebSocket, payload: any) {
  const sessionId = payload.sessionId
  const projectId = payload.projectId
  const message: string = payload.message || ''
  const images: string[] = Array.isArray(payload.images) ? payload.images : []
  if (!sessionId || !projectId || (!message.trim() && images.length === 0)) {
    return send(ws, { type: 'error', message: 'sessionId, projectId, and a message or image are required' })
  }
  const started = runIdeation(sessionId, projectId, parseClaudeChoice(payload), async () => {
    const paths = saveIdeationImages(sessionId, images)
    const imageNote = paths.length > 0 ? `\n\n[Attached image(s) — use the Read tool to view them before responding]\n${paths.map((p) => `- ${p}`).join('\n')}` : ''
    const existing = getChatSession(sessionId)
    if (existing) return `${message}${imageNote}`
    const framing = await buildIdeationPrompt({ projectDir: resolveProjectDir(projectId), synthesis: getSynthesis(projectId) })
    return `${framing}\n\n---\n\nThe user's first message:\n${message}${imageNote}`
  })
  if (!started) rejectBusy(ws, { sessionId }, 'A turn is already running for this session')
}

// Mirrors runIdeationTurn(), but always on Claude — the Driver is a genuine
// interactive role, not a free-tier-fallback task, same reasoning as ideation.
async function runDriverTurn({
  sessionId,
  projectId,
  prompt,
  onOutput,
  onProcess,
}: {
  sessionId: string
  projectId: string
  prompt: string
  onOutput: (event: AgentEvent) => void
  onProcess?: (proc: ChildProcess, logFile: string, sessionId: string) => void
}) {
  const projectDir = resolveProjectDir(projectId)
  await checkRequiredTools(basename(projectDir))
  const existing = getChatSession(sessionId)
  const freshId = randomUUID()
  const claudeSessionId = existing?.backend === 'claude' ? existing.sessionId : freshId
  const run = existing?.backend === 'claude'
    ? await runClaude({
        prompt,
        projectDir,
        onOutput,
        session: { id: existing.sessionId, resume: true },
        readOnly: true,
        onProcess: (proc, logFile) => onProcess?.(proc, logFile, claudeSessionId),
      })
    : await runClaude({
        prompt,
        projectDir,
        onOutput,
        session: { id: freshId, resume: false },
        readOnly: true,
        onProcess: (proc, logFile) => onProcess?.(proc, logFile, claudeSessionId),
      })

  if (run.needsFallback) {
    throw new Error('The agent exited without producing any output for this Driver turn — no real response was generated. Check the agent\'s own logs.')
  }
  if (run.sessionId) saveChatSession(sessionId, 'claude', run.sessionId)
  return run
}

function broadcastOwnership(sessionId: string) {
  broadcast({ type: 'driver_ownership_changed', sessionId, ownedIssueIds: [...(driverOwnership.get(sessionId) ?? [])] })
}

// Last claim wins if two sessions somehow target the same card — Driver
// sessions per project are a deliberate, infrequent user action, not
// something expected to run many of concurrently against the same cards.
function claimOwnership(sessionId: string, issueId: string) {
  const previousOwner = issueOwner.get(issueId)
  if (previousOwner && previousOwner !== sessionId) {
    driverOwnership.get(previousOwner)?.delete(issueId)
    broadcastOwnership(previousOwner)
  }
  if (!driverOwnership.has(sessionId)) driverOwnership.set(sessionId, new Set())
  driverOwnership.get(sessionId)!.add(issueId)
  issueOwner.set(issueId, sessionId)
  driverRepromptCount.set(issueId, 0)
  broadcastOwnership(sessionId)
}

function releaseOwnership(sessionId: string, issueId: string): boolean {
  const owned = driverOwnership.get(sessionId)
  if (!owned?.has(issueId)) return false
  owned.delete(issueId)
  issueOwner.delete(issueId)
  driverRepromptCount.delete(issueId)
  broadcastOwnership(sessionId)
  return true
}

function scheduleDriverEvent(sessionId: string, event: DriverPendingEvent) {
  const list = pendingDriverEvents.get(sessionId) ?? []
  list.push(event)
  pendingDriverEvents.set(sessionId, list)
  if (driverDebounceTimer.has(sessionId)) return
  driverDebounceTimer.set(
    sessionId,
    setTimeout(() => {
      driverDebounceTimer.delete(sessionId)
      flushDriverEvents(sessionId)
    }, DRIVER_DEBOUNCE_MS),
  )
}

// No-ops while a turn is already running for this session — runDriver's own
// tail-drain (see its end) retries once that turn finishes, so nothing gets
// silently dropped, just delayed.
async function flushDriverEvents(sessionId: string) {
  if (activeDriver.has(sessionId)) return
  const pending = pendingDriverEvents.get(sessionId)
  if (!pending?.length) return
  pendingDriverEvents.delete(sessionId)
  const projectId = driverSessionProject.get(sessionId)
  if (!projectId) return

  const ownershipEvents = pending.filter((e): e is Extract<DriverPendingEvent, { kind: 'ownership' }> => e.kind === 'ownership')
  if (ownershipEvents.length > 0) {
    await runOwnershipUpdateTurn(sessionId, projectId, ownershipEvents)
    return
  }
  const owned = driverOwnership.get(sessionId)
  if (!owned || owned.size < AUTONOMOUS_OWNED_CAP) runAutonomousScan(sessionId, projectId)
}

const OWNERSHIP_TRIGGER_REASONS: Record<string, (payload: any) => string> = {
  issue_updated: () => 'The card was updated (status/fields changed, possibly by hand).',
  pr_created: (p) => `A pull request was opened: ${p.prUrl}`,
  done: (p) => {
    // runCard concluded a step-split card — every step was independently
    // verified (not just "the run exited 0"), which is a stronger signal
    // than the plain exit-code fallback below, so it replaces it entirely
    // rather than adding to it.
    if (p.steps) {
      return `The implementation completed all ${p.steps.total} step(s) of its plan, each independently verified. Proceed on the card's own merits (review, PR, merge).`
    }
    // A gauntlet concluded — this replaces the plain exit-code reason
    // entirely, not adds to it, because the whole point is that "exit code
    // 0" is not a trustworthy signal on its own for an issue with a design
    // bar; the critique's verdict is the actual answer.
    if (p.critique?.winner === 'ours') {
      return `The implementation ran and an independent visual critic — comparing a screenshot of the running app against the design mockup, blind — picked the app's version after ${p.critique.rounds} round(s). The visual bar is met. Proceed on the card's own merits (review, PR, merge).`
    }
    if (p.critique?.exhausted) {
      return `The implementation ran ${p.critique.rounds} round(s) against its design mockup and an independent visual critic still preferred the mockup every time. Last remaining gap: ${p.critique.gap}\n\nThis card has been flagged for human review — do NOT merge it and do NOT propose implementing it again. Release it and say why.`
    }
    return p.summary
      ? `The implementation run finished (exit code ${p.exitCode}). Here's what the agent said:\n\n${p.summary}`
      : `The implementation run finished (exit code ${p.exitCode}) with no narrated text — check git log/diff and the agent's own logs.`
  },
  stopped: () => 'The implementation run was stopped.',
  error: (p) =>
    p.failure === 'step_exhausted'
      ? buildStepExhaustedReason(p)
      : p.summary
      ? `The run failed: ${p.message}\n\nWhat the agent said before failing:\n\n${p.summary}`
      : `The run failed: ${p.message}`,
  refine_turn_done: (p) => {
    // A /ready-triggered consolidation writes Linear itself (see runRefine) —
    // say so outright, or the Driver checks Linear too early and calls it lost.
    if (p.autoApplied === 'applied') {
      return `Refine consolidated the plan and it has been written to the issue: the description now holds the final plan with its steps, and the status moved to Todo. The card is ready to implement.`
    }
    if (p.consolidationQueued) {
      return `The refine agent marked its plan ready. A consolidation turn is starting now: it writes the final description and steps, dry-runs each step's command, then writes the plan to Linear and moves the card to Todo — usually several minutes. Linear won't change before that finishes, so don't check it or retry yet; you'll get another update when it's done. What the agent said:\n\n${p.summary || '(no text output)'}`
    }
    if (p.autoApplied === 'no_plan') {
      return `The refine agent marked its plan ready, but the consolidation turn posted no plan, so nothing was written to Linear. What it said:\n\n${p.summary || '(no text output)'}`
    }
    return p.summary
      ? `A refine discussion turn finished. Here's what the agent said:\n\n${p.summary}`
      : 'A refine discussion turn finished with no text output — check the agent\'s own logs.'
  },
  stall_detected: (p) => `No activity for ${Math.round(p.thresholdMs / 1000)}s — may be stuck.`,
}
const BOARD_TRIGGER_TYPES = new Set(['issue_created', 'issue_updated'])

// The single dispatch point every server-side event already flows through
// (broadcast()) doubles as the Driver's event source — no separate polling of
// Linear or the WS stream needed. issue_removed releases directly (nothing
// left to check, no LLM turn needed); other ownership-relevant events queue
// a debounced status-update turn; issue_created/issue_updated also wake any
// idle autonomous session under its owned-card cap.
async function routeDriverSignal(payload: Record<string, unknown>) {
  const type = payload.type as string
  const issueId = payload.issueId as string | undefined

  if (type === 'issue_removed' && issueId) {
    const owner = issueOwner.get(issueId)
    if (owner) releaseOwnership(owner, issueId)
    return
  }
  if (issueId) {
    const reasonFn = OWNERSHIP_TRIGGER_REASONS[type]
    // A bare "issue_updated" fires on every field change, including the
    // orchestrator's own In Progress transitions (runTask starting an
    // implement run, flagIncomplete sending a card back) — the Driver
    // already knows it caused those, so re-notifying it is pure noise, one
    // wasted LLM turn per action. Skip just the ownership trigger (not the
    // board-scan wake below, which is a cheap, unrelated nudge) while the
    // card is currently sitting in In Progress, regardless of what
    // specifically changed or who/what changed it.
    const isSelfDrivenInProgress =
      type === 'issue_updated' &&
      (await linear.getIssue(issueId).then((i) => i.status === 'In Progress').catch(() => false))
    if (reasonFn && !isSelfDrivenInProgress) {
      const owner = issueOwner.get(issueId)
      if (owner) {
        let reason = reasonFn(payload)
        // pr_created's own reason already states the PR fresh — appending here
        // too would be redundant. Every OTHER trigger for an issue that already
        // has a known PR (done, error, stall_detected, a later issue_updated...)
        // previously said nothing about it, so on a second/third iteration —
        // restart after review feedback, a stall while pushing a fix — the
        // Driver had no way to know a PR already existed unless it happened to
        // still be in context from whenever pr_created originally fired,
        // possibly many turns and other cards ago. It would keep treating "no
        // PR mentioned in this turn" as "no PR exists yet."
        const existingPr = type !== 'pr_created' ? issuePrUrl.get(issueId) : undefined
        if (existingPr) reason += `\n\n(This issue already has an open PR: ${existingPr} — the Implementer pushing more commits to the same branch on a re-run is expected, not a sign nothing happened. Don't wait for a new PR to be opened; check this one's status if unsure.)`
        scheduleDriverEvent(owner, { kind: 'ownership', issueId, reason })
      }
    }
  }
  if (BOARD_TRIGGER_TYPES.has(type)) {
    for (const [sessionId, mode] of driverSessionMode) {
      if (mode !== 'autonomous' || activeDriver.has(sessionId)) continue
      const owned = driverOwnership.get(sessionId)
      if (owned && owned.size >= AUTONOMOUS_OWNED_CAP) continue
      if (driverSessionProject.has(sessionId)) scheduleDriverEvent(sessionId, { kind: 'board_scan' })
    }
  }
}

const DRIVER_ACTIONS_BLOCK = /```json\s*([\s\S]*?)```/i
const DRIVER_ACTION_KINDS: DriverActionKind[] = ['refine', 'implement', 'stop', 'restart', 'release', 'merge', 'flag', 'create']

// Same fenced-json-block convention as the old candidate extraction, now
// parsed server-side since Driver actions fire without a client round-trip.
function parseDriverActions(text: string): DriverAction[] {
  const match = DRIVER_ACTIONS_BLOCK.exec(text)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[1])
    if (!Array.isArray(parsed)) return []
    const actions: DriverAction[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const action = (item as any).action
      if (!DRIVER_ACTION_KINDS.includes(action)) continue
      // 'create' has no existing issue yet — title is its required field,
      // in place of issueId, which every other kind needs.
      if (action === 'create') {
        const title = typeof (item as any).title === 'string' ? (item as any).title.trim() : ''
        if (!title) continue
        const description = typeof (item as any).description === 'string' ? (item as any).description : undefined
        actions.push({ action, title, description })
        continue
      }
      const issueId = (item as any).issueId
      if (typeof issueId !== 'string' || !issueId) continue
      const task = typeof (item as any).task === 'string' ? (item as any).task : undefined
      const reason = typeof (item as any).reason === 'string' ? (item as any).reason : undefined
      const message = typeof (item as any).message === 'string' ? (item as any).message : undefined
      actions.push({ action, issueId, task, reason, message })
    }
    return actions.slice(0, MAX_ACTIONS_PER_TURN)
  } catch {
    return []
  }
}

function startDriverRefine(issueId: string, message?: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const started = runRefine(
      issueId,
      async () => {
        const existing = getChatSession(issueId)
        // A message only means something once there's an actual discussion to
        // reply into — mirrors handleRefineMessage's own construction exactly,
        // so the Refiner can't tell whether a human or the Driver sent it.
        if (existing && message) return `${message}\n\n${buildRefineReadyRule(issueId)}`
        if (existing) return RESUME_RECAP_PROMPT
        const issue = await linear.getIssue(issueId)
        const comments = await linear.listComments(issueId)
        return buildRefinePrompt({ issue, comments, projectDir: resolveProjectDir(issue.project) })
      },
      resolve,
    )
    if (!started) resolve({ ok: false, message: `A refine turn is already running for ${issueId} — skipped.` })
  })
}

function startDriverImplement(issueId: string, task: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    if (active.has(issueId)) return resolve({ ok: false, message: `${issueId} already has a run in progress — skipped.` })
    runCard(issueId, task, resolve)
  })
}

// Orchestrator-executed, never through the Driver's own sandboxed subprocess —
// mirrors how refine/implement/stop/restart already work: the Driver only ever
// proposes via the action block, this function does the real work. On
// success, moves Linear straight to Done (same philosophy as runTask()
// setting 'In Progress' itself) which reuses the existing issue_updated
// ownership-trigger path to auto-release the card, no new trigger needed.
async function mergePr(issueId: string, projectId: string): Promise<{ ok: boolean; message: string }> {
  const prUrl = issuePrUrl.get(issueId)
  if (!prUrl) return { ok: false, message: 'no tracked PR for this issue' }
  const projectDir = resolveProjectDir(projectId)
  const result = await new Promise<{ ok: boolean; message: string }>((resolve) => {
    execFile('gh', ['pr', 'merge', prUrl, '--squash', '--delete-branch'], { cwd: projectDir, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, message: (stderr || err.message).trim().slice(0, 500) })
      resolve({ ok: true, message: stdout.trim() || 'merged' })
    })
  })
  if (result.ok) {
    try {
      await linear.setStatus(issueId, 'Done')
      broadcast({ type: 'issue_updated', issueId })
    } catch (err: any) {
      console.error(`[merge ${issueId}] merged but failed to set Linear status to Done:`, err.message)
    }
  }
  return result
}

// Orchestrator-executed, like mergePr above — sends a card found to be
// wrongly/incompletely implemented back to In Progress (not Backlog/Todo,
// since a PR/implementation attempt usually already exists) with the Driver's
// reasoning left as a real Linear comment, since buildPrompt already
// surfaces comments as context to the next refine/implement pass.
async function flagIncomplete(issueId: string, reason: string): Promise<{ ok: boolean; message: string }> {
  await linear.setStatus(issueId, 'In Progress')
  await linear.addComment(issueId, `Sent back to In Progress — ${reason}`)
  broadcast({ type: 'issue_updated', issueId })
  return { ok: true, message: 'flagged and sent back to In Progress' }
}

type DriverActionResult = { action: DriverActionKind; issueId?: string; ok: boolean; message: string }

// Runs a parsed action list sequentially, genuinely waiting for each real
// completion (via startDriverRefine/startDriverImplement's onDone) before the next
// step fires. Halts on the first skipped/failed step rather than pressing on
// past an evidently-wrong plan. Returns the last attempted action's result
// (or null if the list was empty) so the caller can build an autonomous
// status-update re-prompt from it.
async function executeDriverActions(sessionId: string, projectId: string, actions: DriverAction[]): Promise<DriverActionResult | null> {
  let last: DriverActionResult | null = null

  for (const action of actions) {
    if (driverSessionMode.get(sessionId) === 'autonomous') {
      const used = driverAutonomyBudget.get(sessionId) ?? 0
      if (used >= MAX_AUTONOMOUS_ACTIONS_PER_ACTIVATION) {
        driverSessionMode.set(sessionId, 'manual')
        broadcast({ type: 'driver_mode_changed', sessionId, mode: 'manual', reason: 'Autonomous action cap reached — switching back to manual.' })
        return last
      }
      driverAutonomyBudget.set(sessionId, used + 1)
    }

    // create has no existing issue to fetch/verify — it makes one, then joins
    // the ownership model like every other kind (the Driver watches what it
    // just filed the same way it watches a card it proposed refine/implement
    // on).
    if (action.action === 'create') {
      if (!action.title) {
        last = { action: 'create', ok: false, message: 'create action missing title' }
        broadcast({ type: 'driver_action', sessionId, action: 'create', status: 'failed', message: last.message })
        return last
      }
      broadcast({ type: 'driver_action', sessionId, action: 'create', status: 'started' })
      try {
        const issue = await linear.createIssue({ title: action.title, description: action.description, projectId })
        claimOwnership(sessionId, issue.id)
        const message = `created ${issue.id}: ${issue.title}`
        broadcast({ type: 'driver_action', sessionId, action: 'create', issueId: issue.id, status: 'done', message })
        last = { action: 'create', issueId: issue.id, ok: true, message }
      } catch (err: any) {
        const message = err.message || 'failed to create issue'
        broadcast({ type: 'driver_action', sessionId, action: 'create', status: 'failed', message })
        last = { action: 'create', ok: false, message }
        return last
      }
      continue
    }

    // Every kind below operates on an existing issue — parseDriverActions
    // guarantees issueId is set for all of them (only 'create', handled
    // above, omits it). Bound to a const so the narrowing survives into the
    // closure below (TS doesn't carry a plain property-access narrowing
    // across a nested function boundary).
    if (!action.issueId) continue
    const issueId = action.issueId

    // release has no real-world side effect and no need to re-verify project
    // membership — deliberately doesn't halt the chain on failure (unlike
    // every other kind below) since "wasn't actually owned" isn't a
    // meaningful error worth stopping subsequent steps over.
    if (action.action === 'release') {
      const ok = releaseOwnership(sessionId, issueId)
      const message = action.reason || '(no reason given)'
      broadcast({ type: 'driver_action', sessionId, action: 'release', issueId, status: ok ? 'done' : 'skipped', message })
      last = { action: 'release', issueId, ok, message }
      continue
    }

    let issue
    try {
      issue = await linear.getIssue(issueId)
    } catch {
      broadcast({ type: 'driver_action', sessionId, action: action.action, issueId, status: 'skipped', message: 'issue not found' })
      last = { action: action.action, issueId, ok: false, message: 'issue not found' }
      return last
    }
    if (issue.project !== projectId) {
      broadcast({ type: 'driver_action', sessionId, action: action.action, issueId, status: 'skipped', message: 'belongs to a different project than this session' })
      last = { action: action.action, issueId, ok: false, message: 'belongs to a different project than this session' }
      return last
    }

    // Claim ownership for every dispatchable kind, including stop/restart —
    // restarting a card implies the Driver still cares about it finishing.
    claimOwnership(sessionId, issueId)
    broadcast({ type: 'driver_action', sessionId, action: action.action, issueId, status: 'started' })
    const result: { ok: boolean; message: string } = await (async () => {
      switch (action.action) {
        case 'refine':
          return startDriverRefine(issueId, action.message)
        case 'implement':
          return action.task ? startDriverImplement(issueId, action.task) : { ok: false, message: 'implement action missing task' }
        case 'stop': {
          const ok = stopIssueRun(issueId)
          return { ok, message: ok ? 'stopped' : 'no active run for this issue to stop' }
        }
        case 'restart': {
          const ok = restartIssueRun(issueId)
          return { ok, message: ok ? 'restart requested' : 'no active run for this issue to restart' }
        }
        case 'merge':
          return mergePr(issueId, projectId)
        case 'flag':
          return flagIncomplete(issueId, action.reason || '(no reason given)')
        default:
          return { ok: false, message: `unsupported action: ${action.action}` }
      }
    })()
    broadcast({ type: 'driver_action', sessionId, action: action.action, issueId, status: result.ok ? 'done' : 'failed', message: result.message })
    if (!result.ok) {
      // driver_action isn't one of OWNERSHIP_TRIGGER_REASONS' event types — on
      // success that's correct (re-notifying the Driver of its own action would
      // be pure noise), but on failure it means the Driver has no other way to
      // find out. restartIssueRun/stopIssueRun returning false, or a rejected
      // startDriverRefine/startDriverImplement/mergePr/flagIncomplete, never
      // reaches a runTask that could later broadcast 'error' — the request
      // simply never took effect. Without this, the Driver believes a restart
      // is now underway and waits indefinitely for a run that never started.
      scheduleDriverEvent(sessionId, { kind: 'ownership', issueId, reason: `Your ${action.action} action failed: ${result.message}` })
    }
    last = { action: action.action, issueId, ...result }
    if (!result.ok) return last
  }

  return last
}

// Fresh per-card check before ever spending an LLM call: auto-releases
// cards that already reached Done, and force-releases ones that have
// looped past the reprompt watchdog without resolving. Only calls into
// runDriver (a real LLM turn) for whatever's left after those two passes.
async function runOwnershipUpdateTurn(
  sessionId: string,
  projectId: string,
  events: Extract<DriverPendingEvent, { kind: 'ownership' }>[],
) {
  const reasonsByIssue = new Map<string, string[]>()
  for (const e of events) reasonsByIssue.set(e.issueId, [...(reasonsByIssue.get(e.issueId) ?? []), e.reason])

  const resolved = await Promise.all(
    [...reasonsByIssue].map(async ([issueId, reasons]) => {
      const status = await linear
        .getIssue(issueId)
        .then((i) => i.status)
        .catch(() => 'unknown')
      return { issueId, status, reason: reasons.join('; ') }
    }),
  )

  const stillActive: typeof resolved = []
  for (const u of resolved) {
    if (u.status === 'Done') {
      releaseOwnership(sessionId, u.issueId)
      broadcast({ type: 'driver_action', sessionId, action: 'release', issueId: u.issueId, status: 'done', message: 'auto-released — reached Done' })
      continue
    }
    const count = (driverRepromptCount.get(u.issueId) ?? 0) + 1
    driverRepromptCount.set(u.issueId, count)
    if (count > MAX_OWNERSHIP_REPROMPTS_PER_CARD) {
      // Escalate to a human instead of silently abandoning the card — it went
      // through 20 status-update turns without reaching Done, which is exactly
      // the kind of stuck state a Driver watching quietly would otherwise hide.
      await flagIncomplete(
        u.issueId,
        `Sillage carried this card through ${MAX_OWNERSHIP_REPROMPTS_PER_CARD} status-update turns without it reaching Done. Needs a human look.`,
      ).catch((err) => console.error(`[driver ${sessionId}] flag-on-exhaustion failed:`, err.message))
      releaseOwnership(sessionId, u.issueId)
      broadcast({
        type: 'driver_action',
        sessionId,
        action: 'flag',
        issueId: u.issueId,
        status: 'done',
        escalated: true,
        message: `escalated for human review — exceeded ${MAX_OWNERSHIP_REPROMPTS_PER_CARD} status-update turns without reaching Done`,
      })
      continue
    }
    stillActive.push(u)
  }

  if (stillActive.length === 0) return
  // An ownership event is itself an activation — MAX_AUTONOMOUS_ACTIONS_PER_ACTIVATION
  // is meant to bound one activation's worth of actions, not the whole lifetime
  // of a session that's only ever woken by ownership triggers. Without this,
  // budget accumulates silently across turns here (never reset) and eventually
  // force-flips an otherwise-healthy autonomous session to manual for no
  // reason visible to the user.
  driverAutonomyBudget.set(sessionId, 0)
  runDriver(sessionId, projectId, () => buildDriverOwnershipUpdatePrompt(stillActive, [...(driverOwnership.get(sessionId) ?? [])]))
}

// Idle-rescan for autonomous mode — woken either by routeDriverSignal reacting
// to a board change, or by the periodic backstop timer near the bottom of
// this file. Deliberately skips discussionContext (only available on the
// explicit driver_set_mode toggle-on, which comes from the client) — backlog
// alone is a reasonable degradation for a re-scan the user didn't trigger.
function runAutonomousScan(sessionId: string, projectId: string) {
  driverAutonomyBudget.set(sessionId, 0)
  runDriver(sessionId, projectId, async () => {
    const projectDir = resolveProjectDir(projectId)
    const allIssues = await linear.listIssues()
    const backlog = allIssues.filter((i) => i.project === projectId)
    return buildDriverFirstTurnPrompt({ mode: 'autonomous', projectDir, backlog })
  })
}

// Mirrors runIdeation()/runRefine(), against the separate activeDriver map.
// After a turn completes, executes any proposed action block, then drains
// any ownership/board-scan events queued while the turn was running — see
// routeDriverSignal/scheduleDriverEvent for how those get queued, and
// runOwnershipUpdateTurn/runAutonomousScan for what draining them does.
// Mode-agnostic on purpose: manual mode inherits the same watch loop as
// autonomous with no special-casing, since a card only needs to be claimed
// once (by executeDriverActions) for the loop to pick it up either way.
function runDriver(sessionId: string, projectId: string, buildTurnPrompt: () => Promise<string> | string): boolean {
  if (activeDriver.has(sessionId)) return false
  activeDriver.set(sessionId, { sessionId, events: [] })

  ;(async () => {
    let assistantText = ''
    let turnFailed = false
    try {
      const prompt = await buildTurnPrompt()
      broadcast({ type: 'driver_turn_started', sessionId })
      await runDriverTurn({
        sessionId,
        projectId,
        prompt,
        onOutput: (event) => {
          if (event.kind === 'text') assistantText += event.text
          activeDriver.get(sessionId)?.events.push(event)
          broadcast({ type: 'driver_output', sessionId, event })
        },
        onProcess: (proc, logFile, backendSessionId) => registerRun(sessionId, 'driver', 'claude', backendSessionId, proc, logFile, projectId),
      })
      broadcast({ type: 'driver_turn_done', sessionId })
    } catch (err: any) {
      console.error(`[em ${sessionId}] failed:`, err)
      broadcast({ type: 'error', sessionId, message: err.message })
      turnFailed = true
    } finally {
      clearActiveRun(sessionId)
    }
    if (turnFailed) {
      activeDriver.delete(sessionId)
      return
    }

    const actions = parseDriverActions(assistantText)
    await executeDriverActions(sessionId, projectId, actions)

    // Released only now, after the whole turn — LLM decision AND the actions
    // it proposed — has actually finished, not right after the LLM call like
    // before. That earlier release let a second ownership/board-scan event
    // sail past flushDriverEvents' activeDriver.has() guard and fire an
    // independent second turn while this one's own action (e.g. a real
    // implement run via executeDriverActions) was still executing — the
    // mechanism behind the Driver firing two Implementers on the same project
    // at once. The per-project queue in runTask already makes that safe, but
    // this stops the Driver from wastefully racing itself in the first place.
    activeDriver.delete(sessionId)

    // Drain any ownership/board-scan events that queued up while this turn
    // was running (scheduleDriverEvent's debounce timer no-ops while activeDriver
    // holds the lock — flushDriverEvents' own no-op guard needs the lock already
    // released by this point, which is why this comes after the delete above).
    if (pendingDriverEvents.get(sessionId)?.length) {
      const timer = driverDebounceTimer.get(sessionId)
      if (timer) {
        clearTimeout(timer)
        driverDebounceTimer.delete(sessionId)
      }
      flushDriverEvents(sessionId)
    }
  })()

  return true
}

function handleDriverMessage(ws: WebSocket, payload: any) {
  const sessionId = payload.sessionId
  const projectId = payload.projectId
  const message: string = payload.message || ''
  const images: string[] = Array.isArray(payload.images) ? payload.images : []
  if (!sessionId || !projectId || (!message.trim() && images.length === 0)) {
    return send(ws, { type: 'error', message: 'sessionId, projectId, and a message or image are required' })
  }
  if (!driverSessionMode.has(sessionId)) driverSessionMode.set(sessionId, 'manual')
  driverSessionProject.set(sessionId, projectId)
  const started = runDriver(sessionId, projectId, async () => {
    const paths = saveIdeationImages(sessionId, images)
    const imageNote = paths.length > 0 ? `\n\n[Attached image(s) — use the Read tool to view them before responding]\n${paths.map((p) => `- ${p}`).join('\n')}` : ''
    const existing = getChatSession(sessionId)
    if (existing) return `${message}${imageNote}`
    const framing = await buildDriverFirstTurnPrompt({ mode: 'manual', projectDir: resolveProjectDir(projectId) })
    return `${framing}\n\n---\n\nThe user's first message:\n${message}${imageNote}`
  })
  if (!started) rejectBusy(ws, { sessionId }, 'A turn is already running for this session')
}

// Switching to autonomous always fires one fresh turn immediately (per "act
// immediately once you say so") — backlog + past-discussion context are
// gathered fresh on every activation, not just the session's first message.
function handleDriverSetMode(ws: WebSocket, payload: any) {
  const sessionId = payload.sessionId
  const projectId = payload.projectId
  const mode: DriverMode = payload.mode === 'autonomous' ? 'autonomous' : 'manual'
  const discussionContext: string | undefined = typeof payload.discussionContext === 'string' ? payload.discussionContext : undefined
  if (!sessionId || !projectId) return send(ws, { type: 'error', message: 'sessionId and projectId are required' })

  driverSessionMode.set(sessionId, mode)
  driverSessionProject.set(sessionId, projectId)
  broadcast({ type: 'driver_mode_changed', sessionId, mode })
  if (mode !== 'autonomous') return

  driverAutonomyBudget.set(sessionId, 0)
  const started = runDriver(sessionId, projectId, async () => {
    const projectDir = resolveProjectDir(projectId)
    const allIssues = await linear.listIssues()
    const backlog = allIssues.filter((i) => i.project === projectId)
    return buildDriverFirstTurnPrompt({ mode: 'autonomous', projectDir, backlog, discussionContext })
  })
  if (!started) rejectBusy(ws, { sessionId }, 'A turn is already running for this session')
}

// Linked sessions get a stable per-issue folder the implement run can find
// later; unlinked drafts are keyed by session id until an issue exists.
// Shared by the turn, the preview endpoint, and the commit — all three must
// agree on where a given session's mockup lives.
function resolveDesignDir(projectId: string, sessionId: string, issueId?: string): string {
  const projectDir = resolveProjectDir(projectId)
  const leaf = issueId ?? `_drafts/${sessionId.replace('design:', '').slice(0, 8)}`
  return join(projectDir, 'design', leaf)
}

// Mirrors runDriverTurn() — always Claude, never opencode/kilocode, since the
// SILLAGE_DESIGN_DIR write-scoping guarantee (spawnClaude/guard-scope.js) only
// exists for the Claude path.
async function runDesignTurn({
  sessionId,
  projectId,
  designDir,
  prompt,
  onOutput,
  onProcess,
  choice,
}: {
  sessionId: string
  projectId: string
  designDir: string
  prompt: string
  onOutput: (event: AgentEvent) => void
  onProcess?: (proc: ChildProcess, logFile: string, sessionId: string) => void
  choice?: ClaudeChoice
}) {
  const projectDir = resolveProjectDir(projectId)
  await checkRequiredTools(basename(projectDir))
  mkdirSync(designDir, { recursive: true })
  const existing = getChatSession(sessionId)
  const freshId = randomUUID()
  const claudeSessionId = existing?.backend === 'claude' ? existing.sessionId : freshId
  const run = existing?.backend === 'claude'
    ? await runClaude({
        prompt,
        projectDir,
        onOutput,
        session: { id: existing.sessionId, resume: true },
        designDir,
        choice,
        onProcess: (proc, logFile) => onProcess?.(proc, logFile, claudeSessionId),
      })
    : await runClaude({
        prompt,
        projectDir,
        onOutput,
        session: { id: freshId, resume: false },
        designDir,
        choice,
        onProcess: (proc, logFile) => onProcess?.(proc, logFile, claudeSessionId),
      })

  if (run.needsFallback) {
    throw new Error('The agent exited without producing any output for this design turn — no real response was generated. Check the agent\'s own logs.')
  }
  if (run.sessionId) saveChatSession(sessionId, 'claude', run.sessionId)
  return run
}

// Mirrors runIdeation()/runDriver(), against the separate activeDesign map.
function runDesign(sessionId: string, projectId: string, designDir: string, choice: ClaudeChoice, buildTurnPrompt: () => Promise<string> | string): boolean {
  if (activeDesign.has(sessionId)) return false
  activeDesign.set(sessionId, { sessionId, events: [] })

  ;(async () => {
    try {
      const prompt = await buildTurnPrompt()
      broadcast({ type: 'design_turn_started', sessionId })
      await runDesignTurn({
        sessionId,
        projectId,
        designDir,
        prompt,
        choice,
        onOutput: (event) => {
          activeDesign.get(sessionId)?.events.push(event)
          broadcast({ type: 'design_output', sessionId, event })
        },
        onProcess: (proc, logFile, backendSessionId) => registerRun(sessionId, 'design', 'claude', backendSessionId, proc, logFile),
      })
      broadcast({ type: 'design_turn_done', sessionId })
    } catch (err: any) {
      console.error(`[design ${sessionId}] failed:`, err)
      broadcast({ type: 'error', sessionId, message: err.message })
    } finally {
      activeDesign.delete(sessionId)
      clearActiveRun(sessionId)
    }
  })()

  return true
}

function handleDesignMessage(ws: WebSocket, payload: any) {
  const sessionId = payload.sessionId
  const projectId = payload.projectId
  const message: string = payload.message || ''
  const images: string[] = Array.isArray(payload.images) ? payload.images : []
  if (!sessionId || !projectId || (!message.trim() && images.length === 0)) {
    return send(ws, { type: 'error', message: 'sessionId, projectId, and a message or image are required' })
  }
  const issueId = designIssueFor(payload.issueId, designSessionIssue.get(sessionId))
  if (issueId) designSessionIssue.set(sessionId, issueId)
  const designDir = resolveDesignDir(projectId, sessionId, issueId)
  const started = runDesign(sessionId, projectId, designDir, parseClaudeChoice(payload), async () => {
    const paths = saveIdeationImages(sessionId, images)
    const imageNote = paths.length > 0 ? `\n\n[Attached image(s) — use the Read tool to view them before responding]\n${paths.map((p) => `- ${p}`).join('\n')}` : ''
    const existing = getChatSession(sessionId)
    if (existing) return designTurnMessage(`${message}${imageNote}`, designDir)
    const issue = issueId ? await linear.getIssue(issueId) : undefined
    const projectDir = resolveProjectDir(projectId)
    const viewport = captureConfigFor(basename(projectDir))?.viewport
    const framing = buildDesignPrompt({ projectDir, designDir, issue, synthesis: getSynthesis(projectId), viewport })
    return `${framing}\n\n---\n\nThe user's first message:\n${message}${imageNote}`
  })
  if (!started) rejectBusy(ws, { sessionId }, 'A turn is already running for this session')
}

// Renames an existing draft folder into place under the issue's own id so the
// agent never has to know its output moved — the next turn just keeps
// writing to the same designDir it always has (resolveDesignDir now resolves
// it to the new path via designSessionIssue).
function handleDesignLinkIssue(ws: WebSocket, payload: any) {
  const sessionId = payload.sessionId
  const projectId = payload.projectId
  const issueId = payload.issueId
  if (!sessionId || !projectId || !issueId) {
    return send(ws, { type: 'error', message: 'sessionId, projectId, and issueId are required' })
  }
  const previousDir = resolveDesignDir(projectId, sessionId, designSessionIssue.get(sessionId))
  const newDir = resolveDesignDir(projectId, sessionId, issueId)
  const plan = planDesignLink(previousDir, newDir, existsSync, payload.replace === true)
  // The issue already has a mockup: ask before overwriting it (the frontend confirms, then resends with replace).
  if (plan === 'conflict') return send(ws, { type: 'design_link_conflict', sessionId, issueId })
  if (plan === 'replace') rmSync(newDir, { recursive: true, force: true })
  if (plan === 'move' || plan === 'replace') {
    mkdirSync(dirname(newDir), { recursive: true })
    renameSync(previousDir, newDir)
  }
  designSessionIssue.set(sessionId, issueId)
  broadcast({ type: 'design_issue_linked', sessionId, issueId })
}

// Orchestrator-executed, like mergePr — Sillage does its own git rather than
// letting the agent touch git directly (guard-scope.js denies git mutation
// for design sessions outright, see section 1 of the plan). `git add` is
// scoped to just the design folder so an unrelated dirty tree in the target
// repo never rides along in this commit.
async function commitDesign(sessionId: string, projectId: string, issueId: string): Promise<{ ok: boolean; message: string }> {
  const projectDir = resolveProjectDir(projectId)
  const designDir = resolveDesignDir(projectId, sessionId, issueId)
  if (!existsSync(join(designDir, 'index.html'))) return { ok: false, message: 'no design output to commit yet' }
  const issue = await linear.getIssue(issueId)
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)
  const branch = `feat/${issueId}-${slug}`
  try {
    const { stdout: branches } = await execFileAsync('git', ['branch', '--list', branch], { cwd: projectDir })
    await execFileAsync('git', branches.trim() ? ['checkout', branch] : ['checkout', '-b', branch], { cwd: projectDir })
    await execFileAsync('git', ['add', `design/${issueId}`], { cwd: projectDir })
    await execFileAsync('git', ['commit', '-m', `${issueId}: design mockup for ${issue.title}`], { cwd: projectDir })
    return { ok: true, message: `committed to ${branch}` }
  } catch (err: any) {
    return { ok: false, message: String(err.stderr || err.message || 'commit failed').trim().slice(0, 500) }
  }
}

function handleDesignCommit(ws: WebSocket, payload: any) {
  const sessionId = payload.sessionId
  const projectId = payload.projectId
  const issueId = payload.issueId || designSessionIssue.get(sessionId)
  if (!sessionId || !projectId || !issueId) {
    return send(ws, { type: 'error', sessionId, message: 'a linked issue is required to commit' })
  }
  commitDesign(sessionId, projectId, issueId)
    .then((result) => broadcast({ type: 'design_committed', sessionId, ok: result.ok, message: result.message }))
    .catch((err) => broadcast({ type: 'design_committed', sessionId, ok: false, message: err.message }))
}

// Covers Ideation/Driver/Design sessions alike — the `sessionId` prefix
// (`ideation:`/`driver:`/`design:`) tells us which per-kind state needs
// cleanup, same idiom `handleStart`'s fresh-session logic and resolveDesignDir
// already rely on. Blocked while a turn is in flight, same "already running"
// phrasing used everywhere else in this file — none of these three run kinds
// keep a killable process handle (unlike active/activeRefine), so there's no
// safe way to interrupt one, only to refuse deleting until it finishes.
function handleDeleteSession(ws: WebSocket, payload: any) {
  const sessionId = payload.sessionId
  const projectId = payload.projectId
  if (typeof sessionId !== 'string') return send(ws, { type: 'error', message: 'sessionId is required' })
  if (activeIdeation.has(sessionId) || activeDriver.has(sessionId) || activeDesign.has(sessionId)) {
    return rejectBusy(ws, { sessionId }, 'A turn is already running for this session')
  }
  deleteChatSession(sessionId)
  if (sessionId.startsWith('driver:')) {
    for (const issueId of [...(driverOwnership.get(sessionId) ?? [])]) releaseOwnership(sessionId, issueId)
    driverSessionMode.delete(sessionId)
    driverSessionProject.delete(sessionId)
    driverOwnership.delete(sessionId)
  }
  if (sessionId.startsWith('design:')) {
    // Only an unlinked draft's mockup lives at a path keyed by the session id
    // itself — once linked, the mockup lives under the issue's own folder,
    // and deleting the *session* should never delete the *issue's* design.
    const issueId = designSessionIssue.get(sessionId)
    if (!issueId && projectId) {
      rmSync(resolveDesignDir(projectId, sessionId), { recursive: true, force: true })
    }
    designSessionIssue.delete(sessionId)
  }
  rmSync(join(UPLOADS_DIR, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')), { recursive: true, force: true })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const path = url.pathname
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' })
    res.end()
    return
  }
  try {
    if (path === '/api/health') return json(res, 200, { ok: true, linear: process.env.LINEAR_API_KEY ? 'linear' : 'mock' })
    if (path === '/hook-event' && req.method === 'POST') return handleHookEvent(req, res)
    if (path.startsWith('/api/linear')) return handleLinearApi(req, res, path)
    if (path === '/api/usage' && req.method === 'GET') return json(res, 200, { entries: loadUsage() })
    if (path === '/api/metrics/flow' && req.method === 'GET') {
      const since = new Date(url.searchParams.get('since') || '')
      if (Number.isNaN(since.getTime())) return json(res, 400, { error: 'since must be an ISO date' })
      return json(res, 200, { issues: await getFlowIssues(linear, since) })
    }
    if (path === '/api/friction' && req.method === 'GET') return json(res, 200, { entries: loadFriction() })
    if (path === '/api/step-metrics' && req.method === 'GET') return json(res, 200, { entries: loadStepAttempts() })
    if (path === '/api/gates' && req.method === 'GET') {
      const projects = mappedProjects().map(({ projectId, dir }) => ({ projectId, runs: loadGateRuns(dir) }))
      return json(res, 200, { projects })
    }
    const synthesisMatch = path.match(/^\/api\/synthesis\/([^/]+)(\/generate)?$/)
    if (synthesisMatch) {
      const [, projectId, generate] = synthesisMatch
      if (!generate && req.method === 'GET') return json(res, 200, { synthesis: getSynthesis(projectId) ?? null })
      // No opts => full re-explore, always, even if a synthesis already exists —
      // this is the explicit "start over" action, unlike the automatic patch.
      if (generate && req.method === 'POST') return json(res, 200, { synthesis: await runSynthesisJob(projectId) })
    }
    const designPreviewMatch = path.match(/^\/api\/design\/([^/]+)\/preview$/)
    if (designPreviewMatch && req.method === 'GET') {
      const [, sessionId] = designPreviewMatch
      const projectId = url.searchParams.get('projectId') || ''
      const issueId = url.searchParams.get('issueId') || undefined
      if (!projectId) return json(res, 400, { error: 'projectId is required' })
      const filePath = join(resolveDesignDir(projectId, sessionId, issueId), 'index.html')
      return json(res, 200, { html: existsSync(filePath) ? readFileSync(filePath, 'utf8') : null })
    }
    const designControlsMatch = path.match(/^\/api\/design\/([^/]+)\/controls$/)
    if (designControlsMatch && req.method === 'GET') {
      const [, sessionId] = designControlsMatch
      const projectId = url.searchParams.get('projectId') || ''
      const issueId = url.searchParams.get('issueId') || undefined
      if (!projectId) return json(res, 400, { error: 'projectId is required' })
      const filePath = join(resolveDesignDir(projectId, sessionId, issueId), 'controls.html')
      return json(res, 200, { html: existsSync(filePath) ? readFileSync(filePath, 'utf8') : null })
    }
    const refineReadyMatch = path.match(/^\/api\/refine\/([^/]+)\/ready$/)
    if (refineReadyMatch && req.method === 'POST') {
      const [, issueId] = refineReadyMatch
      refineReadyToConsolidate.add(issueId)
      return json(res, 200, { ok: true })
    }
    const critiqueVerdictMatch = path.match(/^\/api\/critique\/([^/]+)\/verdict$/)
    if (critiqueVerdictMatch && req.method === 'POST') {
      const [, critiqueId] = critiqueVerdictMatch
      const body = await readBody(req)
      const winner = body.winner === 'A' || body.winner === 'B' ? body.winner : null
      const gap = typeof body.gap === 'string' ? body.gap.trim() : ''
      if (!winner || !gap) return json(res, 400, { ok: false, error: 'winner ("A"|"B") and gap (non-empty string) are required' })
      if (!recordVerdict(critiqueId, { winner, gap })) return json(res, 404, { ok: false, error: 'unknown or already-answered critique' })
      return json(res, 200, { ok: true })
    }
    const verifyResultMatch = path.match(/^\/api\/verify\/([^/]+)\/result$/)
    if (verifyResultMatch && req.method === 'POST') {
      const [, verifyId] = verifyResultMatch
      const body = await readBody(req)
      const pass = typeof body.pass === 'boolean' ? body.pass : null
      const detail = typeof body.detail === 'string' ? body.detail.trim() : ''
      if (pass === null || !detail) return json(res, 400, { ok: false, error: 'pass (boolean) and detail (non-empty string) are required' })
      if (!recordVerifyResult(verifyId, { pass, detail })) return json(res, 404, { ok: false, error: 'unknown or already-answered verify' })
      return json(res, 200, { ok: true })
    }
    // Throwaway debug route: exercises verifyStep standalone against a real
    // saved step, before runCard (the actual loop) exists to call it.
    const verifyStepMatch = path.match(/^\/api\/verify-step\/([^/]+)\/([^/]+)$/)
    if (verifyStepMatch && req.method === 'POST') {
      const [, issueId, stepId] = verifyStepMatch
      const plan = getActivePlanForIssue(issueId)
      const step = plan?.steps?.find((s) => s.id === stepId)
      if (!step) return json(res, 404, { error: 'no active plan step found with that id for this issue' })
      const issue = await linear.getIssue(issueId)
      const projectDir = resolveProjectDir(issue.project)
      const verdict = await verifyStep(step, projectDir, issueId)
      return json(res, 200, { verdict })
    }
    // What the Refiner curls during consolidation to see real geometry
    // instead of eyeballing a mockup — fully synchronous and deterministic,
    // no agent-spawning/curl-callback dance needed (unlike runCritique,
    // which needs that specifically because it needs an LLM's judgment).
    const extractElementsMatch = path === '/api/extract-elements'
    if (extractElementsMatch && req.method === 'POST') {
      const body = await readBody(req)
      const url = typeof body.url === 'string' ? body.url : ''
      const viewport: [number, number] =
        Array.isArray(body.viewport) && body.viewport.length === 2 ? [Number(body.viewport[0]), Number(body.viewport[1])] : [1280, 720]
      if (!url) return json(res, 400, { error: 'url is required' })
      try {
        const elements = await extractElements(url, viewport)
        return json(res, 200, { elements })
      } catch (err: any) {
        return json(res, 502, { error: `extraction failed: ${err.message}` })
      }
    }
    const stepResetMatch = path.match(/^\/api\/plans\/([^/]+)\/steps\/([^/]+)\/reset$/)
    if (stepResetMatch && req.method === 'POST') {
      const [, planId, stepId] = stepResetMatch
      const step = resetStep(decodeURIComponent(planId), decodeURIComponent(stepId))
      if (!step) return json(res, 404, { error: 'plan or step not found' })
      return json(res, 200, { step })
    }
    const plansMatch = path.match(/^\/api\/plans(?:\/([^/]+)(\/apply))?$/)
    if (plansMatch) {
      const [, planId, apply] = plansMatch
      if (!planId && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const title = typeof body.title === 'string' ? body.title.trim() : undefined
          const content = typeof body.content === 'string' ? body.content.trim() : ''
          if (!content) return json(res, 400, { error: 'content is required' })
          let steps: Step[] | undefined
          if (body.steps !== undefined) {
            if (!Array.isArray(body.steps) || body.steps.length < 1 || body.steps.length > 8) {
              return json(res, 400, { error: 'steps must be an array of 1-8 items' })
            }
            for (const s of body.steps) {
              if (!s || typeof s.id !== 'string' || !s.id.trim() || typeof s.title !== 'string' || !s.title.trim() || typeof s.criterion !== 'string' || !s.criterion.trim()) {
                return json(res, 400, { error: 'each step requires non-empty id, title, and criterion' })
              }
              if (s.command !== undefined) {
                if (typeof s.command !== 'string' || !s.command.trim()) {
                  return json(res, 400, { error: 'step command, if present, must be a non-empty string' })
                }
                if (STEP_COMMAND_DENYLIST.test(s.command)) {
                  return json(res, 400, { error: `step command is not allowed: "${s.command}"` })
                }
              }
              if (s.check !== undefined && s.check !== 'visual') {
                return json(res, 400, { error: 'step check, if present, must be "visual"' })
              }
              if (s.visual !== undefined) {
                if (!s.visual || typeof s.visual !== 'object') {
                  return json(res, 400, { error: 'step visual, if present, must be an object' })
                }
                if (s.visual.mockup !== undefined && (typeof s.visual.mockup !== 'string' || !s.visual.mockup.trim())) {
                  return json(res, 400, { error: 'step visual.mockup, if present, must be a non-empty string' })
                }
                if (s.visual.params !== undefined) {
                  if (!s.visual.params || typeof s.visual.params !== 'object' || Array.isArray(s.visual.params)) {
                    return json(res, 400, { error: 'step visual.params, if present, must be an object of strings' })
                  }
                  if (Object.values(s.visual.params).some((v) => typeof v !== 'string')) {
                    return json(res, 400, { error: 'step visual.params values must all be strings' })
                  }
                }
                if (s.visual.candidates !== undefined) {
                  if (!Array.isArray(s.visual.candidates) || s.visual.candidates.length === 0) {
                    return json(res, 400, { error: 'step visual.candidates, if present, must be a non-empty array' })
                  }
                  for (const c of s.visual.candidates) {
                    const box = c?.box
                    if (!c || typeof c.selector !== 'string' || typeof c.text !== 'string' || !box || typeof box !== 'object' ||
                      typeof box.x !== 'number' || typeof box.y !== 'number' || typeof box.width !== 'number' || typeof box.height !== 'number') {
                      return json(res, 400, { error: 'each visual.candidates entry needs selector, text, and a box of {x,y,width,height} numbers' })
                    }
                  }
                }
                if (s.visual.viewport !== undefined) {
                  if (!Array.isArray(s.visual.viewport) || s.visual.viewport.length !== 2 || s.visual.viewport.some((n: unknown) => typeof n !== 'number')) {
                    return json(res, 400, { error: 'step visual.viewport, if present, must be [width, height] numbers' })
                  }
                }
                if (s.visual.tolerance !== undefined) {
                  if (!s.visual.tolerance || typeof s.visual.tolerance !== 'object' || Array.isArray(s.visual.tolerance)) {
                    return json(res, 400, { error: 'step visual.tolerance, if present, must be an object' })
                  }
                  if (Object.values(s.visual.tolerance).some((v) => v !== undefined && typeof v !== 'number')) {
                    return json(res, 400, { error: 'step visual.tolerance values must all be numbers' })
                  }
                }
              }
            }
            steps = body.steps.map((s: any) => ({
              id: s.id.trim(),
              title: s.title.trim(),
              criterion: s.criterion.trim(),
              command: typeof s.command === 'string' ? s.command.trim() : undefined,
              check: s.check === 'visual' ? 'visual' : undefined,
              visual: s.visual
                ? {
                    mockup: typeof s.visual.mockup === 'string' ? s.visual.mockup.trim() : undefined,
                    params: s.visual.params && typeof s.visual.params === 'object' ? s.visual.params : undefined,
                    candidates: Array.isArray(s.visual.candidates) ? s.visual.candidates : undefined,
                    viewport: Array.isArray(s.visual.viewport) ? (s.visual.viewport as [number, number]) : undefined,
                    tolerance: s.visual.tolerance && typeof s.visual.tolerance === 'object' ? s.visual.tolerance : undefined,
                    region: Array.isArray(s.visual.region) ? (s.visual.region as [number, number, number, number]) : undefined,
                  }
                : undefined,
              status: 'pending',
              attempts: 0,
            }))
          }
          const issueId = typeof body.issueId === 'string' ? body.issueId : undefined
          // A visual step's params must be exactly what this project's capture
          // command substitutes — caught here instead of as a "check could not
          // run" flag on every attempt (LAE-183: {"run": ...} where only {scene} works).
          if (steps?.some((step) => step.check === 'visual')) {
            if (!issueId) return json(res, 400, { error: 'plans with "check":"visual" steps need an issueId, to know which project\'s capture command applies' })
            const capture = await captureConfigForIssue(issueId)
            if (!capture) {
              return json(res, 400, { error: 'this project has no capture command configured, so "check":"visual" steps cannot run — use a "command" instead' })
            }
            for (const step of steps) {
              if (step.check !== 'visual') continue
              if (step.visual?.region) {
                const why = validateVisualRegion(step.visual.region, capture.viewport)
                if (why) return json(res, 400, { error: `step "${step.title}" visual.region: ${why}` })
              }
              if (!step.visual?.params) continue
              const { missing, unknown } = validateCaptureParams(capture, step.visual.params)
              if (missing.length || unknown.length) {
                const expected = captureParamNames(capture).map((name) => `"${name}"`).join(', ') || '(none)'
                const problems = [missing.length && `missing ${missing.join(', ')}`, unknown.length && `unknown ${unknown.join(', ')}`].filter(Boolean).join('; ')
                return json(res, 400, { error: `step "${step.title}" visual.params: ${problems}. This project's capture command takes exactly: ${expected} (plain string values, e.g. a scene name — not a shell command).` })
              }
            }
          }
          const plan = savePlan({
            title,
            content,
            issueId,
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
            createdAt: new Date().toISOString(),
            steps,
          })
          return json(res, 201, { plan })
        } catch (err: any) {
          return json(res, 500, { error: err.message })
        }
      }
      if (planId && apply === '/apply' && req.method === 'POST') {
        const entry = markPlanApplied(planId)
        if (!entry) return json(res, 404, { error: 'plan not found' })
        return json(res, 200, { plan: entry })
      }
      if (planId && !apply && req.method === 'GET') {
        const store = (() => { try { return JSON.parse(readFileSync(join(__dirname, '..', 'plans.json'), 'utf8')) } catch { return {} } })()
        const entry = store[planId]
        if (!entry) return json(res, 404, { error: 'plan not found' })
        return json(res, 200, { plan: entry })
      }
      const issueIdParam = url.searchParams.get('issueId')
      if (issueIdParam && req.method === 'GET') {
        const plans = listPlansForIssue(issueIdParam)
        return json(res, 200, { plans })
      }
      return json(res, 405, { error: 'method not allowed' })
    }
    return json(res, 404, { error: 'not found' })
  } catch (err: any) {
    return json(res, 500, { error: err.message })
  }
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws: WebSocket) => {
  clients.add(ws)
  send(ws, {
    type: 'hello',
    linear: process.env.LINEAR_API_KEY ? 'linear' : 'mock',
    activeIssueIds: [...active.keys()],
    activeRefineIssueIds: [...activeRefine.keys()],
    activeIdeationSessionIds: [...activeIdeation.keys()],
    activeDriverSessionIds: [...activeDriver.keys()],
    activeDesignSessionIds: [...activeDesign.keys()],
    driverSessionModes: Object.fromEntries(driverSessionMode),
    driverOwnership: Object.fromEntries([...driverOwnership].map(([sessionId, ids]) => [sessionId, [...ids]])),
    // Accumulated events for whatever's still active, so a (re)connecting
    // client can render the true in-progress state immediately instead of
    // waiting for the next output event — see App.tsx's 'hello' handler.
    activeTaskEvents: Object.fromEntries([...active].map(([id, s]) => [id, s.events])),
    activeRefineEvents: Object.fromEntries([...activeRefine].map(([id, e]) => [id, e.events])),
    activeIdeationEvents: Object.fromEntries([...activeIdeation].map(([id, e]) => [id, e.events])),
    activeDriverEvents: Object.fromEntries([...activeDriver].map(([id, e]) => [id, e.events])),
    activeDesignEvents: Object.fromEntries([...activeDesign].map(([id, e]) => [id, e.events])),
  })
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'start') handleStart(ws, msg)
      else if (msg.type === 'stop') handleStop(ws, msg)
      else if (msg.type === 'restart') handleRestart(ws, msg)
      else if (msg.type === 'feedback') handleFeedback(ws, msg)
      else if (msg.type === 'refine_start') handleRefineStart(ws, msg)
      else if (msg.type === 'refine_message') handleRefineMessage(ws, msg)
      else if (msg.type === 'refine_consolidate') handleRefineConsolidate(ws, msg)
      else if (msg.type === 'ideation_message') handleIdeationMessage(ws, msg)
      else if (msg.type === 'driver_message') handleDriverMessage(ws, msg)
      else if (msg.type === 'driver_set_mode') handleDriverSetMode(ws, msg)
      else if (msg.type === 'design_message') handleDesignMessage(ws, msg)
      else if (msg.type === 'design_link_issue') handleDesignLinkIssue(ws, msg)
      else if (msg.type === 'design_commit') handleDesignCommit(ws, msg)
      else if (msg.type === 'delete_session') handleDeleteSession(ws, msg)
    } catch {
      send(ws, { type: 'error', message: 'invalid message' })
    }
  })
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

// Stall detection is a plain poll, not an LLM call — "no output in N
// minutes" is a mechanical fact a script can check; the Driver only gets
// involved (via routeDriverSignal, same as any other event) once something's
// actually flagged, to decide what — if anything — to do about it.
setInterval(() => {
  const now = Date.now()
  for (const [issueId, state] of active) {
    if (now - state.lastEventAt > STALL_THRESHOLD_MS && !stallFlagged.has(issueId)) {
      stallFlagged.add(issueId)
      broadcast({ type: 'stall_detected', issueId, thresholdMs: STALL_THRESHOLD_MS })
    }
  }
  for (const [issueId, entry] of activeRefine) {
    if (now - entry.lastEventAt > STALL_THRESHOLD_MS && !stallFlagged.has(issueId)) {
      stallFlagged.add(issueId)
      broadcast({ type: 'stall_detected', issueId, thresholdMs: STALL_THRESHOLD_MS })
    }
  }
  for (const issueId of stallFlagged) {
    if (!active.has(issueId) && !activeRefine.has(issueId)) stallFlagged.delete(issueId)
  }
}, STALL_POLL_INTERVAL_MS)

// Autonomous idle-rescan backstop — routeDriverSignal already wakes an idle
// autonomous session immediately on board changes; this is the "nothing
// changed but it's been a while" fallback so a stagnant backlog still gets
// revisited eventually.
setInterval(() => {
  for (const [sessionId, mode] of driverSessionMode) {
    if (mode !== 'autonomous' || activeDriver.has(sessionId)) continue
    const owned = driverOwnership.get(sessionId)
    if (owned && owned.size >= AUTONOMOUS_OWNED_CAP) continue
    const projectId = driverSessionProject.get(sessionId)
    if (projectId) runAutonomousScan(sessionId, projectId)
  }
}, AUTONOMOUS_IDLE_RESCAN_MS)

// --- Recovery: reattach to agent processes that outlived a prior server
// instance (crash, node --watch reload, manual restart) instead of leaving
// them as invisible orphans — see server/run-registry.ts and agent.ts's
// openRunLog/tailLines for the mechanism this depends on. Only protects runs
// that started after this feature shipped (their stdout is file-backed); an
// older orphan predating it has no log file and can't be recovered.

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Shared by every resume* function below: reattaches to whichever backend the
// registry says was already in flight. No fresh prompt/projectDir is ever
// built — resume mode skips spawning entirely (see agent.ts) and just tails
// the existing logFile / watches the existing pid.
async function resumeChatTurn(record: ActiveRunRecord, onOutput: (event: AgentEvent) => void): Promise<{ exitCode: number | null; needsFallback: boolean; sessionId?: string }> {
  const resume = { pid: record.pid, logFile: record.logFile }
  if (record.backend === 'opencode') return runOpencode({ prompt: '', projectDir: '', onOutput, sessionId: record.sessionId, resume })
  if (record.backend === 'kilocode') return runKilocode({ prompt: '', projectDir: '', onOutput, sessionId: record.sessionId, resume })
  return runClaude({ prompt: '', projectDir: '', onOutput, session: record.sessionId ? { id: record.sessionId, resume: true } : undefined, resume })
}

async function resumeTaskRun(record: ActiveRunRecord, onOutput: (event: AgentEvent) => void): Promise<{ exitCode: number | null; needsFallback: boolean; sessionId?: string }> {
  if (record.backend === 'mock') return runMockAgent({ issueId: record.key, onOutput, resume: { pid: record.pid, logFile: record.logFile } })
  return resumeChatTurn(record, onOutput)
}

function resumeTask(record: ActiveRunRecord): void {
  const state: ActiveState = {
    issueId: record.key,
    task: '(recovered run)',
    events: [],
    done: false,
    proc: null,
    pid: record.pid,
    stopped: false,
    pendingRestart: false,
    lastEventAt: Date.now(),
  }
  active.set(record.key, state)
  broadcast({ type: 'task_started', issueId: record.key, task: state.task })

  ;(async () => {
    // Recovery reattaches directly to an already-running process — it never
    // goes through runTask, so it never acquires the per-project slot either.
    // Without this, a run that survives a server restart holds no lock at
    // all, and a new implement on the same project would race it exactly
    // like the original bug, just triggered by a restart instead of the
    // Driver. Best-effort: a Linear hiccup here shouldn't block recovering
    // the run itself, just means this one instance goes unguarded.
    let releaseProjectSlot: (() => void) | undefined
    try {
      const issue = await linear.getIssue(record.key)
      const folder = basename(resolveProjectDir(issue.project))
      if (!supportsWorktrees(folder)) {
        releaseProjectSlot = await acquireProjectSlot(folder, (event) => broadcast({ type: 'output', issueId: record.key, event }))
      }
    } catch (err: any) {
      console.error(`[task ${record.key}] could not resolve project for recovery lock:`, err.message)
    }

    try {
      const result = await resumeTaskRun(record, (event) => {
        state.events.push(event)
        state.lastEventAt = Date.now()
        broadcast({ type: 'output', issueId: record.key, event })
      })
      if (result.needsFallback) {
        throw new Error('Recovered run never finished — it either produced no further output or the process exited without completing before this server restarted.')
      }
      state.done = true
      if (state.stopped) {
        if (!state.pendingRestart) broadcast({ type: 'stopped', issueId: record.key })
      } else {
        broadcast({ type: 'done', issueId: record.key, exitCode: result.exitCode, summary: summarizeEvents(state.events) })
      }
    } catch (err: any) {
      state.done = true
      console.error(`[task ${record.key}] recovered run failed:`, err)
      broadcast({ type: 'error', issueId: record.key, message: err.message, summary: summarizeEvents(state.events) })
    } finally {
      releaseProjectSlot?.()
      active.delete(record.key)
      clearActiveRun(record.key)
      if (state.pendingRestart) startRun(record.key, state.task)
    }
  })()
}

function resumeRefine(record: ActiveRunRecord): void {
  activeRefine.set(record.key, { issueId: record.key, lastEventAt: Date.now(), textParts: [], events: [] })
  broadcast({ type: 'refine_turn_started', issueId: record.key })

  ;(async () => {
    try {
      const result = await resumeChatTurn(record, (event) => {
        const entry = activeRefine.get(record.key)
        if (entry) {
          entry.lastEventAt = Date.now()
          entry.events.push(event)
          if (event.kind === 'text') entry.textParts.push(event.text)
        }
        broadcast({ type: 'refine_output', issueId: record.key, event })
      })
      if (result.needsFallback) throw new Error('Recovered refine turn never finished before this server restarted.')
      const summary = (activeRefine.get(record.key)?.textParts.join('') ?? '').trim()
      const trimmedSummary = summary.length > 4000 ? `${summary.slice(0, 4000)}\n… (truncated)` : summary
      broadcast({ type: 'refine_turn_done', issueId: record.key, summary: trimmedSummary })
    } catch (err: any) {
      console.error(`[refine ${record.key}] recovered run failed:`, err)
      broadcast({ type: 'error', issueId: record.key, message: err.message })
    } finally {
      activeRefine.delete(record.key)
      clearActiveRun(record.key)
    }
  })()
}

function resumeIdeation(record: ActiveRunRecord): void {
  activeIdeation.set(record.key, { sessionId: record.key, events: [] })
  broadcast({ type: 'ideation_turn_started', sessionId: record.key })

  ;(async () => {
    try {
      const result = await resumeChatTurn(record, (event) => {
        activeIdeation.get(record.key)?.events.push(event)
        broadcast({ type: 'ideation_output', sessionId: record.key, event })
      })
      if (result.needsFallback) throw new Error('Recovered ideation turn never finished before this server restarted.')
      broadcast({ type: 'ideation_turn_done', sessionId: record.key })
    } catch (err: any) {
      console.error(`[ideation ${record.key}] recovered run failed:`, err)
      broadcast({ type: 'error', sessionId: record.key, message: err.message })
    } finally {
      activeIdeation.delete(record.key)
      clearActiveRun(record.key)
    }
  })()
}

function resumeDesign(record: ActiveRunRecord): void {
  activeDesign.set(record.key, { sessionId: record.key, events: [] })
  broadcast({ type: 'design_turn_started', sessionId: record.key })

  ;(async () => {
    try {
      const result = await resumeChatTurn(record, (event) => {
        activeDesign.get(record.key)?.events.push(event)
        broadcast({ type: 'design_output', sessionId: record.key, event })
      })
      if (result.needsFallback) throw new Error('Recovered design turn never finished before this server restarted.')
      broadcast({ type: 'design_turn_done', sessionId: record.key })
    } catch (err: any) {
      console.error(`[design ${record.key}] recovered run failed:`, err)
      broadcast({ type: 'error', sessionId: record.key, message: err.message })
    } finally {
      activeDesign.delete(record.key)
      clearActiveRun(record.key)
    }
  })()
}

// Mirrors runDriver()'s full tail — a recovered Driver turn still needs to
// parse and execute whatever action block it proposed, same as a live one,
// otherwise a run that only finishes after recovery would silently drop it.
function resumeDriver(record: ActiveRunRecord): void {
  if (!record.projectId) {
    console.error(`[em ${record.key}] recovered run has no projectId in the registry, cannot execute any proposed action — skipping`)
    clearActiveRun(record.key)
    return
  }
  const projectId = record.projectId
  activeDriver.set(record.key, { sessionId: record.key, events: [] })
  broadcast({ type: 'driver_turn_started', sessionId: record.key })
  let assistantText = ''

  ;(async () => {
    let turnFailed = false
    try {
      const result = await resumeChatTurn(record, (event) => {
        if (event.kind === 'text') assistantText += event.text
        activeDriver.get(record.key)?.events.push(event)
        broadcast({ type: 'driver_output', sessionId: record.key, event })
      })
      if (result.needsFallback) throw new Error('Recovered Driver turn never finished before this server restarted.')
      broadcast({ type: 'driver_turn_done', sessionId: record.key })
    } catch (err: any) {
      console.error(`[em ${record.key}] recovered run failed:`, err)
      broadcast({ type: 'error', sessionId: record.key, message: err.message })
      turnFailed = true
    } finally {
      activeDriver.delete(record.key)
      clearActiveRun(record.key)
    }
    if (turnFailed) return

    const actions = parseDriverActions(assistantText)
    await executeDriverActions(record.key, projectId, actions)

    if (pendingDriverEvents.get(record.key)?.length) {
      const timer = driverDebounceTimer.get(record.key)
      if (timer) {
        clearTimeout(timer)
        driverDebounceTimer.delete(record.key)
      }
      flushDriverEvents(record.key)
    }
  })()
}

function recoverActiveRuns(): void {
  for (const record of loadActiveRuns()) {
    if (!isPidAlive(record.pid)) {
      clearActiveRun(record.key)
      appendFriction({
        kind: 'run_failed',
        timestamp: new Date().toISOString(),
        issueId: record.kind === 'task' || record.kind === 'refine' ? record.key : undefined,
        sessionId: record.kind === 'task' || record.kind === 'refine' ? undefined : record.key,
        detail: `A ${record.kind} run was interrupted by a server restart and its process had already exited before recovery could reattach — outcome unknown.`,
      })
      continue
    }
    console.log(`[recover] reattaching to ${record.kind} run ${record.key} (pid ${record.pid})`)
    if (record.kind === 'task') resumeTask(record)
    else if (record.kind === 'refine') resumeRefine(record)
    else if (record.kind === 'ideation') resumeIdeation(record)
    else if (record.kind === 'driver') resumeDriver(record)
    else if (record.kind === 'design') resumeDesign(record)
  }
}

recoverActiveRuns()

// Bound explicitly to 127.0.0.1 — this port carries the unauthenticated
// /api/linear/* routes and the WebSocket control plane (which can spawn real
// agent processes), so it must never be reachable beyond this machine. The
// public-facing webhook listener is a deliberately separate server; see
// webhook-listener.ts.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`orchestrator listening on http://127.0.0.1:${PORT}`)
})

startWebhookListener({
  linear,
  broadcast,
  port: Number(process.env.WEBHOOK_PORT || 4391),
})
