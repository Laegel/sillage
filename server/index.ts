import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { execFile, type ChildProcessByStdio } from 'node:child_process'
import { promisify } from 'node:util'
import type { Readable } from 'node:stream'
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
  CONSOLIDATE_PROMPT,
  RESUME_RECAP_PROMPT,
  runClaude,
  runFree,
  runOpencode,
  runKilocode,
  runMockAgent,
  SILLAGE_ROOT,
} from './agent.ts'
import { checkRequiredTools, resolveProjectDir } from './project-map.ts'
import { deleteChatSession, getChatSession, saveChatSession, type ChatBackend } from './chat-store.ts'
import { savePlan, markPlanApplied, getLatestUnappliedPlanForIssue, listPlansForIssue, type Plan } from './plans-store.ts'
import { appendUsage, loadUsage } from './usage-store.ts'
import { getSynthesis, saveSynthesis, type SynthesisEntry } from './synthesis-store.ts'
import { classifyFriction, appendFriction } from './friction-store.ts'
import type { AgentEvent, DriverAction, DriverActionKind, DriverMode, Issue } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const PORT = Number(process.env.PORT || 4390)
const linear = getLinearStore()

type ActiveState = {
  issueId: string
  task: string
  events: AgentEvent[]
  done: boolean
  proc: ChildProcessByStdio<null, Readable, Readable> | null
  stopped: boolean
  pendingRestart: boolean
  lastEventAt: number
}

const clients = new Set<WebSocket>()
const active = new Map<string, ActiveState>()
const activeRefine = new Map<string, { issueId: string; lastEventAt: number; textParts: string[] }>()
const activeIdeation = new Map<string, { sessionId: string }>()
const activeDriver = new Map<string, { sessionId: string }>()
const activeDesign = new Map<string, { sessionId: string }>()
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
// broadcast(). Memory-only like the maps above — persisting ownership
// alone wouldn't resurrect a dead child process after a restart, it'd just
// leave a session "watching" a run that silently ended; the real gap (agent
// runs aren't resumable across a restart) is pre-existing and out of scope.
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
  const friction = classifyFriction(payload)
  if (friction) appendFriction(friction)
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
    let linearUpdated = false
    if (issueId) {
      try {
        linearUpdated = await linear.attachPr(issueId, prUrl)
      } catch (err: any) {
        console.error('[hook] linear update failed:', err.message)
      }
    }
    if (issueId) issuePrUrl.set(issueId, prUrl)
    broadcast({ type: 'pr_created', prUrl, issueId })
    if (issueId) broadcast({ type: 'issue_updated', issueId })
    json(res, 200, { ok: true, linearUpdated })
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
    return json(res, 500, { error: err.message })
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

