import type { AgentEvent, IdeationCandidate } from '../types.ts'
import { eventsToPlainText } from './agentEvents.ts'

const JSON_BLOCK = /```json\s*([\s\S]*?)```/i

export function parseCandidates(events: AgentEvent[]): IdeationCandidate[] | null {
  const match = eventsToPlainText(events).match(JSON_BLOCK)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const candidates = parsed.filter(
    (c): c is IdeationCandidate => typeof c?.title === 'string' && c.title.trim().length > 0,
  )
  return candidates.length > 0 ? candidates : null
}

export function stripJsonBlock(text: string): string {
  return text.replace(JSON_BLOCK, '').trim()
}
