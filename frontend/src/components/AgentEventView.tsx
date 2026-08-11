import type { AgentEvent } from '../types.ts'

function summarizeValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  const json = JSON.stringify(value)
  return json.length > 200 ? `${json.slice(0, 200)}…` : json
}

export function TextBlock({ event }: { event: Extract<AgentEvent, { kind: 'text' }> }) {
  if (!event.text) return null
  return <div className="agent-text">{event.text}</div>
}

export function ToolCallCard({ event }: { event: Extract<AgentEvent, { kind: 'tool_call' }> }) {
  const body = event.status === 'error' ? event.error : event.output
  return (
    <div className={`tool-call-card ${event.status}`}>
      <div className="tool-call-header">
        <span className="tool-call-status-dot" />
        <span className="tool-call-tool">{event.tool}</span>
        <span className="tool-call-label">{event.label || summarizeValue(event.input)}</span>
      </div>
      {body && <pre className="tool-call-body">{body}</pre>}
    </div>
  )
}

export function StatusLine({ event }: { event: Extract<AgentEvent, { kind: 'status' }> }) {
  return (
    <div className="status-line">
      <strong>{event.category}</strong>: {event.detail}
      {event.needsAction && <span className="status-needs-action"> — needs action: {event.needsAction}</span>}
    </div>
  )
}

export function Separator() {
  return <hr className="stream-separator" />
}

export function OrchestratorNote({ event }: { event: Extract<AgentEvent, { kind: 'orchestrator' }> }) {
  return <div className="orchestrator-note">{event.text}</div>
}

export default function AgentEventView({ event }: { event: AgentEvent }) {
  switch (event.kind) {
    case 'text':
      return <TextBlock event={event} />
    case 'tool_call':
      return <ToolCallCard event={event} />
    case 'status':
      return <StatusLine event={event} />
    case 'separator':
      return <Separator />
    case 'orchestrator':
      return <OrchestratorNote event={event} />
    default:
      return null
  }
}
