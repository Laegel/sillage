import { type ChildProcessByStdio, spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Classification } from './classify.ts'
import type { AgentEvent, Issue } from './types.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PILOT_ROOT = join(__dirname, '..')

export async function buildPrompt({
  issue,
  task,
  classification,
  projectDir,
}: {
  issue: Issue
  task: string
  classification: Classification
  projectDir: string
}): Promise<string> {
  const skillFile = join(PILOT_ROOT, '.claude', 'skills', classification, 'SKILL.md')
  let skill = ''
  try {
    skill = await readFile(skillFile, 'utf8')
  } catch {
    skill = '(skill file not found)'
  }
  return `You are a software engineer working in the repository at ${projectDir}.

LINEAR ISSUE
- identifier: ${issue.id}
- title: ${issue.title}
- description: ${issue.description}
- current status: ${issue.status}

USER TASK
${task}

This task is classified as: ${classification}. Follow the ${classification} skill below exactly.

=== ${classification.toUpperCase()} SKILL ===
${skill}
=== END SKILL ===

RULES (also enforced by CLAUDE.md)
1. Before doing anything else, check for existing work on this issue: run \`git branch --list 'feat/${issue.id}-*'\` and \`git status\`, and use the Linear MCP to re-read the issue's current comments — a prior attempt may have left a blocker note or partial-progress explanation there. If a matching branch already exists, check it out (if not already on it) and CONTINUE from there instead of starting over — assess what's already done (git status, git diff, git log) and what still remains, then pick up where it left off. Only create a new branch named feat/${issue.id}-<kebab-slug> (for example feat/${issue.id}-add-toggle) if none already exists.
2. Commit messages must be prefixed with the Linear issue id: "${issue.id}: <summary>".
3. The PR description MUST reference the Linear issue id ${issue.id}.
4. Do NOT send any manual notification about the PR. A PostToolUse hook detects "gh pr create" and notifies the orchestrator.
5. Before opening a PR, check whether one already exists for this branch (e.g. \`gh pr list --head <branch>\`). If one exists, just push your commits to update it — do not open a duplicate. Otherwise open it with: gh pr create --title "<title>" --body "Closes ${issue.id} — <summary>"
6. Use the GitHub MCP for commit, push and PR creation. Use the Linear MCP to re-read the issue and, once the PR is open, set its status to "In Review" and attach the PR link as a comment.
7. If you get blocked — missing information, an ambiguous requirement, a decision only a human should make, or something you genuinely can't resolve yourself — stop rather than guessing or shipping something you're not confident in. Commit whatever real progress you've made first (so a resumed run doesn't lose it, per rule 1), then use the Linear MCP to: (a) add a comment on the issue stating exactly what's blocking you and what you need to proceed, @mentioning the workspace owner in that comment so they're actually notified (use the Linear MCP's own current-user/viewer lookup, or the issue's creator, to find who to mention — don't guess a name), (b) add the "Blocked" label to the issue, and (c) set the issue status back to "Todo". Do not open a PR for blocked or incomplete work.
8. When you narrate progress outside of tool calls, keep it to short, single-line notes at natural checkpoints (e.g. after finishing a step) rather than long paragraphs — this is read as a live log, not a report.`
}