async function runTask({
  issueId,
  task,
  onOutput,
  onProcess,
  fresh,
}: {
  issueId: string
  task: string
  onOutput: (event: AgentEvent) => void
  onProcess?: (proc: ChildProcessByStdio<null, Readable, Readable>) => void
  // Skips the resume-if-one-exists check below — a deliberate clean-slate
  // run, e.g. when a prior attempt's session went off in a bad direction and
  // resuming it would just drag the same dead end back in.
  fresh?: boolean
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
    return runMockAgent({ issueId, onOutput, onProcess })
  }

  const projectDir = resolveProjectDir(issue.project)
  await checkRequiredTools(basename(projectDir))
  const comments = await linear.listComments(issueId)
  const approvedPlan = getLatestUnappliedPlanForIssue(issueId)
  const planBlock = approvedPlan
    ? `APPROVED PLAN\n${approvedPlan.content}\n\n`
    : ''
  const prompt = await buildPrompt({ issue, comments, task: `${planBlock}${task}`, projectDir })
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
  const sessionKey = `implement:${issueId}`
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
      onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })
      run = await runClaude({ prompt, projectDir, onOutput, onProcess, session: { id: existing.sessionId, resume: true } })
      backend = 'claude'
    } else if (existing?.backend === 'opencode') {
      agentLabel = 'OpenCode (resumed session)'
      onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })
      run = await runOpencode({ prompt, projectDir, onOutput, onProcess, sessionId: existing.sessionId })
      backend = 'opencode'
    } else if (existing?.backend === 'kilocode') {
      agentLabel = 'Kilo Code (resumed session)'
      onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })
      run = await runKilocode({ prompt, projectDir, onOutput, onProcess, sessionId: existing.sessionId })
      backend = 'kilocode'
    } else {
      const agentChoice = await linear.resolveAgentChoice(issueId)
      if (agentChoice === 'claude') {
        agentLabel = 'Claude Code'
        onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })
        run = await runClaude({ prompt, projectDir, onOutput, onProcess, session: { id: randomUUID(), resume: false } })
        backend = 'claude'
      } else {
        agentLabel = 'Free (Kilo Code, falling back to OpenCode if needed)'
        onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })
        const freeRun = await runFree({ prompt, projectDir, onOutput, onProcess })
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

  if (before) {
    const after = await gitSnapshot(projectDir)
    if (after && after.head === before.head && !after.dirty) {
      throw new Error(`${agentLabel} finished without making any file changes — it likely got stuck exploring or ran out of budget before implementing anything. Its session has been saved, so restarting will resume from here instead of re-exploring from scratch.`)
    }
  }

  return run
}

// Shared by a fresh start and a restart. Runs one attempt in the background;
// if `pendingRestart` gets set on the state before this attempt settles (by
// handleRestart), the .finally() below immediately launches a fresh attempt
// for the same task — synchronously, right after active.delete(), so there's
// no window for a stray 'start' message to race into the gap.
function startRun(issueId: string, task: string, onDone?: (result: { ok: boolean; message: string }) => void, fresh?: boolean) {
  const state: ActiveState = { issueId, task, events: [], done: false, proc: null, stopped: false, pendingRestart: false, lastEventAt: Date.now() }
  active.set(issueId, state)

  runTask({
    issueId,
    task,
    fresh,
    onOutput: (event) => {
      state.events.push(event)
      state.lastEventAt = Date.now()
      broadcast({ type: 'output', issueId, event })
    },
    onProcess: (proc) => {
      state.proc = proc
    },
  })
    .then((result) => {
      state.done = true
      if (state.stopped) {
        if (!state.pendingRestart) broadcast({ type: 'stopped', issueId })
      } else {
        broadcast({ type: 'done', issueId, exitCode: result?.exitCode })
        onDone?.({ ok: true, message: `exitCode ${result?.exitCode}` })
      }
    })
    .catch((err) => {
      state.done = true
      if (state.stopped) {
        if (!state.pendingRestart) broadcast({ type: 'stopped', issueId })
      } else {
        console.error(`[task ${issueId}] failed:`, err)
        broadcast({ type: 'error', issueId, message: err.message })
        onDone?.({ ok: false, message: err.message })
      }
    })
    .finally(() => {
      active.delete(issueId)
      if (state.pendingRestart) startRun(issueId, state.task)
    })

  broadcast({ type: 'task_started', issueId, task })
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

  startRun(issueId, task, undefined, Boolean(payload.fresh))
  send(ws, { type: 'started', issueId })
}

// Stop leaves the issue's Linear status untouched — runTask already moved it
// to "In Progress" and nothing here should second-guess that; only a genuinely
// finished/blocked run changes status again, same as an ordinary completion.
function stopIssueRun(issueId: string): boolean {
  const state = active.get(issueId)
  if (!state) return false
  state.stopped = true
  state.proc?.kill('SIGTERM')
  return true
}

