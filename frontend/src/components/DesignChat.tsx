import type { ChatMessage } from '../types.ts'
import ChatThread from './ChatThread.tsx'

export default function DesignChat({
  messages,
  running,
  issueId,
  committing,
  onSend,
  onCommit,
  draftKey,
}: {
  messages: ChatMessage[]
  running: boolean
  issueId?: string
  committing: boolean
  onSend: (message: string, images?: string[]) => void
  onCommit: () => void
  draftKey?: string
}) {
  return (
    <div className="design-chat">
      <ChatThread
        messages={messages}
        running={running}
        onSend={onSend}
        enableAttachments
        composerPlaceholder="Describe the screen…"
        draftKey={draftKey}
        actions={
          <button
            type="button"
            className="design-commit-btn"
            onClick={onCommit}
            disabled={!issueId || committing}
            title={issueId ? undefined : 'Link an issue first to commit'}
          >
            {committing ? 'Committing…' : 'Commit to branch'}
          </button>
        }
      />
    </div>
  )
}