// First-turn framing for a "Refine" chat: unlike buildPrompt(), this never writes
// code, commits, opens a PR, or touches Linear status/labels — it's a codebase
// reality-check discussion for a still-raw Backlog idea, not an implementation run.
export async function buildRefinePrompt({
  issue,
  classification,
  projectDir,
}: {
  issue: Issue
  classification: Classification
  projectDir: string
}): Promise<string> {
  const skillFile = join(PILOT_ROOT, '.claude', 'skills', classification, 'SKILL.md')
  let skill = ''
  try {
    skill = await readFile(skillFile, 'utf8')
  } catch {
    skill = '(skill file not found)'
  }
  return `You are reviewing a Linear issue that is still an unrefined idea, in the repository at ${projectDir}.

LINEAR ISSUE
- identifier: ${issue.id}
- title: ${issue.title}
- description: ${issue.description}

This issue looks like it falls under: ${classification}. The ${classification} skill below may help you judge feasibility and existing conventions, but this is a discussion, not an implementation task — do not follow its implementation steps yet.

=== ${classification.toUpperCase()} SKILL ===
${skill}
=== END SKILL ===

RULES FOR THIS DISCUSSION
1. Explore the codebase read-only to check this idea against reality: does it fit the existing structure, is anything already half-built, are there naming/pattern conflicts, is anything technically infeasible as described?
2. Do NOT write or modify any files, do NOT create a git branch or commit, do NOT open a PR, and do NOT change this issue's Linear status or labels yourself — this is exploration and discussion only.
3. Present 2-4 concrete options or a clear feasibility assessment with trade-offs, grounded in what you actually found in the codebase (cite real file paths).
4. If something is genuinely ambiguous or needs a decision only the user can make, ask a specific question instead of guessing.
5. Keep it conversational and concise — this is a live back-and-forth discussion, not a report.`
}

// Sent as a same-session follow-up turn once the user clicks "Consolidate".
export const CONSOLIDATE_PROMPT = `Based on our discussion so far, write a final, self-contained issue description that captures the agreed plan: the concrete goal, the approach, and any important constraints or decisions we made. Do not include meta-commentary about the discussion itself (no "we discussed" or "the user asked") — write it as the issue description should read on its own, ready for implementation. Do not write any code and do not touch git, GitHub, or Linear.`

// Sent instead of buildRefinePrompt() when a chat session already exists (e.g. the
// page was reloaded) — pilot doesn't persist the transcript itself, so this is how
// a reopened chat shows something instead of a blank panel.
export const RESUME_RECAP_PROMPT = `Give me a brief recap of our discussion so far and where we left off.`

function hookCommand(file: string): string {
  return `node ${join(PILOT_ROOT, '.claude', 'hooks', file)}`
}

// Force-loads the safety hooks regardless of the spawned agent's cwd — Claude Code
// otherwise discovers .claude/settings.json relative to cwd, which is now an
// arbitrary project folder under perso, not this repo.
function buildSettingsJson(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: hookCommand('guard-scope.js') }] }],
      PostToolUse: [
        { matcher: 'Bash|gh pr create', hooks: [{ type: 'command', command: hookCommand('notify-pr.js') }] },
        { matcher: 'mcp__github__.*', hooks: [{ type: 'command', command: hookCommand('notify-pr.js') }] },
      ],
    },
  })
}