function restartIssueRun(issueId: string): boolean {
  const state = active.get(issueId)
  if (!state) return false
  state.stopped = true
  state.pendingRestart = true
  state.proc?.kill('SIGTERM')
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
}: {
  issueId: string
  prompt: string
  onOutput: (event: AgentEvent) => void
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
    run = await runClaude({ prompt, projectDir, onOutput, session: { id: existing.sessionId, resume: true }, readOnly: true })
    backend = 'claude'
  } else if (existing?.backend === 'opencode') {
    run = await runOpencode({ prompt, projectDir, onOutput, sessionId: existing.sessionId, readOnly: true })
    backend = 'opencode'
  } else if (existing?.backend === 'kilocode') {
    run = await runKilocode({ prompt, projectDir, onOutput, sessionId: existing.sessionId, readOnly: true })
    backend = 'kilocode'
  } else {
    const agentChoice = await linear.resolveAgentChoice(issueId)
    if (agentChoice === 'claude') {
      run = await runClaude({ prompt, projectDir, onOutput, session: { id: randomUUID(), resume: false }, readOnly: true })
      backend = 'claude'
    } else {
      const freeRun = await runFree({ prompt, projectDir, onOutput, readOnly: true })
      run = freeRun
      backend = freeRun.backend
    }
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
): boolean {
  if (activeRefine.has(issueId)) return false
  activeRefine.set(issueId, { issueId, lastEventAt: Date.now(), textParts: [] })

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
            if (event.kind === 'text') entry.textParts.push(event.text)
          }
          broadcast({ type: 'refine_output', issueId, event })
        },
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
      broadcast({ type: 'refine_turn_done', issueId, summary: trimmedSummary })
      onDone?.({ ok: true, message: trimmedSummary || 'refine turn complete (no text output)' })
    } catch (err: any) {
      console.error(`[refine ${issueId}] failed:`, err)
      broadcast({ type: 'error', issueId, message: err.message })
      onDone?.({ ok: false, message: err.message })
    } finally {
      activeRefine.delete(issueId)
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
    return buildRefinePrompt({ issue, projectDir })
  })
  if (!started) rejectBusy(ws, { issueId }, 'A refine turn is already running for this issue')
}

function handleRefineMessage(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  const message = payload.message
  if (!issueId || !message) return send(ws, { type: 'error', message: 'issueId and message are required' })
  const started = runRefine(issueId, () => message)
  if (!started) rejectBusy(ws, { issueId }, 'A refine turn is already running for this issue')
}

