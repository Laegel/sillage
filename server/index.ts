import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { WebSocketServer, type WebSocket } from 'ws'
import { getLinearStore, STATUS_COLUMNS } from './linear.ts'
import { classify } from './classify.ts'
import {
  buildPrompt,
  buildRefinePrompt,
  CONSOLIDATE_PROMPT,
  RESUME_RECAP_PROMPT,
  runClaude,
  runFree,
  runOpencode,
  runKilocode,
  runMockAgent,
} from './agent.ts'
import { resolveProjectDir } from './project-map.ts'
import { getChatSession, saveChatSession, type ChatBackend } from './chat-store.ts'
import type { AgentEvent } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const PORT = Number(process.env.PORT || 4390)
const linear = getLinearStore()

const clients = new Set<WebSocket>()
const active = new Map<string, { issueId: string; task: string; events: AgentEvent[]; done: boolean }>()
const activeRefine = new Map<string, { issueId: string }>()

function broadcast(payload: Record<string, unknown>) {
  const message = JSON.stringify(payload)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(message)
  }
}

// Real-time changes arrive via Linear webhooks (POST /webhooks/linear).

function send(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload))
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
    broadcast({ type: 'pr_created', prUrl, issueId })
    if (issueId) broadcast({ type: 'issue_updated', issueId })
    json(res, 200, { ok: true, linearUpdated })
  } catch (err: any) {
    json(res, 500, { ok: false, error: err.message })
  }
}

function verifyLinearWebhook(req: IncomingMessage, rawBody: string): boolean {
  const secret = process.env.LINEAR_WEBHOOK_SECRET
  if (!secret) {
    console.warn('[linear-webhook] LINEAR_WEBHOOK_SECRET not set — accepting webhook without signature check')
    return true
  }
  const header = req.headers['linear-signature']
  if (typeof header !== 'string') return false
  const headerSig = Buffer.from(header, 'hex')
  const computed = createHmac('sha256', secret).update(rawBody).digest()
  return headerSig.length === computed.length && timingSafeEqual(computed, headerSig)
}

async function handleLinearWebhook(req: IncomingMessage, res: ServerResponse) {
  const raw = await readRawBody(req)
  if (!verifyLinearWebhook(req, raw)) {
    return json(res, 401, { ok: false, error: 'invalid signature' })
  }
  let body: any
  try {
    body = JSON.parse(raw)
  } catch {
    return json(res, 400, { ok: false, error: 'invalid JSON body' })
  }
  if (body.webhookTimestamp && Math.abs(Date.now() - body.webhookTimestamp) > 60_000) {
    return json(res, 401, { ok: false, error: 'stale webhook' })
  }
  const { action, type, data } = body
  const issueId = data?.identifier || data?.id
  if (type !== 'Issue') return json(res, 200, { ok: true })

  if (action === 'create') {
    try {
      const issue = await linear.getIssue(issueId)
      broadcast({ type: 'issue_created', issue })
    } catch (err: any) {
      console.error('[linear-webhook] failed to load created issue:', err.message)
      if (issueId) broadcast({ type: 'issue_created', issueId })
    }
  } else if (action === 'update') {
    if (issueId) broadcast({ type: 'issue_updated', issueId })
  } else if (action === 'remove') {
    if (issueId) broadcast({ type: 'issue_removed', issueId })
  }
  json(res, 200, { ok: true })
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
      return json(res, 405, { error: 'method not allowed' })
    }
    return json(res, 404, { error: 'not found' })
  } catch (err: any) {
    return json(res, 500, { error: err.message })
  }
}

async function runTask({
  issueId,
  task,
  onOutput,
}: {
  issueId: string
  task: string
  onOutput: (event: AgentEvent) => void
}) {
  const issue = await linear.getIssue(issueId)
  const classification = classify(task)

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
    return runMockAgent({ issueId, classification, onOutput })
  }

  const projectDir = resolveProjectDir(issue.project)
  const agentChoice = await linear.resolveAgentChoice(issueId)
  const prompt = await buildPrompt({ issue, task, classification, projectDir })

  const agentLabels = {
    claude: 'Claude Code',
    free: 'Free (OpenCode, falling back to Kilo Code if needed)',
  } as const
  const agentRunners = { claude: runClaude, free: runFree } as const
  const agentLabel = agentLabels[agentChoice]
  onOutput({ kind: 'orchestrator', text: `Using ${agentLabel}.` })

  // No silent mock-agent fallback here on purpose: falling back to the demo mock when
  // a real, configured agent fails would make it write a fabricated PR link and a real
  // Linear status change for work that never happened — misleading, not helpful. The
  // mock agent only ever runs when USE_MOCK_AGENT=true is explicitly set above; a real
  // agent failing here is reported as a real failure instead.
  let run
  try {
    run = await agentRunners[agentChoice]({ prompt, projectDir, onOutput })
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error(`${agentLabel} binary not found on this machine.`)
    }
    throw err
  }

  if (run.needsFallback) {
    throw new Error(`${agentLabel} exited without producing any output — no real work was done. This can happen from an exhausted free-tier quota, an auth problem, or a crash; check the agent's own logs.`)
  }
  return run
}

