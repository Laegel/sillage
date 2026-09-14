import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const MAP_FILE = resolve(__dirname, '..', 'project-map.json')

export interface CaptureConfig {
  // argv for launching the real app at a specific screen/state — {out} is the
  // screenshot destination, any other {word} is a per-issue param supplied
  // via design/<issueId>/capture.json (see captureParamNames below).
  command: string[]
  // Both PNGs (mockup + app) are normalized to this size before comparison —
  // a property of the app's own window, not of any individual issue.
  viewport: [number, number]
  timeoutMs?: number
  // Overrides merged onto process.env for this launch only — e.g. ldaahbevy
  // needs WAYLAND_DISPLAY forced empty so winit selects xvfb-run's virtual X11
  // server instead of the real Wayland compositor (xvfb-run itself doesn't
  // clear it; see that project's own AGENTS.md).
  env?: Record<string, string>
  // Only meaningful for domInspectable projects. Same placeholder mechanism
  // as `command`, but does the same build+serve setup and prints a live URL
  // to stdout instead of taking a screenshot — extract.ts drives its own
  // puppeteer navigation against that URL (one page load does both the
  // screenshot and the DOM walk, see captureAndExtractOurs in critic.ts).
  // No {out} placeholder here since nothing is written to disk by the
  // command itself.
  serveCommand?: string[]
}

interface ProjectMapFile {
  PROJECTS_ROOT: string
  projects: Record<string, string>
  requiredTools?: Record<string, string[]>
  capture?: Record<string, CaptureConfig>
  // true means the orchestrator will NOT serialize implement runs on this
  // project — it does NOT mean per-run git worktrees are actually provisioned
  // (that automation doesn't exist yet). Only set true once that's genuinely
  // safe some other way. Missing/false is the safe default: implement runs
  // on this project queue behind each other (see acquireProjectSlot).
  withGitWorktrees?: Record<string, boolean>
  // true means this project's UI has a real DOM that extract.ts can walk
  // (a web app rendered via something like Storybook) — verifyStep's
  // geometry branch only runs for these; everything else (a native game
  // with no DOM at all) stays on the holistic critic. Requires the
  // project's capture config to also set serveCommand. Missing/false is the
  // safe default.
  domInspectable?: Record<string, boolean>
}

// The orchestrator's own mergePr() shells out to `gh` directly, regardless of
// what any project declares — checked for every project, not just ones that
// list it under requiredTools.
const BASE_REQUIRED_TOOLS = ['gh']

function loadMap(): ProjectMapFile {
  if (!existsSync(MAP_FILE)) {
    throw new Error(`project-map.json not found at ${MAP_FILE}. Create it to map Linear projects to local folders.`)
  }
  return JSON.parse(readFileSync(MAP_FILE, 'utf8'))
}

// Where every mapped project lives — sibling repos (e.g. a path dependency like
// ldaahbevy's ../gguy/gguy-core) are under it.
export function projectsRoot(): string {
  return resolve(loadMap().PROJECTS_ROOT)
}

// Every Linear project with a local folder that exists, e.g. for reading
// per-project files (gate timings) across all of them.
export function mappedProjects(): { projectId: string; dir: string }[] {
  return Object.keys(loadMap().projects).flatMap((projectId) => {
    try {
      return [{ projectId, dir: resolveProjectDir(projectId) }]
    } catch {
      return []
    }
  })
}

export function resolveProjectDir(linearProjectId: string | undefined): string {
  if (!linearProjectId) {
    throw new Error('This issue has no Linear project set — cannot determine which local folder to run in.')
  }
  const map = loadMap()
  const folder = map.projects[linearProjectId]
  if (!folder) {
    throw new Error(`No local folder mapped for Linear project ${linearProjectId}. Add an entry to project-map.json.`)
  }
  if (!/^[^/\\]+$/.test(folder) || folder === '.' || folder === '..') {
    throw new Error(`Invalid project-map.json entry for ${linearProjectId}: "${folder}" must be a single folder name.`)
  }
  const root = resolve(map.PROJECTS_ROOT)
  const resolved = resolve(root, folder)
  if (dirname(resolved) !== root) {
    throw new Error(`Invalid project-map.json entry for ${linearProjectId}: resolves outside PROJECTS_ROOT.`)
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Mapped folder for Linear project ${linearProjectId} does not exist: ${resolved}`)
  }
  return resolved
}

function requiredToolsFor(folder: string): string[] {
  const map = loadMap()
  return map.requiredTools?.[folder] ?? []
}

export function supportsWorktrees(folder: string): boolean {
  const map = loadMap()
  return map.withGitWorktrees?.[folder] ?? false
}

export function isDomInspectable(folder: string): boolean {
  const map = loadMap()
  return map.domInspectable?.[folder] ?? false
}

// Runs once before any agent process is spawned for this project — a run
// that's missing a tool it needs would otherwise waste minutes limping
// through exploration before failing (or silently no-op'ing) deep inside
// the agent's own turn instead of failing fast, clearly, up front.
export async function checkRequiredTools(folder: string): Promise<void> {
  const tools = [...new Set([...BASE_REQUIRED_TOOLS, ...requiredToolsFor(folder)])]
  const missing: string[] = []
  for (const tool of tools) {
    try {
      await execFileAsync('which', [tool])
    } catch {
      missing.push(tool)
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing required tool(s) for ${folder}: ${missing.join(', ')}. Install them or update project-map.json.`)
  }
}

// undefined means "this project has no capture command configured" — the
// caller's job, not this function's, to treat that as "no bar, behave as
// before" rather than an error.
export function captureConfigFor(folder: string): CaptureConfig | undefined {
  const map = loadMap()
  return map.capture?.[folder]
}

const CAPTURE_PLACEHOLDER = /\{(\w+)\}/g

// Derived from the command template rather than declared separately in
// project-map.json, so the two can never drift out of sync with each other.
// A step's (or capture.json's) params against what the capture command
// actually substitutes — a key it doesn't use is as wrong as a missing one:
// LAE-183's plan passed {"run": "<shell command>"} where only {scene} works.
export function validateCaptureParams(cfg: CaptureConfig, params: Record<string, unknown>): { missing: string[]; unknown: string[] } {
  const required = captureParamNames(cfg)
  return {
    missing: required.filter((name) => typeof params[name] !== 'string' || !params[name]),
    unknown: Object.keys(params).filter((key) => !required.includes(key)),
  }
}

// A visual step's `region`: [x, y, width, height] in viewport pixels. Returns
// why it's invalid, or undefined. A step about one element (a compass) gets
// judged on that crop only — comparing the whole frame failed LAE-183's compass
// step on a minimap and hotbar that other steps own.
export function validateVisualRegion(region: unknown, [vw, vh]: [number, number]): string | undefined {
  if (!Array.isArray(region) || region.length !== 4 || region.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    return 'region must be [x, y, width, height] numbers'
  }
  const [x, y, w, h] = region as number[]
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return 'region needs a non-negative origin and a positive size'
  if (x + w > vw || y + h > vh) return `region [${region.join(', ')}] extends past the ${vw}x${vh} capture`
  return undefined
}

export function captureParamNames(cfg: CaptureConfig): string[] {
  const names = new Set<string>()
  for (const arg of cfg.command) {
    for (const match of arg.matchAll(CAPTURE_PLACEHOLDER)) {
      if (match[1] !== 'out') names.add(match[1])
    }
  }
  return [...names]
}