function handleRefineConsolidate(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  if (!issueId) return send(ws, { type: 'error', message: 'issueId is required' })
  const started = runRefine(issueId, () => CONSOLIDATE_PROMPT)
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
}: {
  sessionId: string
  projectId: string
  prompt: string
  onOutput: (event: AgentEvent) => void
}) {
  const projectDir = resolveProjectDir(projectId)
  await checkRequiredTools(basename(projectDir))
  const existing = getChatSession(sessionId)

  let run: { exitCode: number | null; needsFallback: boolean; rateLimited?: boolean; sessionId?: string }
  let backend: ChatBackend

  if (existing?.backend === 'claude') {
    run = await runClaude({ prompt, projectDir, onOutput, session: { id: existing.sessionId, resume: true }, readOnly: true })
    backend = 'claude'
  } else if (existing?.backend === 'opencode') {
    run = await runOpencode({ prompt, projectDir, onOutput, sessionId: existing.sessionId, readOnly: true })
    backend = 'opencode'
  } else if (existing?.backend === 'kilocode') {
    run = await runKilocode({ prompt, projectDir, onOutput, sessionId: existing.sessionId, readOnly: true })
    backend = 'kilocode'
  } else {
    run = await runClaude({ prompt, projectDir, onOutput, session: { id: randomUUID(), resume: false }, readOnly: true })
    backend = 'claude'
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
function runIdeation(sessionId: string, projectId: string, buildTurnPrompt: () => Promise<string> | string): boolean {
  if (activeIdeation.has(sessionId)) return false
  activeIdeation.set(sessionId, { sessionId })

  ;(async () => {
    try {
      const prompt = await buildTurnPrompt()
      broadcast({ type: 'ideation_turn_started', sessionId })
      await runIdeationTurn({
        sessionId,
        projectId,
        prompt,
        onOutput: (event) => broadcast({ type: 'ideation_output', sessionId, event }),
      })
      broadcast({ type: 'ideation_turn_done', sessionId })
    } catch (err: any) {
      console.error(`[ideation ${sessionId}] failed:`, err)
      broadcast({ type: 'error', sessionId, message: err.message })
    } finally {
      activeIdeation.delete(sessionId)
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
  const started = runIdeation(sessionId, projectId, async () => {
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
}: {
  sessionId: string
  projectId: string
  prompt: string
  onOutput: (event: AgentEvent) => void
}) {
  const projectDir = resolveProjectDir(projectId)
  await checkRequiredTools(basename(projectDir))
  const existing = getChatSession(sessionId)
  const run = existing?.backend === 'claude'
    ? await runClaude({ prompt, projectDir, onOutput, session: { id: existing.sessionId, resume: true }, readOnly: true })
    : await runClaude({ prompt, projectDir, onOutput, session: { id: randomUUID(), resume: false }, readOnly: true })

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
  done: (p) => `The implementation run finished (exit code ${p.exitCode}).`,
  stopped: () => 'The implementation run was stopped.',
  error: (p) => `The run failed: ${p.message}`,
  refine_turn_done: (p) =>
    p.summary
      ? `A refine discussion turn finished. Here's what the agent said:\n\n${p.summary}`
      : 'A refine discussion turn finished with no text output — check the agent\'s own logs.',
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
      if (owner) scheduleDriverEvent(owner, { kind: 'ownership', issueId, reason: reasonFn(payload) })
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
      actions.push({ action, issueId, task, reason })
    }
    return actions.slice(0, MAX_ACTIONS_PER_TURN)
  } catch {
    return []
  }
}

function startDriverRefine(issueId: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const started = runRefine(
      issueId,
      async () => {
        const existing = getChatSession(issueId)
        if (existing) return RESUME_RECAP_PROMPT
        const issue = await linear.getIssue(issueId)
        return buildRefinePrompt({ issue, projectDir: resolveProjectDir(issue.project) })
      },
      resolve,
    )
    if (!started) resolve({ ok: false, message: `A refine turn is already running for ${issueId} — skipped.` })
  })
}

function startDriverImplement(issueId: string, task: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    if (active.has(issueId)) return resolve({ ok: false, message: `${issueId} already has a run in progress — skipped.` })
    startRun(issueId, task, resolve)
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
          return startDriverRefine(issueId)
        case 'implement':
          return action.task ? startDriverImplement(issueId, action.task) : { ok: false, message: 'implement action missing task' }
        case 'stop':
          return { ok: stopIssueRun(issueId), message: 'stop requested' }
        case 'restart':
          return { ok: restartIssueRun(issueId), message: 'restart requested' }
        case 'merge':
          return mergePr(issueId, projectId)
        case 'flag':
          return flagIncomplete(issueId, action.reason || '(no reason given)')
        default:
          return { ok: false, message: `unsupported action: ${action.action}` }
      }
    })()
    broadcast({ type: 'driver_action', sessionId, action: action.action, issueId, status: result.ok ? 'done' : 'failed', message: result.message })
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
      releaseOwnership(sessionId, u.issueId)
      broadcast({
        type: 'driver_action',
        sessionId,
        action: 'release',
        issueId: u.issueId,
        status: 'done',
        message: `auto-released — exceeded ${MAX_OWNERSHIP_REPROMPTS_PER_CARD} status-update turns without reaching Done`,
      })
      continue
    }
    stillActive.push(u)
  }

  if (stillActive.length === 0) return
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
  activeDriver.set(sessionId, { sessionId })

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
          broadcast({ type: 'driver_output', sessionId, event })
        },
      })
      broadcast({ type: 'driver_turn_done', sessionId })
    } catch (err: any) {
      console.error(`[em ${sessionId}] failed:`, err)
      broadcast({ type: 'error', sessionId, message: err.message })
      turnFailed = true
    } finally {
      activeDriver.delete(sessionId)
    }
    if (turnFailed) return

    const actions = parseDriverActions(assistantText)
    await executeDriverActions(sessionId, projectId, actions)

    // Drain any ownership/board-scan events that queued up while this turn
    // was running (scheduleDriverEvent's debounce timer no-ops while activeDriver
    // holds the lock).
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
}: {
  sessionId: string
  projectId: string
  designDir: string
  prompt: string
  onOutput: (event: AgentEvent) => void
}) {
  const projectDir = resolveProjectDir(projectId)
  await checkRequiredTools(basename(projectDir))
  mkdirSync(designDir, { recursive: true })
  const existing = getChatSession(sessionId)
  const run = existing?.backend === 'claude'
    ? await runClaude({ prompt, projectDir, onOutput, session: { id: existing.sessionId, resume: true }, designDir })
    : await runClaude({ prompt, projectDir, onOutput, session: { id: randomUUID(), resume: false }, designDir })

  if (run.needsFallback) {
    throw new Error('The agent exited without producing any output for this design turn — no real response was generated. Check the agent\'s own logs.')
  }
  if (run.sessionId) saveChatSession(sessionId, 'claude', run.sessionId)
  return run
}

