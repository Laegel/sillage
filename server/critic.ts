import { execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { buildCritiquePrompt, runClaude, SILLAGE_ROOT } from './agent.ts'
import { captureConfigFor, captureParamNames, type CaptureConfig } from './project-map.ts'
import type { AgentEvent } from './types.ts'

const execFileAsync = promisify(execFile)

// Not exported from index.ts (would create a circular import once index.ts
// imports from this file) — same value, derived independently from the one
// shared root both files already agree on.
const CRITIC_DIR = join(SILLAGE_ROOT, 'uploads', 'critic')

// The mechanical "does a bar exist for this issue" check — no LLM involved.
// `ok: false` must mean exactly "behave as if the gauntlet loop doesn't exist"
// (no design was ever intended for this issue, or this project has no
// capture command configured at all) — never "something is wrong but we'll
// proceed anyway." Once resolveBar returns ok:true elsewhere in the pipeline,
// every later failure must become a retry task or a human escalation, never
// a silent pass — see runGauntlet.
export type BarResolution =
  | { ok: true; mockup: string; cfg: CaptureConfig; params: Record<string, string> }
  | { ok: false; why: string }

export function resolveBar(issueId: string, projectDir: string): BarResolution {
  // Mirrors resolveDesignDir's linked-session branch (server/index.ts) without
  // needing a sessionId — a linked design's path is always design/<issueId>,
  // and the on-disk linkage (handleDesignLinkIssue's rename) is the durable
  // half; the in-memory designSessionIssue map is not consulted here on
  // purpose, since it's lost on every server restart.
  const designDir = join(projectDir, 'design', issueId)
  const mockup = join(designDir, 'index.html')
  if (!existsSync(mockup)) return { ok: false, why: 'no design mockup linked to this issue' }

  const cfg = captureConfigFor(basename(projectDir))
  if (!cfg) return { ok: false, why: `no capture command configured for project "${basename(projectDir)}"` }

  const captureJsonPath = join(designDir, 'capture.json')
  if (!existsSync(captureJsonPath)) return { ok: false, why: 'mockup exists but has no capture.json alongside it' }

  let params: Record<string, unknown>
  try {
    const parsed = JSON.parse(readFileSync(captureJsonPath, 'utf8'))
    params = (parsed && typeof parsed === 'object' && parsed.params) || {}
  } catch {
    return { ok: false, why: 'capture.json exists but is not valid JSON' }
  }

  const required = captureParamNames(cfg)
  const missing = required.filter((name) => typeof params[name] !== 'string' || !params[name])
  if (missing.length > 0) {
    return { ok: false, why: `capture.json is missing required param(s): ${missing.join(', ')}` }
  }

  return { ok: true, mockup, cfg, params: params as Record<string, string> }
}

// resolveBar's ok:false must mean "no bar" to every consumer — EXCEPT
// runGauntlet, which needs to tell "no design was ever intended" (stay
// inert, exactly today's behavior) apart from "a design exists but isn't on
// the branch currently checked out" (a git-state problem that would
// otherwise silently turn this whole feature off with no signal at all —
// see the commit-first ordering note on the plan). Only called when
// resolveBar already said no, since it costs real git subprocess calls that
// the fast, sync, filesystem-only common case shouldn't pay for.
export async function findDivergedBarBranch(issueId: string, projectDir: string): Promise<string | undefined> {
  let branches: string
  try {
    ;({ stdout: branches } = await execFileAsync('git', ['branch', '--list', `feat/${issueId}-*`, '--format=%(refname:short)'], { cwd: projectDir }))
  } catch {
    return undefined
  }
  for (const branch of branches.split('\n').map((b) => b.trim()).filter(Boolean)) {
    try {
      const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', branch, '--', `design/${issueId}/index.html`], { cwd: projectDir })
      if (stdout.trim()) return branch
    } catch {
      // ls-tree failing for one candidate branch shouldn't abort checking
      // the rest — just means this particular branch has no such tree entry.
    }
  }
  return undefined
}

// snap chromium (both `chromium` and `chromium-browser` route to the same
// /snap/bin/chromium here) can only read/write under $HOME — no /tmp — and
// reuses whatever --user-data-dir it's given, so every capture gets its own
// scratch profile dir rather than sharing one across concurrent rounds.
async function captureMockup(mockupHtml: string, out: string, [w, h]: [number, number], profileDir: string): Promise<void> {
  mkdirSync(profileDir, { recursive: true })
  await execFileAsync(
    process.env.CHROMIUM_BIN || 'chromium-browser',
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      `--user-data-dir=${profileDir}`,
      `--window-size=${w},${h}`,
      `--screenshot=${out}`,
      `file://${mockupHtml}`,
    ],
    { timeout: 60_000 },
  )
}