function handleStart(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  const task = payload.task
  if (!issueId || !task) {
    send(ws, { type: 'error', message: 'issueId and task are required' })
    return
  }
  if (active.has(issueId)) {
    send(ws, { type: 'error', issueId, message: 'A task is already running for this issue' })
    return
  }

  const state = { issueId, task, events: [] as AgentEvent[], done: false }
  active.set(issueId, state)

  runTask({
    issueId,
    task,
    onOutput: (event) => {
      state.events.push(event)
      broadcast({ type: 'output', issueId, event })
    },
  })
    .then((result) => {
      state.done = true
      broadcast({ type: 'done', issueId, exitCode: result?.exitCode })
    })
    .catch((err) => {
      console.error(`[task ${issueId}] failed:`, err)
      state.done = true
      broadcast({ type: 'error', issueId, message: err.message })
    })
    .finally(() => {
      active.delete(issueId)
    })

  const classification = classify(task)
  broadcast({ type: 'task_started', issueId, classification, task })
  send(ws, { type: 'started', issueId, classification })
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
  const existing = getChatSession(issueId)

  let run: { exitCode: number | null; needsFallback: boolean; sessionId?: string }
  let backend: ChatBackend

  if (existing?.backend === 'claude') {
    run = await runClaude({ prompt, projectDir, onOutput, session: { id: existing.sessionId, resume: true } })
    backend = 'claude'
  } else if (existing?.backend === 'opencode') {
    run = await runOpencode({ prompt, projectDir, onOutput, sessionId: existing.sessionId })
    backend = 'opencode'
  } else if (existing?.backend === 'kilocode') {
    run = await runKilocode({ prompt, projectDir, onOutput, sessionId: existing.sessionId })
    backend = 'kilocode'
  } else {
    const agentChoice = await linear.resolveAgentChoice(issueId)
    if (agentChoice === 'claude') {
      run = await runClaude({ prompt, projectDir, onOutput, session: { id: randomUUID(), resume: false } })
      backend = 'claude'
    } else {
      const freeRun = await runFree({ prompt, projectDir, onOutput })
      run = freeRun
      backend = freeRun.backend
    }
  }

  if (run.needsFallback) {
    throw new Error('The agent exited without producing any output for this refine turn — no real response was generated. Check the agent\'s own logs.')
  }
  if (run.sessionId) saveChatSession(issueId, backend, run.sessionId)
  return run
}

// Shared by the three refine WS handlers below: runs one turn in the background,
// streaming output the same way handleStart/runTask does for implementation runs,
// but against the separate activeRefine map since a card can only be refining or
// implementing, never both, and the two must not be confused.
function runRefine(issueId: string, buildTurnPrompt: () => Promise<string> | string): boolean {
  if (activeRefine.has(issueId)) return false
  activeRefine.set(issueId, { issueId })

  ;(async () => {
    try {
      const prompt = await buildTurnPrompt()
      broadcast({ type: 'refine_turn_started', issueId })
      await runRefineTurn({
        issueId,
        prompt,
        onOutput: (event) => broadcast({ type: 'refine_output', issueId, event }),
      })
      broadcast({ type: 'refine_turn_done', issueId })
    } catch (err: any) {
      console.error(`[refine ${issueId}] failed:`, err)
      broadcast({ type: 'error', issueId, message: err.message })
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
    const classification = classify(`${issue.title} ${issue.description}`)
    const projectDir = resolveProjectDir(issue.project)
    return buildRefinePrompt({ issue, classification, projectDir })
  })
  if (!started) send(ws, { type: 'error', issueId, message: 'A refine turn is already running for this issue' })
}

function handleRefineMessage(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  const message = payload.message
  if (!issueId || !message) return send(ws, { type: 'error', message: 'issueId and message are required' })
  const started = runRefine(issueId, () => message)
  if (!started) send(ws, { type: 'error', issueId, message: 'A refine turn is already running for this issue' })
}

function handleRefineConsolidate(ws: WebSocket, payload: any) {
  const issueId = payload.issueId
  if (!issueId) return send(ws, { type: 'error', message: 'issueId is required' })
  const started = runRefine(issueId, () => CONSOLIDATE_PROMPT)
  if (!started) send(ws, { type: 'error', issueId, message: 'A refine turn is already running for this issue' })
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
    if (path === '/webhooks/linear' && req.method === 'POST') return handleLinearWebhook(req, res)
    if (path.startsWith('/api/linear')) return handleLinearApi(req, res, path)
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
  })
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'start') handleStart(ws, msg)
      else if (msg.type === 'refine_start') handleRefineStart(ws, msg)
      else if (msg.type === 'refine_message') handleRefineMessage(ws, msg)
      else if (msg.type === 'refine_consolidate') handleRefineConsolidate(ws, msg)
    } catch {
      send(ws, { type: 'error', message: 'invalid message' })
    }
  })
  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))
})

server.listen(PORT, () => {
  console.log(`orchestrator listening on http://127.0.0.1:${PORT}`)
  console.log('[linear-webhook] push endpoint enabled at /webhooks/linear (replace polling)')
})
