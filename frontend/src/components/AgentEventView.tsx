import type { AgentEvent } from '../types.ts'
import Markdown from './Markdown.tsx'

function summarizeValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  const json = JSON.stringify(value)
  return json.length > 200 ? `${json.slice(0, 200)}…` : json
}

export function LoadingDots() {
  return (
    <span className="loading-dots">
      <span className="dot" />
      <span className="dot" />
      <span className="dot" />
    </span>
  )
}

export function TextBlock({ event }: { event: Extract<AgentEvent, { kind: 'text' }> }) {
  if (!event.text) return <LoadingDots />
  return <Markdown>{event.text}</Markdown>
}

export function ToolCallCard({ event }: { event: Extract<AgentEvent, { kind: 'tool_call' }> }) {
  const body = event.status === 'error' ? event.error : event.output
  return (
    <details className={`tool-call-card ${event.status}`}>
      <summary className="tool-call-header">
        <span className="tool-call-status-dot" />
        <span className="tool-call-tool">{event.tool}</span>
        <span className="tool-call-label">{event.label || summarizeValue(event.input)}</span>
      </summary>
      {body && <pre className="tool-call-body">{body}</pre>}
    </details>
  )
}

export function StatusLine({ event }: { event: Extract<AgentEvent, { kind: 'status' }> }) {
  return (
    <div className="status-line">
      <strong>{event.category}</strong>: {event.detail}
      {event.needsAction && (
        <span className="status-blocked-pill">
          <span className="status-blocked-dot" />
          {event.needsAction}
        </span>
      )}
    </div>
  )
}

export function Separator() {
  return <hr className="stream-separator" />
}

export function OrchestratorNote({ event }: { event: Extract<AgentEvent, { kind: 'orchestrator' }> }) {
  return <div className="orchestrator-note">{event.text}</div>
}

export function UsageLine({ event }: { event: Extract<AgentEvent, { kind: 'usage' }> }) {
  const parts: string[] = [event.backend]
  if (event.cost !== undefined) parts.push(`$${event.cost.toFixed(4)}`)
  if (event.tokens) parts.push(`${event.tokens.input} in / ${event.tokens.output} out`)
  return <div className="status-line">{parts.join(' — ')}</div>
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
    case 'usage':
      return <UsageLine event={event} />
    case 'ideation_candidates':
      return null
    default:
      return null
  }
}
