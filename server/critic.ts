import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { buildCritiquePrompt, buildVerifyPrompt, runClaude, SILLAGE_ROOT } from './agent.ts'
import { extractElementsAndScreenshot, type ExtractedElement } from './extract.ts'
import { captureConfigFor, captureParamNames, isDomInspectable, validateCaptureParams, type CaptureConfig } from './project-map.ts'
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

// A design tool export (index.html) needs chromium to render; a plain
// screenshot someone drops in the design/<issueId> folder doesn't — see
// captureMockup below, which skips chromium entirely for these extensions.
const MOCKUP_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg']

// Prefers a static image over the HTML export when both exist — a real
// screenshot is a more faithful "what this should look like" than
// re-rendering the export, which can differ from how a human's own browser
// renders it (e.g. placeholder-widget states depending on JS timing). Applies
// whether the .html path came from a step's explicit override or the default
// convention — a step naming index.html explicitly is naming "this design,"
// not "definitely re-render it with chromium," and a Refiner drafting a step
// has no reason to know a sibling screenshot was later added.
function preferSiblingImage(mockupPath: string): string {
  if (!mockupPath.toLowerCase().endsWith('.html')) return mockupPath
  const withoutExt = mockupPath.slice(0, -'.html'.length)
  for (const ext of MOCKUP_IMAGE_EXTENSIONS) {
    const candidate = withoutExt + ext
    if (existsSync(candidate)) return candidate
  }
  return mockupPath
}

