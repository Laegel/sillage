import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MAP_FILE = resolve(__dirname, '..', 'project-map.json')

interface ProjectMapFile {
  PROJECTS_ROOT: string
  projects: Record<string, string>
}

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
