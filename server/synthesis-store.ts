import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_FILE = resolve(__dirname, '..', 'synthesis.json')

export interface SynthesisEntry {
  text: string
  updatedAt: string
  lastIssueId?: string
}

type SynthesisStoreFile = Record<string, SynthesisEntry>

function loadStore(): SynthesisStoreFile {
  if (!existsSync(STORE_FILE)) return {}
  return JSON.parse(readFileSync(STORE_FILE, 'utf8'))
}

export function getSynthesis(projectId: string): SynthesisEntry | undefined {
  return loadStore()[projectId]
}

export function saveSynthesis(projectId: string, entry: SynthesisEntry): void {
  const store = loadStore()
  store[projectId] = entry
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2))
}
