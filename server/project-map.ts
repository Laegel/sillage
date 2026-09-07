import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const MAP_FILE = resolve(__dirname, '..', 'project-map.json')

interface ProjectMapFile {
  PROJECTS_ROOT: string
  projects: Record<string, string>
  requiredTools?: Record<string, string[]>
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