// Mirrors runIdeation()/runDriver(), against the separate activeDesign map.
function runDesign(sessionId: string, projectId: string, designDir: string, buildTurnPrompt: () => Promise<string> | string): boolean {
  if (activeDesign.has(sessionId)) return false
  activeDesign.set(sessionId, { sessionId })

  ;(async () => {
    try {
      const prompt = await buildTurnPrompt()
      broadcast({ type: 'design_turn_started', sessionId })
      await runDesignTurn({
        sessionId,
        projectId,
        designDir,
        prompt,
        onOutput: (event) => broadcast({ type: 'design_output', sessionId, event }),
      })
      broadcast({ type: 'design_turn_done', sessionId })
    } catch (err: any) {
      console.error(`[design ${sessionId}] failed:`, err)
      broadcast({ type: 'error', sessionId, message: err.message })
    } finally {
      activeDesign.delete(sessionId)
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
  const issueId = designSessionIssue.get(sessionId)
  const designDir = resolveDesignDir(projectId, sessionId, issueId)
  const started = runDesign(sessionId, projectId, designDir, async () => {
    const paths = saveIdeationImages(sessionId, images)
    const imageNote = paths.length > 0 ? `\n\n[Attached image(s) — use the Read tool to view them before responding]\n${paths.map((p) => `- ${p}`).join('\n')}` : ''
    const existing = getChatSession(sessionId)
    if (existing) return `${message}${imageNote}`
    const issue = issueId ? await linear.getIssue(issueId) : undefined
    const framing = buildDesignPrompt({ projectDir: resolveProjectDir(projectId), designDir, issue, synthesis: getSynthesis(projectId) })
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
  if (previousDir !== newDir && existsSync(previousDir) && !existsSync(newDir)) {
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
    const plansMatch = path.match(/^\/api\/plans(?:\/([^/]+)(\/apply))?$/)
    if (plansMatch) {
      const [, planId, apply] = plansMatch
      if (!planId && req.method === 'POST') {
        try {
          const body = await readBody(req)
          const title = typeof body.title === 'string' ? body.title.trim() : undefined
          const content = typeof body.content === 'string' ? body.content.trim() : ''
          if (!content) return json(res, 400, { error: 'content is required' })
          const plan = savePlan({
            title,
            content,
            issueId: typeof body.issueId === 'string' ? body.issueId : undefined,
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
            createdAt: new Date().toISOString(),
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
  })
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'start') handleStart(ws, msg)
      else if (msg.type === 'stop') handleStop(ws, msg)
      else if (msg.type === 'restart') handleRestart(ws, msg)
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