export function spawnClaude(
  prompt: string,
  projectDir: string,
  session?: { id: string; resume: boolean },
): ChildProcessByStdio<null, Readable, Readable> {
  const bin = process.env.CLAUDE_BIN || 'claude'
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
    '--strict-mcp-config',
    '--mcp-config',
    join(PILOT_ROOT, '.claude', '.mcp.json'),
    '--settings',
    buildSettingsJson(),
  ]
  if (session) args.push(session.resume ? '--resume' : '--session-id', session.id)
  return spawn(bin, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      ORCHESTRATOR_URL: `http://127.0.0.1:${process.env.PORT || 4390}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function isAuthError(result: string): boolean {
  return /not logged in|login required|please run \/login/i.test(result || '')
}

// Claude's tool_result content is either a plain string or an array of content
// blocks (text/image/...) — mirrors the shape opencode's formatToolEvent already
// handles as a single `output` string, so results read the same way either agent.
function stringifyClaudeToolContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : JSON.stringify(c)))
      .join('\n')
  }
  return content ? JSON.stringify(content) : ''
}

// Claude splits a tool call across two separate stream messages — an assistant
// tool_use block (id, name, input — nothing about the result yet) followed later
// by a user tool_result block (id, is_error, content) — correlated by id. This
// builds the AgentEvent for either half; the caller (runClaude) uses the same id
// for both so the frontend updates one card in place instead of appending two.
function claudeToolCallEvent(
  id: string,
  toolName: string,
  input: unknown,
  status: 'running' | 'complete' | 'error',
  content?: unknown,
): AgentEvent {
  const label = summarizeToolInput(input) || toolName
  if (status === 'running') {
    return { kind: 'tool_call', id, tool: toolName, label, status, input }
  }
  const text = stringifyClaudeToolContent(content)
  const trimmed = text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text
  return status === 'error'
    ? { kind: 'tool_call', id, tool: toolName, label, status, input, error: trimmed }
    : { kind: 'tool_call', id, tool: toolName, label, status, input, output: trimmed }
}

export function runClaude({
  prompt,
  projectDir,
  onOutput,
  session,
}: {
  prompt: string
  projectDir: string
  onOutput: (event: AgentEvent) => void
  session?: { id: string; resume: boolean }
}): Promise<{ exitCode: number | null; needsFallback: boolean; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaude(prompt, projectDir, session)
    let result = ''
    let sawResult = false
    let fallback = false
    let settled = false
    let stderrText = ''
    // assistant messages announce a tool_use; the matching tool_result (the actual
    // output) only arrives later in a "user" message — held here until paired up.
    const pendingTools = new Map<string, { name: string; input: unknown }>()

    proc.on('error', (err) => reject(err))

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true
        if (!sawResult) {
          fallback = true
          if (stderrText) onOutput({ kind: 'orchestrator', text: `claude stderr: ${stderrText}` })
        }
        resolve({ exitCode: code, needsFallback: fallback, sessionId: session?.id })
      }
    })

    proc.stderr.on('data', (chunk) => {
      stderrText += chunk.toString()
    })

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'assistant') {
          const parts = Array.isArray(msg.message?.content) ? msg.message.content : []
          for (const part of parts) {
            if (part && typeof part === 'object' && part.type === 'text' && part.text) {
              onOutput({ kind: 'text', text: part.text })
            } else if (part && typeof part === 'object' && part.type === 'tool_use' && part.id) {
              pendingTools.set(part.id, { name: part.name, input: part.input })
              onOutput(claudeToolCallEvent(part.id, part.name, part.input, 'running'))
            } else if (typeof part === 'string') {
              onOutput({ kind: 'text', text: part })
            }
            // "thinking" blocks are intentionally skipped: usually empty in the
            // consolidated message (the readable text only lives in partial
            // stream_event deltas we don't otherwise use) and not user-facing.
          }
        } else if (msg.type === 'user') {
          const parts = Array.isArray(msg.message?.content) ? msg.message.content : []
          for (const part of parts) {
            if (part && typeof part === 'object' && part.type === 'tool_result' && part.tool_use_id) {
              const pending = pendingTools.get(part.tool_use_id)
              pendingTools.delete(part.tool_use_id)
              onOutput(
                claudeToolCallEvent(
                  part.tool_use_id,
                  pending?.name || 'tool',
                  pending?.input,
                  part.is_error ? 'error' : 'complete',
                  part.content,
                ),
              )
            }
          }
        } else if (msg.type === 'system' && msg.subtype === 'post_turn_summary') {
          onOutput({
            kind: 'status',
            category: msg.status_category,
            detail: msg.status_detail,
            needsAction: msg.needs_action || undefined,
          })
        } else if (msg.type === 'result') {
          sawResult = true
          result = msg.result || ''
          if (msg.is_error && isAuthError(result)) {
            fallback = true
            proc.kill('SIGTERM')
          }
        }
      } catch {
        if (line.trim()) onOutput({ kind: 'orchestrator', text: line })
      }
    })
  })
}

interface ClaudeMcpServer {
  type: string
  url: string
  headers?: Record<string, string>
}

function substituteEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '')
}

// Reuses .claude/.mcp.json as the single source of truth for which MCP servers the
// agent gets, instead of a second hardcoded list that could drift out of sync.
// Claude Code reads this file directly via --mcp-config; opencode and kilocode (a
// fork of opencode, same config schema) have no equivalent flag, so its shape
// (mcpServers, type: "http") is translated into their config shape (mcp, type:
// "remote") and merged into OPENCODE_CONFIG_CONTENT / KILO_CONFIG_CONTENT.
async function loadMcpConfig(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(PILOT_ROOT, '.claude', '.mcp.json'), 'utf8')
  const { mcpServers } = JSON.parse(raw) as { mcpServers: Record<string, ClaudeMcpServer> }
  const mcp: Record<string, unknown> = {}
  for (const [name, server] of Object.entries(mcpServers)) {
    mcp[name] = {
      type: 'remote',
      url: server.url,
      ...(server.headers && {
        headers: Object.fromEntries(Object.entries(server.headers).map(([k, v]) => [k, substituteEnvVars(v)])),
      }),
    }
  }
  return mcp
}

// Equivalent of buildSettingsJson()/guard-scope.js for opencode/kilocode: their shared
// permission system has a dedicated "external_directory" rule, injected via
// OPENCODE_CONFIG_CONTENT / KILO_CONFIG_CONTENT (merges over, doesn't replace, the
// project's own opencode.json) so the agent can't touch anything outside its cwd
// even with permissions auto-approved.
//
// A blanket `{'*': 'deny'}` isn't enough: their read/write/edit tools don't reliably
// recognize an absolute path pointing inside their own --dir as "internal" —
// confirmed live, e.g. `[read] /home/.../songe/AGENTS.md` was denied even though
// AGENTS.md is the project's own file. That forced the agent to fight the tool's
// own permission checks instead of doing the task. Explicitly allowing the project
// dir itself (the documented pattern for scoping external_directory) fixes this.
async function buildRunnerConfigContent(projectDir: string): Promise<string> {
  return JSON.stringify({
    permission: {
      external_directory: {
        [`${projectDir}/*`]: 'allow',
        [projectDir]: 'allow',
        '*': 'deny',
      },
    },
    mcp: await loadMcpConfig(),
  })
}

export async function spawnOpencode(prompt: string, projectDir: string, sessionId?: string): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const bin = process.env.OPENCODE_BIN || 'opencode'
  const model = process.env.OPENCODE_MODEL || 'opencode/big-pickle'
  // --dir is required, not just spawn()'s cwd option: opencode resolves its working
  // directory from the (possibly stale, inherited-from-this-server-process) PWD env
  // var in some code paths, which silently misdirects file writes to wherever this
  // orchestrator itself happens to be running from instead of the target project.
  // Confirmed via a live reproduction — --dir plus a corrected PWD closes it.
  const args = ['-m', model, 'run', prompt, '--format', 'json', '--auto', '--dir', projectDir]
  if (sessionId) args.push('-s', sessionId)
  return spawn(bin, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      PWD: projectDir,
      ORCHESTRATOR_URL: `http://127.0.0.1:${process.env.PORT || 4390}`,
      OPENCODE_CONFIG_CONTENT: await buildRunnerConfigContent(projectDir),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export async function spawnKilocode(prompt: string, projectDir: string, sessionId?: string): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const bin = process.env.KILOCODE_BIN || 'kilocode'
  const model = process.env.KILOCODE_MODEL || 'kilo/kilo-auto/free'
  // --dangerously-skip-permissions, not --auto: kilocode has both, worded differently
  // ("auto-approve permissions not explicitly denied" vs "auto-approve ALL permissions").
  // The former is the one that matches opencode's --auto and is documented to still
  // respect explicit deny rules — verified live against external_directory before relying on it.
  const args = ['-m', model, 'run', prompt, '--format', 'json', '--dangerously-skip-permissions', '--dir', projectDir]
  if (sessionId) args.push('-s', sessionId)
  return spawn(bin, args, {
    cwd: projectDir,
    env: {
      ...process.env,
      PWD: projectDir,
      ORCHESTRATOR_URL: `http://127.0.0.1:${process.env.PORT || 4390}`,
      KILO_CONFIG_CONTENT: await buildRunnerConfigContent(projectDir),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  if (typeof obj.command === 'string') return obj.command
  if (typeof obj.filePath === 'string') return obj.filePath
  const json = JSON.stringify(obj)
  return json.length > 200 ? `${json.slice(0, 200)}…` : json
}

// opencode's --format json emits a "tool_use" event per tool call (bash, write, edit, ...)
// separately from "text" events, and doesn't narrate every call in prose the way Claude
// tends to — without this, real tasks that run several tool calls back-to-back look like
// long silent gaps in the stream even though work is happening.
//
// Unlike Claude, there's no separate "running" phase to surface here: confirmed live
// (captured raw stdout for both an instant `ls` and a 5s `sleep` tool call) that
// opencode/kilocode only ever emit a tool_use event once already resolved to
// completed/error — the state.status field technically allows pending/running per
// their SDK types, but --format json's batch output never actually streams it.
function toolCallEventFromOpencode(part: any): AgentEvent | null {
  const state = part?.state
  if (!state || (state.status !== 'completed' && state.status !== 'error')) return null
  const label = state.title || summarizeToolInput(state.input) || part.tool
  if (state.status === 'error') {
    return { kind: 'tool_call', id: part.id, tool: part.tool, label, status: 'error', input: state.input, error: state.error }
  }
  const output = typeof state.output === 'string' ? state.output : ''
  const trimmed = output.length > 4000 ? `${output.slice(0, 4000)}\n… (truncated)` : output
  return { kind: 'tool_call', id: part.id, tool: part.tool, label, status: 'complete', input: state.input, output: trimmed }
}

// Shared by runOpencode/runKilocode/runFree — kilocode is a fork of opencode and
// emits the exact same --format json event shape (verified live: same "text"/
// "tool_use" types, same part.state shape), so all three share one stream parser.
// onProperOutput fires once, the first time real text/tool output is seen — runFree
// uses it to decide whether OpenCode is actually alive or needs to be abandoned.
function attachOpencodeFamilyStream(
  proc: ChildProcessByStdio<null, Readable, Readable>,
  onOutput: (event: AgentEvent) => void,
  onProperOutput: () => void,
  onSessionId?: (id: string) => void,
): Promise<{ exitCode: number | null; needsFallback: boolean }> {
  return new Promise((resolve, reject) => {
    let sawText = false
    let sawSessionId = false
    let settled = false
    let stderrText = ''

    proc.on('error', (err) => reject(err))

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true
        const needsFallback = !sawText && code !== 0
        if (needsFallback && stderrText) onOutput({ kind: 'orchestrator', text: `stderr: ${stderrText}` })
        resolve({ exitCode: code, needsFallback })
      }
    })

    proc.stderr.on('data', (chunk) => {
      stderrText += chunk.toString()
    })

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (!sawSessionId && msg.sessionID && onSessionId) {
          sawSessionId = true
          onSessionId(msg.sessionID)
        }
        if (msg.type === 'text' && msg.part?.text) {
          onOutput({ kind: 'text', text: msg.part.text })
          if (!sawText) onProperOutput()
          sawText = true
        } else if (msg.type === 'tool_use' && msg.part?.type === 'tool') {
          const event = toolCallEventFromOpencode(msg.part)
          if (event) {
            onOutput(event)
            if (!sawText) onProperOutput()
            sawText = true
          }
        } else if (msg.type === 'step_finish' && msg.part?.reason === 'tool-calls') {
          // Visual break between bursts of tool calls, mirroring Claude's turn
          // boundaries — makes a multi-step run scannable instead of one long stream.
          onOutput({ kind: 'separator' })
        }
      } catch {
        if (line.trim()) onOutput({ kind: 'orchestrator', text: line })
      }
    })
  })
}

async function runOpencodeFamily(
  spawnFn: (prompt: string, projectDir: string, sessionId?: string) => Promise<ChildProcessByStdio<null, Readable, Readable>>,
  {
    prompt,
    projectDir,
    onOutput,
    sessionId,
  }: {
    prompt: string
    projectDir: string
    onOutput: (event: AgentEvent) => void
    sessionId?: string
  },
): Promise<{ exitCode: number | null; needsFallback: boolean; sessionId?: string }> {
  const proc = await spawnFn(prompt, projectDir, sessionId)
  let capturedId = sessionId
  const result = await attachOpencodeFamilyStream(proc, onOutput, () => {}, (id) => {
    capturedId = id
  })
  return { ...result, sessionId: capturedId }
}

export function runOpencode(args: {
  prompt: string
  projectDir: string
  onOutput: (event: AgentEvent) => void
  sessionId?: string
}): Promise<{ exitCode: number | null; needsFallback: boolean; sessionId?: string }> {
  return runOpencodeFamily(spawnOpencode, args)
}

export function runKilocode(args: {
  prompt: string
  projectDir: string
  onOutput: (event: AgentEvent) => void
  sessionId?: string
}): Promise<{ exitCode: number | null; needsFallback: boolean; sessionId?: string }> {
  return runOpencodeFamily(spawnKilocode, args)
}

const FREE_FALLBACK_TIMEOUT_MS = 60_000

// "Free" tries OpenCode's own hosted free tier first; if it produces no real output
// within FREE_FALLBACK_TIMEOUT_MS, it's abandoned and Kilo Code's free tier (a
// different provider, a different quota pool) is tried instead. Confirmed live: an
// exhausted OpenCode daily quota hangs the process with zero stdout rather than
// erroring, so "no output yet" is the only reliable signal available here — there's
// no error event to catch. Once OpenCode starts producing real output it's trusted
// to run to completion with no further time limit.
export async function runFree({
  prompt,
  projectDir,
  onOutput,
  sessionId,
  backend,
}: {
  prompt: string
  projectDir: string
  onOutput: (event: AgentEvent) => void
  // A refine chat that already knows which of opencode/kilocode answered its
  // first turn passes both back here to talk to that exact session directly —
  // skipping the race below entirely, since it's already proven alive.
  sessionId?: string
  backend?: 'opencode' | 'kilocode'
}): Promise<{ exitCode: number | null; needsFallback: boolean; backend: 'opencode' | 'kilocode'; sessionId?: string }> {
  if (backend === 'kilocode') {
    const result = await runKilocode({ prompt, projectDir, onOutput, sessionId })
    return { ...result, backend: 'kilocode' }
  }
  if (backend === 'opencode') {
    const result = await runOpencode({ prompt, projectDir, onOutput, sessionId })
    return { ...result, backend: 'opencode' }
  }

  const proc = await spawnOpencode(prompt, projectDir, sessionId)
  let gotOutput = false
  let capturedId = sessionId
  const resultPromise = attachOpencodeFamilyStream(
    proc,
    onOutput,
    () => {
      gotOutput = true
    },
    (id) => {
      capturedId = id
    },
  )

  const timedOut = await Promise.race([
    resultPromise.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), FREE_FALLBACK_TIMEOUT_MS)),
  ])

  if (timedOut && !gotOutput) {
    onOutput({
      kind: 'orchestrator',
      text: `OpenCode produced no output within ${FREE_FALLBACK_TIMEOUT_MS / 1000}s (likely the daily free-tier quota is exhausted) — falling back to Kilo Code.`,
    })
    resultPromise.catch(() => {})
    proc.kill('SIGTERM')
    const result = await runKilocode({ prompt, projectDir, onOutput })
    return { ...result, backend: 'kilocode' }
  }

  const result = await resultPromise
  return { ...result, backend: 'opencode', sessionId: capturedId }
}

export async function runMockAgent({
  issueId,
  classification,
  onOutput,
}: {
  issueId: string
  classification: Classification
  onOutput: (event: AgentEvent) => void
}): Promise<{ exitCode: number | null; needsFallback: boolean }> {
  const hookUrl = `http://127.0.0.1:${process.env.PORT || 4390}/hook-event`
  const script = join(__dirname, 'mock-agent.js')
  const proc = spawn(process.execPath, [script, issueId, classification, hookUrl], {
    cwd: PILOT_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    proc.on('error', reject)
    proc.on('exit', (code) => resolve({ exitCode: code, needsFallback: false }))
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'assistant') {
          const parts = Array.isArray(msg.message?.content) ? msg.message.content : []
          for (const part of parts) {
            if (part && typeof part === 'object' && part.type === 'text' && part.text) {
              onOutput({ kind: 'text', text: part.text })
            }
          }
        }
      } catch {
        if (line.trim()) onOutput({ kind: 'orchestrator', text: line })
      }
    })
  })
}