async function captureOurs(projectDir: string, cfg: CaptureConfig, params: Record<string, string>, out: string): Promise<void> {
  const substitute = (arg: string) => arg.replace(/\{(\w+)\}/g, (_, key: string) => (key === 'out' ? out : (params[key] ?? '')))
  const [bin, ...rest] = cfg.command.map(substitute)
  await execFileAsync(bin, rest, {
    cwd: projectDir,
    timeout: cfg.timeoutMs ?? 300_000,
    env: cfg.env ? { ...process.env, ...cfg.env } : process.env,
  })
}

// Exit code 0 with a blank or missing PNG is exactly the "trust the exit
// code" failure this whole feature exists to kill — a launch that silently
// no-ops (wrong scene name accepted but not applied, window never actually
// drawn, capture fired before the first real frame) must not read as success.
async function assertRealScreenshot(png: string): Promise<void> {
  if (!existsSync(png)) throw new Error(`capture produced no file at ${png}`)
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('identify', ['-format', '%w %h %[fx:standard_deviation]', png]))
  } catch (err: any) {
    throw new Error(`capture produced an unreadable image (${png}): ${err.message}`)
  }
  const [w, h, sd] = stdout.trim().split(/\s+/).map(Number)
  if (!w || !h) throw new Error(`capture produced an unreadable image (${png})`)
  if (!(sd >= 0.01)) throw new Error(`capture produced a blank/uniform image (${png}) — the app or the renderer never drew anything`)
}

async function normalizeTo(png: string, [w, h]: [number, number]): Promise<void> {
  await execFileAsync('convert', [png, '-strip', '-resize', `${w}x${h}!`, png])
}

// compare's exit code is 1 whenever the images differ beyond its default
// fuzz — that is the EXPECTED case, not a failure, so a non-zero exit here
// must not be treated as this function throwing. Only a real tool failure
// (binary missing, bad args) should propagate: distinguished by err.code's
// type — a number means "the process ran and exited non-zero" (safe to read
// its stdout/stderr), a string like 'ENOENT' means it never ran at all.
async function imagesAreIdentical(a: string, b: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync('compare', ['-metric', 'AE', a, b, 'null:'])
    return (stdout + stderr).trim() === '0'
  } catch (err: any) {
    if (typeof err.code === 'number') return false
    throw err
  }
}

