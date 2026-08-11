import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import type { AgentEvent, ChatMessage } from '../types.ts'
import { OrchestratorNote, Separator, StatusLine, TextBlock, ToolCallCard } from './AgentEventView.tsx'

// content can be a plain string OR an array of typed parts — this pulls out
// just the array-of-parts member so mapping AgentEvent -> part stays typed.
type ContentPart = Extract<ThreadMessageLike['content'], readonly unknown[]>[number]

// assistant-ui's ThreadMessageLike content union has a real "tool-call" part
// (toolCallId/toolName/args/result/isError) and a generic "data" part
// (name/data: any) with its own `data.by_name` rendering slot — status/
// separator/orchestrator events map onto "data" parts by name, tool_call
// events map onto "tool-call" parts, both rendered by the shared
// AgentEventView pieces so this chat looks identical to ResponseStream.
function agentEventToPart(event: AgentEvent): ContentPart {
  switch (event.kind) {
    case 'text':
      return { type: 'text', text: event.text }
    case 'tool_call':
      return {
        type: 'tool-call',
        toolCallId: event.id,
        toolName: event.tool,
        args: (event.input ?? {}) as any,
        // artifact carries our own display label — args/result already have
        // fixed meanings (the call's inputs / its outcome) so this is the
        // one free slot for extra metadata the renderer below reads back out.
        artifact: { label: event.label },
        result: event.status === 'running' ? undefined : event.status === 'error' ? event.error : event.output,
        isError: event.status === 'error',
      }
    case 'status':
      return { type: 'data', name: 'status', data: event }
    case 'separator':
      return { type: 'data', name: 'separator', data: event }
    case 'orchestrator':
      return { type: 'data', name: 'orchestrator', data: event }
  }
}

function convertMessage(message: ChatMessage): ThreadMessageLike {
  return { id: message.id, role: message.role, content: message.events.map(agentEventToPart) }
}

function TextPartRenderer({ text }: { text: string }) {
  return <TextBlock event={{ kind: 'text', text }} />
}

function ToolCallPartRenderer({
  toolCallId,
  toolName,
  args,
  result,
  isError,
  artifact,
}: {
  toolCallId: string
  toolName: string
  args: unknown
  result?: unknown
  isError?: boolean
  artifact?: unknown
}) {
  const status: 'running' | 'complete' | 'error' = result === undefined ? 'running' : isError ? 'error' : 'complete'
  const label = (artifact as { label?: string } | undefined)?.label
  const event: AgentEvent = {
    kind: 'tool_call',
    id: toolCallId,
    tool: toolName,
    label: label || toolName,
    status,
    input: args,
    output: status === 'complete' ? String(result ?? '') : undefined,
    error: status === 'error' ? String(result ?? '') : undefined,
  }
  return <ToolCallCard event={event} />
}

function StatusDataRenderer({ data }: { data: Extract<AgentEvent, { kind: 'status' }> }) {
  return <StatusLine event={data} />
}

function SeparatorDataRenderer() {
  return <Separator />
}

function OrchestratorDataRenderer({ data }: { data: Extract<AgentEvent, { kind: 'orchestrator' }> }) {
  return <OrchestratorNote event={data} />
}

const messageComponents = {
  Text: TextPartRenderer,
  tools: { Override: ToolCallPartRenderer },
  data: {
    by_name: {
      status: StatusDataRenderer,
      separator: SeparatorDataRenderer,
      orchestrator: OrchestratorDataRenderer,
    },
  },
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="chat-message assistant">
      <MessagePrimitive.Parts components={messageComponents} />
    </MessagePrimitive.Root>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="chat-message user">
      <MessagePrimitive.Parts components={messageComponents} />
    </MessagePrimitive.Root>
  )
}

export default function RefineChat({
  messages,
  running,
  draftPlan,
  onSend,
  onConsolidate,
  onApply,
}: {
  messages: ChatMessage[]
  running: boolean
  draftPlan: string | null
  onSend: (message: string) => void
  onConsolidate: () => void
  onApply: (planText: string) => void
}) {
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    convertMessage,
    onNew: async (message: AppendMessage) => {
      const text = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('')
      if (text.trim()) onSend(text)
    },
  })

  return (
    <div className="refine-chat">
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="chat-thread">
          <ThreadPrimitive.Viewport className="chat-messages">
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="chat-input">
            <ComposerPrimitive.Input placeholder="Reply to the agent…" disabled={running} />
            <div className="chat-input-actions">
              <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
              <button type="button" onClick={onConsolidate} disabled={running || messages.length === 0}>
                Consolidate
              </button>
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>

      {draftPlan && (
        <div className="draft-plan">
          <div className="draft-plan-label">Drafted plan</div>
          <pre className="draft-plan-text">{draftPlan}</pre>
          <button type="button" onClick={() => onApply(draftPlan)} disabled={running}>
            Apply → move to Todo
          </button>
        </div>
      )}
    </div>
  )
}
