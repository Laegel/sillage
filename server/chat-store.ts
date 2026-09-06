import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE_FILE = resolve(__dirname, '..', 'chat-sessions.json')

export type ChatBackend = 'claude' | 'opencode' | 'kilocode'

export interface ChatSession {
  backend: ChatBackend
  sessionId: string
}

type ChatStoreFile = Record<string, ChatSession>

function loadStore(): ChatStoreFile {
  if (!existsSync(STORE_FILE)) return {}
  return JSON.parse(readFileSync(STORE_FILE, 'utf8'))
}

export function getChatSession(issueId: string): ChatSession | undefined {
  return loadStore()[issueId]
}

export function saveChatSession(issueId: string, backend: ChatBackend, sessionId: string): void {
  const store = loadStore()
  store[issueId] = { backend, sessionId }
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2))
}

export function deleteChatSession(issueId: string): void {
  const store = loadStore()
  delete store[issueId]
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2))
}