function sanitizeForPath(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export type CaptureRoundResult = { aPath: string; bPath: string; mockupIsA: boolean; roundDir: string }

// Captures both sides of the A/B, normalizes them to identical dimensions,
// and validates each independently before the caller ever spends a critic
// turn on them. mockupIsA is randomized here, server-side, and returned only
// to the caller (runGauntlet) — never passed anywhere the critic could see
// it; the critic is handed plain A.png/B.png with no notion of which is
// which. See buildCritiquePrompt for the other half of this.
// The app failing to build/launch/render is the BUILDER's gap (its next
// task should be "fix this"), whereas our own chromium/identify/convert
// pipeline failing is OUR infra breaking (escalate, never silently retry
// against a broken pipeline as if it were the builder's fault). `side` lets
// the caller (runGauntlet) tell these apart without string-sniffing.
export class CaptureSideFailure extends Error {
  constructor(
    public side: 'ours',
    message: string,
  ) {
    super(message)
  }
}

export async function captureRound(bar: Extract<BarResolution, { ok: true }>, projectDir: string, issueId: string, round: number): Promise<CaptureRoundResult> {
  const roundDir = join(CRITIC_DIR, sanitizeForPath(issueId), String(round))
  mkdirSync(roundDir, { recursive: true })

  const mockupPng = join(roundDir, 'mockup.png')
  const oursPng = join(roundDir, 'ours.png')
  const profileDir = join(roundDir, 'chrome-profile')

  // Mockup-side failures are ours to fix (a broken design file, chromium
  // missing) — infra, not something a retry task can address. Only the
  // "ours" side's failures represent something the builder can act on.
  await captureMockup(bar.mockup, mockupPng, bar.cfg.viewport, profileDir)
  try {
    await captureOurs(projectDir, bar.cfg, bar.params, oursPng)
  } catch (err: any) {
    throw new CaptureSideFailure('ours', err.message)
  }

  await assertRealScreenshot(mockupPng)
  try {
    await assertRealScreenshot(oursPng)
  } catch (err: any) {
    throw new CaptureSideFailure('ours', err.message)
  }
  await normalizeTo(mockupPng, bar.cfg.viewport)
  await normalizeTo(oursPng, bar.cfg.viewport)

  if (await imagesAreIdentical(mockupPng, oursPng)) {
    throw new Error('mockup and app screenshots are pixel-identical — refusing to ask a critic to compare an image with itself')
  }

  const mockupIsA = Math.random() < 0.5
  const aPath = join(roundDir, 'A.png')
  const bPath = join(roundDir, 'B.png')
  renameSync(mockupIsA ? mockupPng : oursPng, aPath)
  renameSync(mockupIsA ? oursPng : mockupPng, bPath)

  return { aPath, bPath, mockupIsA, roundDir }
}

export type Verdict = { winner: 'A' | 'B'; gap: string }

// In-flight critiques awaiting a verdict — same memory-only idiom as
// refineReadyToConsolidate in index.ts. Keyed by a random nonce (never the
// issueId): concurrent rounds can't collide, and the critic — whose prompt
// only ever mentions this id, never the issue — has no way to learn which
// issue it's grading.
const pendingVerdicts = new Map<string, Verdict>()

// First write wins: a critic that calls this twice (retrying after its own
// mistake, or a rogue duplicate call) cannot flip a verdict already recorded.
// Returns false for an unknown id too, which the caller (the /verdict
// endpoint) turns into a 404 — either the critiqueId was never issued, or it
// already has an answer.
export function recordVerdict(critiqueId: string, verdict: Verdict): boolean {
  if (pendingVerdicts.has(critiqueId)) return false
  pendingVerdicts.set(critiqueId, verdict)
  return true
}

function takeVerdict(critiqueId: string): Verdict | undefined {
  const v = pendingVerdicts.get(critiqueId)
  pendingVerdicts.delete(critiqueId)
  return v
}

// Same fenced-json-block convention DRIVER_ACTIONS_BLOCK already uses in
// index.ts — a backstop, not a second primary mechanism. If the critic never
// called the /verdict endpoint (network hiccup, a curl typo), scan its own
// assistant text for the same {"winner":...,"gap":...} shape it was asked to
// curl. Both empty means the comparison is discarded, never treated as a pass
// — see runGauntlet.
const VERDICT_JSON_BLOCK = /\{[^{}]*"winner"\s*:\s*"([AB])"[^{}]*"gap"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*\}/i

// bash's standard way to embed a literal single quote inside a single-quoted
// string is close-quote, insert a literal quote via double-quotes, reopen
// quote — which injects a bare " into the RAW command text wherever the
// critic's gap contains an apostrophe (a very common word, "it's", "button's
// color" — not a rare edge case). That bare " looks like a JSON string
// terminator to the regex above and truncates the match. Caught live: a real
// critic run produced a fully correct verdict that got chopped down to just
// {"winner":"A","gap":"B'"} because of exactly this.
const BASH_SINGLE_QUOTE_ESCAPE = /'"'"'/g

export function extractVerdictFromText(text: string): Verdict | undefined {
  const match = text.replace(BASH_SINGLE_QUOTE_ESCAPE, "'").match(VERDICT_JSON_BLOCK)
  if (!match) return undefined
  try {
    const gap = JSON.parse(`"${match[2]}"`)
    return typeof gap === 'string' && gap.trim() ? { winner: match[1] as 'A' | 'B', gap: gap.trim() } : undefined
  } catch {
    return undefined
  }
}

// One fresh, read-only, MCP-less Claude turn with nobody driving it — the
// critic never resumes the implement session (it must have zero memory of
// how hard the builder tried) and never sees the Linear issue (noMcp), so
// blindness is enforced by session and tool isolation, not just by shuffled
// filenames. cwd is the isolated round directory: A.png/B.png live there, and
// guard-scope.js confines any Bash the critic runs to that same directory —
// there is no path from which it could stumble onto design/<issueId>/index.html
// and identify which image is the reference.
export async function runCritique({
  roundDir,
  intent,
  onOutput,
  onProcess,
}: {
  roundDir: string
  intent: string
  onOutput: (event: AgentEvent) => void
  onProcess?: (proc: ChildProcess, logFile: string) => void
}): Promise<Verdict | undefined> {
  const critiqueId = randomUUID()
  const prompt = buildCritiquePrompt({ intent, critiqueId })
  // The verdict JSON lives inside the curl command's own -d argument — a
  // tool_call event's `input`, not narrated prose — so the backstop has to
  // scan that too, not just kind:'text' events. Caught live: a critic whose
  // curl genuinely ran (just failed for an unrelated reason, e.g. hitting the
  // wrong server during testing) narrated only "verdict posted" in text, with
  // the actual {"winner":...,"gap":...} sitting in the Bash tool_call's input
  // the whole time.
  let searchable = ''

  await runClaude({
    prompt,
    projectDir: roundDir,
    onOutput: (event) => {
      if (event.kind === 'text') searchable += event.text
      else if (event.kind === 'tool_call' && event.tool === 'Bash' && event.input && typeof event.input === 'object' && 'command' in event.input) {
        searchable += String((event.input as { command: unknown }).command)
      }
      onOutput(event)
    },
    session: { id: randomUUID(), resume: false },
    readOnly: true,
    noMcp: true,
    onProcess,
  })

  return takeVerdict(critiqueId) ?? extractVerdictFromText(searchable)
}
