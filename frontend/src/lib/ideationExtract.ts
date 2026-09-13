import type { AgentEvent, ChatMessage, IdeationCandidate } from '../types.ts'
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

// Candidates are derived per-message and injected as a synthetic
// ideation_candidates event into that specific message's own event list —
// this makes the card render inline, right where it was proposed, and only
// there, instead of once globally per session. Shared by Ideation and Design.
export function withCandidateEvents(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    const candidates = parseCandidates(m.events)
    if (!candidates) return m
    const strippedEvents: AgentEvent[] = m.events.map((e) => (e.kind === 'text' ? { ...e, text: stripJsonBlock(e.text) } : e))
    return { ...m, events: [...strippedEvents, { kind: 'ideation_candidates', candidates } as AgentEvent] }
  })
}
