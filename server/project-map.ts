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
}

interface ProjectMapFile {
  PROJECTS_ROOT: string
  projects: Record<string, string>
  requiredTools?: Record<string, string[]>
  capture?: Record<string, CaptureConfig>
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
export function captureParamNames(cfg: CaptureConfig): string[] {
  const names = new Set<string>()
  for (const arg of cfg.command) {
    for (const match of arg.matchAll(CAPTURE_PLACEHOLDER)) {
      if (match[1] !== 'out') names.add(match[1])
    }
  }
  return [...names]
}
