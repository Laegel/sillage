import type { ChatMessage } from '../types.ts'
import ChatThread from './ChatThread.tsx'

// Driver actions/mode-changes are synthesized into plain orchestrator-note
// events by App.tsx's WS reconciliation before they ever reach this
// component's `messages` — no Driver-specific dataRenderer needed here,
// ChatThread's built-in `orchestrator` renderer already covers them.
export default function DriverChat({
  messages,
  running,
  onSend,
}: {
  messages: ChatMessage[]
  running: boolean
  onSend: (message: string, images?: string[]) => void
}) {
  return (
    <div className="driver-chat">
      <ChatThread messages={messages} running={running} onSend={onSend} enableAttachments composerPlaceholder="Talk to the driver…" />
    </div>
  )
}
