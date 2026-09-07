import {
  AssistantRuntimeProvider,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  SimpleImageAttachmentAdapter,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type Attachment,
  type DataMessagePartComponent,
  type ThreadMessageLike,
  type ThreadUserMessagePart,
} from '@assistant-ui/react'
import React, { type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentEvent, ChatMessage } from '../types.ts'
import { LoadingDots, OrchestratorNote, Separator, StatusLine, ToolCallCard, UsageLine } from './AgentEventView.tsx'
import Markdown from './Markdown.tsx'

// content can be a plain string OR an array of typed parts — this pulls out
// just the array-of-parts member so mapping AgentEvent -> part stays typed.
type ContentPart = Extract<ThreadMessageLike['content'], readonly unknown[]>[number]

// assistant-ui's ThreadMessageLike content union has a real "tool-call" part
// (toolCallId/toolName/args/result/isError) and a generic "data" part
// (name/data: any) with its own `data.by_name` rendering slot — status/
// separator/orchestrator events map onto "data" parts by name, tool_call
// events map onto "tool-call" parts, both rendered by the shared
// AgentEventView pieces so every chat built on this looks identical to
// ResponseStream.
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
    case 'ideation_candidates':
      return { type: 'data', name: 'ideation_candidates', data: event }
    case 'usage':
      return { type: 'data', name: 'usage', data: event }
  }
}

function convertMessage(message: ChatMessage): ThreadMessageLike {
  const imageParts: ContentPart[] = (message.images ?? []).map((image) => ({ type: 'image', image }))
  return { id: message.id, role: message.role, content: [...imageParts, ...message.events.map(agentEventToPart)] }
}

