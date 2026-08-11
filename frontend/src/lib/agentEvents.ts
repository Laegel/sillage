import type { AgentEvent } from '../types.ts'

// tool_call events update the already-rendered card in place (matched by id,
// e.g. Claude's running -> complete/error) instead of appending a duplicate;
// every other kind always appends. Reusing the same array index on update
// keeps React keys stable.
export function appendEvent(events: AgentEvent[], event: AgentEvent): AgentEvent[] {
  if (event.kind === 'tool_call') {
    const idx = events.findIndex((e) => e.kind === 'tool_call' && e.id === event.id)
    if (idx !== -1) {
      const next = events.slice()
      next[idx] = event
      return next
    }
  }
  return [...events, event]
}

// Joins only the prose an agent actually wrote, dropping tool-call/status/
// separator/orchestrator noise — used for the Consolidate -> draft-plan text,
// which should read as clean issue-description prose.
export function eventsToPlainText(events: AgentEvent[]): string {
  return events
    .filter((e): e is Extract<AgentEvent, { kind: 'text' }> => e.kind === 'text')
    .map((e) => e.text)
    .join('')
}
