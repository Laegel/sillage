import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_FILE = resolve(__dirname, '..', 'usage-log.jsonl')

export interface UsageEntry {
  backend: string
  timestamp: string
  id?: string
  cost?: number
  tokens?: { input?: number; output?: number; cacheRead?: number }
}

export function appendUsage(entry: UsageEntry): void {
  appendFileSync(STORE_FILE, JSON.stringify(entry) + '\n')
}

export function loadUsage(): UsageEntry[] {
  if (!existsSync(STORE_FILE)) return []
  return readFileSync(STORE_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