// `step` is optional so the old (pre-check:'visual') no-plan callers — still
// used by runGauntlet — keep working unchanged. When a step is given, it can
// override where the mockup lives and what capture params to use, since a
// real mockup often lives wherever the design tool actually exported it
// (design/<issueId>/index.html is a convention, not a guarantee — see
// verifyStep's visual branch and Step.visual in plans-store.ts).
export function resolveBar(
  issueId: string,
  projectDir: string,
  step?: { visual?: { mockup?: string; params?: Record<string, string> } },
): BarResolution {
  // Mirrors resolveDesignDir's linked-session branch (server/index.ts) without
  // needing a sessionId — a linked design's path is always design/<issueId>,
  // and the on-disk linkage (handleDesignLinkIssue's rename) is the durable
  // half; the in-memory designSessionIssue map is not consulted here on
  // purpose, since it's lost on every server restart.
  const designDir = join(projectDir, 'design', issueId)
  const mockup = preferSiblingImage(step?.visual?.mockup ? join(projectDir, step.visual.mockup) : join(designDir, 'index.html'))
  if (!existsSync(mockup)) {
    return { ok: false, why: step?.visual?.mockup ? `mockup not found at ${step.visual.mockup}` : 'no design mockup linked to this issue' }
  }

  const cfg = captureConfigFor(basename(projectDir))
  if (!cfg) return { ok: false, why: `no capture command configured for project "${basename(projectDir)}"` }

  // Step params replace capture.json entirely — so every message names which
  // one was read. Blaming capture.json for a step's bad params (LAE-183) sent
  // the Driver and Builder to fix a file that was never consulted.
  let params: Record<string, unknown>
  let source: string
  if (step?.visual?.params) {
    params = step.visual.params
    source = 'the plan step\'s visual.params'
  } else {
    const captureJsonPath = join(designDir, 'capture.json')
    source = `design/${issueId}/capture.json`
    if (!existsSync(captureJsonPath)) {
      return { ok: false, why: `mockup exists but has no ${source} alongside it (and the step supplied no visual.params)` }
    }
    try {
      const parsed = JSON.parse(readFileSync(captureJsonPath, 'utf8'))
      params = (parsed && typeof parsed === 'object' && parsed.params) || {}
    } catch {
      return { ok: false, why: `${source} exists but is not valid JSON` }
    }
  }

  const { missing, unknown } = validateCaptureParams(cfg, params)
  if (missing.length > 0) {
    const expected = captureParamNames(cfg).map((name) => `"${name}"`).join(', ')
    const extra = unknown.length ? ` (it has unknown key(s) ${unknown.join(', ')} instead)` : ''
    return { ok: false, why: `${source} is missing required capture param(s): ${missing.join(', ')}${extra} — this project's capture command takes exactly ${expected}` }
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
      const paths = ['index.html', ...MOCKUP_IMAGE_EXTENSIONS.map((ext) => `index${ext}`)].map((f) => `design/${issueId}/${f}`)
      const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', branch, '--', ...paths], { cwd: projectDir })
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
async function captureMockup(mockupPath: string, out: string, [w, h]: [number, number], profileDir: string): Promise<void> {
  if (MOCKUP_IMAGE_EXTENSIONS.some((ext) => mockupPath.toLowerCase().endsWith(ext))) {
    copyFileSync(mockupPath, out)
    return
  }
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
      `file://${mockupPath}`,
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

// Only for domInspectable projects (see verifyStep's geometry branch).
// cfg.serveCommand does the same build+serve setup as cfg.command but prints
// a live URL instead of screenshotting — extract.ts's puppeteer then does one
// navigation to that URL for both the screenshot and the DOM walk, so what
// gets measured and what gets pictured can never drift apart. The spawned
// serve process is killed once that single page load finishes, regardless
// of outcome — it would otherwise sit there serving forever.
async function captureAndExtractOurs(
  projectDir: string,
  cfg: CaptureConfig,
  params: Record<string, string>,
  viewport: [number, number],
  screenshotPath: string,
): Promise<ExtractedElement[]> {
  if (!cfg.serveCommand) throw new Error('project has no serveCommand configured — geometry-based verification needs one')
  const substitute = (arg: string) => arg.replace(/\{(\w+)\}/g, (_, key: string) => params[key] ?? '')
  const [bin, ...rest] = cfg.serveCommand.map(substitute)
  const proc = spawn(bin, rest, {
    cwd: projectDir,
    env: cfg.env ? { ...process.env, ...cfg.env } : process.env,
    stdio: ['ignore', 'pipe', 'ignore'],
  })

  try {
    const url = await new Promise<string>((resolvePromise, rejectPromise) => {
      let buf = ''
      const timer = setTimeout(() => rejectPromise(new Error('serveCommand did not print a URL within the timeout')), cfg.timeoutMs ?? 300_000)
      proc.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const line = buf.split('\n').find((l) => l.trim().startsWith('http'))
        if (line) {
          clearTimeout(timer)
          resolvePromise(line.trim())
        }
      })
      proc.on('error', (err) => {
        clearTimeout(timer)
        rejectPromise(err)
      })
      proc.on('exit', (code) => {
        clearTimeout(timer)
        rejectPromise(new Error(`serveCommand exited early (code ${code}) before printing a URL`))
      })
    })
    return await extractElementsAndScreenshot(url, viewport, screenshotPath)
  } finally {
    proc.kill('SIGTERM')
  }
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

export async function cropTo(png: string, [x, y, w, h]: [number, number, number, number]): Promise<void> {
  await execFileAsync('convert', [png, '-crop', `${w}x${h}+${x}+${y}`, '+repage', png])
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
  side: 'ours'
  constructor(side: 'ours', message: string) {
    super(message)
    this.side = side
  }
}

export async function captureRound(
  bar: Extract<BarResolution, { ok: true }>,
  projectDir: string,
  issueId: string,
  round: number | string,
  region?: [number, number, number, number],
): Promise<CaptureRoundResult> {
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
  // Same crop on both sides, after normalizing, so the coordinates mean the same pixels.
  if (region) {
    await cropTo(mockupPng, region)
    await cropTo(oursPng, region)
  }

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

// The general-purpose sibling of the visual critic above: checks one step's
// criterion against the real repo instead of two screenshots against each
// other. `infra` must mean exactly "this attempt tells us nothing" (bad
// command, timeout, no verdict at all) — never treated as a pass or a fail,
// since either would burn or clear a step's attempt count on pure noise.
export type StepVerdict = { kind: 'checked'; pass: boolean; detail: string } | { kind: 'infra'; detail: string }

async function gitHeadAndStatus(projectDir: string): Promise<{ head: string; porcelain: string } | null> {
  try {
    const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectDir })
    const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain'], { cwd: projectDir })
    return { head: head.trim(), porcelain: porcelain.trim() }
  } catch {
    return null
  }
}

// Same in-flight/first-write-wins/text-fallback idioms as pendingVerdicts
// above, kept as a separate map since a verify result and a visual verdict
// are shaped differently and nothing should be able to answer the wrong one.
const pendingVerifyResults = new Map<string, { pass: boolean; detail: string }>()

export function recordVerifyResult(verifyId: string, result: { pass: boolean; detail: string }): boolean {
  if (pendingVerifyResults.has(verifyId)) return false
  pendingVerifyResults.set(verifyId, result)
  return true
}

function takeVerifyResult(verifyId: string): { pass: boolean; detail: string } | undefined {
  const v = pendingVerifyResults.get(verifyId)
  pendingVerifyResults.delete(verifyId)
  return v
}

const VERIFY_JSON_BLOCK = /\{[^{}]*"pass"\s*:\s*(true|false)[^{}]*"detail"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*\}/i

export function extractVerifyResultFromText(text: string): { pass: boolean; detail: string } | undefined {
  const match = text.replace(BASH_SINGLE_QUOTE_ESCAPE, "'").match(VERIFY_JSON_BLOCK)
  if (!match) return undefined
  try {
    const detail = JSON.parse(`"${match[2]}"`)
    return typeof detail === 'string' && detail.trim() ? { pass: match[1] === 'true', detail: detail.trim() } : undefined
  } catch {
    return undefined
  }
}

const DEFAULT_TOLERANCE = { position: 8, color: 12, fontSize: 1, borderRadius: 2 }

function parseRgb(color: string): [number, number, number] | undefined {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

function colorsClose(a: string, b: string, tolerance: number): boolean {
  const rgbA = parseRgb(a)
  const rgbB = parseRgb(b)
  if (!rgbA || !rgbB) return a === b
  return rgbA.every((v, i) => Math.abs(v - rgbB[i]) <= tolerance)
}

function candidateLabel(c: ExtractedElement): string {
  return c.text || c.dataMockupId || c.dataComponent || c.selector
}

// The AND-of-all-candidates replacement for "which is better, name one gap":
// each candidate either matches a real implementation element within
// tolerance or it doesn't — no holistic judgment, no single gap standing in
// for everything else that might also be wrong. text match first (most
// elements have a visible label), data-mockup-id/data-component as a
// fallback only for candidates that need it (see buildDesignPrompt /
// buildPrompt's carry-through rule) — never silently skips an unmatchable
// candidate, that's exactly the kind of silent pass this whole mechanism
// exists to prevent.
async function verifyStepGeometry(
  candidates: ExtractedElement[],
  viewport: [number, number],
  toleranceOverride: { position?: number; color?: number; fontSize?: number; borderRadius?: number } | undefined,
  cfg: CaptureConfig,
  params: Record<string, string>,
  projectDir: string,
  issueId: string,
  round: number | string,
): Promise<StepVerdict> {
  const tolerance = { ...DEFAULT_TOLERANCE, ...toleranceOverride }
  const roundDir = join(CRITIC_DIR, sanitizeForPath(issueId), String(round))
  mkdirSync(roundDir, { recursive: true })

  let ours: ExtractedElement[]
  try {
    ours = await captureAndExtractOurs(projectDir, cfg, params, viewport, join(roundDir, 'ours.png'))
  } catch (err: any) {
    return { kind: 'infra', detail: `geometry capture failed: ${err.message}` }
  }

  const used = new Set<number>()
  for (const candidate of candidates) {
    let matchIdx = -1
    if (candidate.text) {
      const ties = ours.map((el, i) => i).filter((i) => !used.has(i) && ours[i].text === candidate.text)
      if (ties.length === 1) matchIdx = ties[0]
      else if (ties.length > 1) {
        matchIdx = ties.reduce((best, i) =>
          Math.hypot(ours[i].box.x - candidate.box.x, ours[i].box.y - candidate.box.y) <
          Math.hypot(ours[best].box.x - candidate.box.x, ours[best].box.y - candidate.box.y)
            ? i
            : best,
        )
      }
    }
    if (matchIdx < 0 && (candidate.dataMockupId || candidate.dataComponent)) {
      matchIdx = ours.findIndex(
        (el, i) =>
          !used.has(i) &&
          ((!!candidate.dataMockupId && el.dataMockupId === candidate.dataMockupId) ||
            (!!candidate.dataComponent && el.dataComponent === candidate.dataComponent)),
      )
    }
    if (matchIdx < 0) {
      return { kind: 'checked', pass: false, detail: `no matching element found in the implementation for "${candidateLabel(candidate)}"` }
    }
    used.add(matchIdx)
    const match = ours[matchIdx]
    const label = candidateLabel(candidate)

    const posOff =
      Math.abs(match.box.x - candidate.box.x) > tolerance.position ||
      Math.abs(match.box.y - candidate.box.y) > tolerance.position ||
      Math.abs(match.box.width - candidate.box.width) > tolerance.position ||
      Math.abs(match.box.height - candidate.box.height) > tolerance.position
    if (posOff) {
      return {
        kind: 'checked',
        pass: false,
        detail: `"${label}" position/size off: expected {x:${candidate.box.x},y:${candidate.box.y},w:${candidate.box.width},h:${candidate.box.height}}, got {x:${match.box.x},y:${match.box.y},w:${match.box.width},h:${match.box.height}}`,
      }
    }
    if (!colorsClose(match.style.backgroundColor, candidate.style.backgroundColor, tolerance.color)) {
      return { kind: 'checked', pass: false, detail: `"${label}" background color off: expected ${candidate.style.backgroundColor}, got ${match.style.backgroundColor}` }
    }
    if (!colorsClose(match.style.color, candidate.style.color, tolerance.color)) {
      return { kind: 'checked', pass: false, detail: `"${label}" text color off: expected ${candidate.style.color}, got ${match.style.color}` }
    }
    if (Math.abs(match.style.fontSize - candidate.style.fontSize) > tolerance.fontSize) {
      return { kind: 'checked', pass: false, detail: `"${label}" font size off: expected ${candidate.style.fontSize}, got ${match.style.fontSize}` }
    }
    if (Math.abs(match.style.borderRadius - candidate.style.borderRadius) > tolerance.borderRadius) {
      return { kind: 'checked', pass: false, detail: `"${label}" border radius off: expected ${candidate.style.borderRadius}, got ${match.style.borderRadius}` }
    }
  }

  return { kind: 'checked', pass: true, detail: `all ${candidates.length} candidate(s) matched within tolerance` }
}

// check:'visual' -> the per-step opt-in sibling of the old whole-card
// gauntlet: resolveBar's ok:false is now a LOUD infra failure (never the
// silent "behave as if no bar exists" that let LAE-179 ship unverified) —
// a step that asked for a visual check and can't get one must escalate, not
// vanish. CaptureSideFailure (the app didn't build/launch/render) is the
// Builder's own gap, so it's a real pass:false, not infra: an attempt is
// burned and the failure feeds the next attempt's task, same as any other
// checked failure.
// command present -> mechanical, no LLM: exit 0 is pass, non-zero is a real
// fail (burns an attempt), and anything that means the command never
// meaningfully ran (missing binary, timeout) is infra (escalate, no attempt
// burned) — same err.code-shape idiom as imagesAreIdentical above: a number
// means the process ran and exited non-zero, anything else (string code like
// ENOENT, or no code at all on a timeout kill) means it didn't.
// command absent -> one fresh, read-only, MCP-less Claude turn, same
// isolation shape as runCritique but scoped to the real project directory
// (this critic needs repo access) instead of a screenshot-only scratch dir.
export async function verifyStep(
  step: {
    criterion: string
    command?: string
    check?: 'visual'
    visual?: {
      mockup?: string
      params?: Record<string, string>
      candidates?: ExtractedElement[]
      viewport?: [number, number]
      tolerance?: { position?: number; color?: number; fontSize?: number; borderRadius?: number }
      region?: [number, number, number, number]
    }
    attempts: number
    id?: string
  },
  projectDir: string,
  issueId: string,
  onOutput?: (event: AgentEvent) => void,
): Promise<StepVerdict> {
  if (step.check === 'visual') {
    const bar = resolveBar(issueId, projectDir, step)
    if (!bar.ok) return { kind: 'infra', detail: bar.why }
    // uploads/critic/<issue>/<step>/<attempt>: numbering by attempt alone let one
    // step's captures overwrite another's (LAE-183's prep step replaced the
    // compass step's attempt-5 evidence).
    const captureFolder = step.id ? `${sanitizeForPath(step.id)}/${step.attempts + 1}` : step.attempts + 1

    if (step.visual?.candidates?.length && isDomInspectable(basename(projectDir))) {
      return verifyStepGeometry(
        step.visual.candidates,
        step.visual.viewport ?? bar.cfg.viewport,
        step.visual.tolerance,
        bar.cfg,
        bar.params,
        projectDir,
        issueId,
        captureFolder,
      )
    }

    let capture: CaptureRoundResult
    try {
      capture = await captureRound(bar, projectDir, issueId, captureFolder, step.visual?.region)
    } catch (err: any) {
      if (err instanceof CaptureSideFailure) return { kind: 'checked', pass: false, detail: err.message }
      return { kind: 'infra', detail: err.message }
    }

    // Non-DOM-inspectable project (or a project step with no extracted
    // candidates yet) — same holistic critic as before, but a candidate list
    // (if the Refiner supplied one) turns "name the single biggest gap" into
    // "here's a checklist" instead of nothing.
    const hint = step.visual?.candidates?.length
      ? `\n\nPay particular attention to these specific elements: ${step.visual.candidates.map(candidateLabel).join(', ')}.`
      : ''
    const verdict = await runCritique({
      roundDir: capture.roundDir,
      intent: step.criterion + hint,
      onOutput: (event) => onOutput?.(event),
    })
    if (!verdict) return { kind: 'infra', detail: 'critic produced no verdict' }

    const winnerIsMockup = (verdict.winner === 'A') === capture.mockupIsA
    if (!winnerIsMockup) return { kind: 'checked', pass: true, detail: 'an independent visual critic, comparing blind, preferred the app over the mockup' }
    return { kind: 'checked', pass: false, detail: verdict.gap }
  }

  if (step.command) {
    try {
      const { stdout, stderr } = await execFileAsync('bash', ['-lc', step.command], {
        cwd: projectDir,
        timeout: 600_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      return { kind: 'checked', pass: true, detail: (stdout + stderr).trim().slice(-2000) || 'command exited 0' }
    } catch (err: any) {
      if (typeof err.code === 'number') {
        const output = `${err.stdout || ''}${err.stderr || ''}`.trim().slice(-2000)
        return { kind: 'checked', pass: false, detail: output || `command exited ${err.code}` }
      }
      return { kind: 'infra', detail: err.message }
    }
  }

  const verifyId = randomUUID()
  const prompt = buildVerifyPrompt({ criterion: step.criterion, verifyId })
  let searchable = ''
  const before = await gitHeadAndStatus(projectDir)

  await runClaude({
    prompt,
    projectDir,
    onOutput: (event) => {
      if (event.kind === 'text') searchable += event.text
      else if (event.kind === 'tool_call' && event.tool === 'Bash' && event.input && typeof event.input === 'object' && 'command' in event.input) {
        searchable += String((event.input as { command: unknown }).command)
      }
      onOutput?.(event)
    },
    session: { id: randomUUID(), resume: false },
    readOnly: true,
    noMcp: true,
  })

  const after = await gitHeadAndStatus(projectDir)
  if (before && after && after.head !== before.head) {
    return { kind: 'infra', detail: 'verifier moved HEAD during verification — discarding its verdict' }
  }
  const dirtyWarning =
    before && after && after.porcelain !== before.porcelain
      ? ` (note: verifier left the working tree dirty: ${after.porcelain.split('\n').slice(0, 5).join(', ')})`
      : ''

  const result = takeVerifyResult(verifyId) ?? extractVerifyResultFromText(searchable)
  if (!result) return { kind: 'infra', detail: 'verifier produced no verdict' }
  return { kind: 'checked', pass: result.pass, detail: `${result.detail}${dirtyWarning}` }
}