function TextPartRenderer({ text }: { text: string }) {
  if (!text) return <LoadingDots />
  return <Markdown>{text}</Markdown>
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

function UsageDataRenderer({ data }: { data: Extract<AgentEvent, { kind: 'usage' }> }) {
  return <UsageLine event={data} />
}

// Sent-message images render as small inline thumbnails; clicking one opens
// a full-size view in a portal so it escapes the message list's own
// scroll/overflow clipping instead of just growing in place.
function MessageImageRenderer({ image }: { image: string }) {
  const [expanded, setExpanded] = React.useState(false)
  React.useEffect(() => {
    if (!expanded) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expanded])
  return (
    <>
      <img src={image} alt="Message image" className="chat-message-image" onClick={() => setExpanded(true)} />
      {expanded &&
        createPortal(
          <div className="image-modal-backdrop" onClick={() => setExpanded(false)}>
            <img src={image} alt="Message image (expanded)" className="image-modal-content" />
          </div>,
          document.body,
        )}
    </>
  )
}

const defaultMessageComponents = {
  Text: TextPartRenderer,
  Image: MessageImageRenderer,
  tools: { Override: ToolCallPartRenderer },
  data: {
    by_name: {
      status: StatusDataRenderer,
      separator: SeparatorDataRenderer,
      orchestrator: OrchestratorDataRenderer,
      usage: UsageDataRenderer,
    } as Record<string, DataMessagePartComponent | undefined>,
  },
}

// Lets a specific ChatThread instance register extra data-part renderers (see
// `dataRenderers` prop below) without AssistantMessage/UserMessage losing
// their stable module-level identity — recreating those on every render would
// remount every message (and any local state inside a custom renderer, e.g.
// Ideation's CandidateCard edit fields) each time the parent re-renders.
const MessageComponentsContext = React.createContext(defaultMessageComponents)

// A pending (not-yet-sent) attachment only carries a raw `File` until send
// time — assistant-ui has no default preview for it, so this builds one from
// an object URL.
function PendingAttachmentThumb({ attachment }: { attachment: Attachment }) {
  const file = 'file' in attachment ? attachment.file : undefined
  const url = React.useMemo(() => (file ? URL.createObjectURL(file) : undefined), [file])
  React.useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  return (
    <AttachmentPrimitive.Root className="chat-attachment-thumb">
      {url && <img src={url} alt={attachment.name} />}
      <AttachmentPrimitive.Remove className="chat-attachment-remove" aria-label="Remove attachment">
        ×
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  )
}

function AssistantMessage() {
  const messageComponents = React.useContext(MessageComponentsContext)
  return (
    <MessagePrimitive.Root className="chat-message assistant">
      <MessagePrimitive.Parts components={messageComponents} />
    </MessagePrimitive.Root>
  )
}

function UserMessage() {
  const messageComponents = React.useContext(MessageComponentsContext)
  return (
    <MessagePrimitive.Root className="chat-message user">
      <MessagePrimitive.Parts components={messageComponents} />
    </MessagePrimitive.Root>
  )
}

// Shared assistant-ui wiring behind RefineChat/IdeationChat/DriverChat/DesignChat —
// the thread viewport, message rendering, and composer are identical between
// all of them; only what comes after the composer (a draft-plan box vs.
// candidate cards) differs, which is why that part stays out of here and is
// passed in via `actions` instead of living in this component.
export default function ChatThread({
  messages,
  running,
  onSend,
  composerPlaceholder = 'Reply to the agent…',
  actions,
  enableAttachments = false,
  showAttachButton = true,
  dataRenderers,
}: {
  messages: ChatMessage[]
  running: boolean
  onSend: (message: string, images?: string[]) => void
  composerPlaceholder?: string
  actions?: ReactNode
  enableAttachments?: boolean
  showAttachButton?: boolean
  // Extra data-part renderers merged into the shared status/separator/orchestrator
  // set, keyed by AgentEvent kind name — e.g. Ideation's synthetic
  // 'ideation_candidates' event, so its candidate cards render inline within the
  // specific message that proposed them (see agentEventToPart above) instead of
  // needing this shared component to know anything Ideation-specific.
  dataRenderers?: Record<string, DataMessagePartComponent | undefined>
}) {
  const messageComponents = React.useMemo(
    () => ({
      ...defaultMessageComponents,
      data: { by_name: { ...defaultMessageComponents.data.by_name, ...dataRenderers } },
    }),
    [dataRenderers],
  )

  const attachmentAdapter = React.useMemo(
    () => (enableAttachments ? new SimpleImageAttachmentAdapter() : undefined),
    [enableAttachments],
  )
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    convertMessage,
    adapters: attachmentAdapter ? { attachments: attachmentAdapter } : undefined,
    onNew: async (message: AppendMessage) => {
      const text = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('')
      const attachments =
        (message as { attachments?: readonly { content: readonly ThreadUserMessagePart[] }[] }).attachments ?? []
      const images = attachments
        .flatMap((a) => a.content)
        .filter((p): p is Extract<ThreadUserMessagePart, { type: 'image' }> => p.type === 'image')
        .map((p) => p.image)
      if (text.trim() || images.length > 0) onSend(text, images.length > 0 ? images : undefined)
    },
  })

  const composerBody = (
    <>
      {enableAttachments && (
        <ComposerPrimitive.Attachments>
          {({ attachment }) => <PendingAttachmentThumb attachment={attachment} />}
        </ComposerPrimitive.Attachments>
      )}
      <ComposerPrimitive.Input placeholder={composerPlaceholder} disabled={running} />
      <div className="chat-input-actions">
        {enableAttachments && showAttachButton && <ComposerPrimitive.AddAttachment />}
        {actions}
      </div>
    </>
  )

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MessageComponentsContext.Provider value={messageComponents}>
        <ThreadPrimitive.Root className="chat-thread">
          <ThreadPrimitive.Viewport className="chat-messages">
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="chat-input">
            {enableAttachments ? (
              <ComposerPrimitive.AttachmentDropzone className="chat-input-dropzone">
                {composerBody}
              </ComposerPrimitive.AttachmentDropzone>
            ) : (
              composerBody
            )}
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </MessageComponentsContext.Provider>
    </AssistantRuntimeProvider>
  )
}
