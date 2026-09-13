import React from 'react'
import type { ChatMessage, ClaudeChoice, IdeationCandidate } from '../types.ts'
import ChatThread from './ChatThread.tsx'
import ClaudeChoicePicker from './ClaudeChoicePicker.tsx'
import { IdeationCandidatesRenderer } from './IdeationChat.tsx'
import { withCandidateEvents } from '../lib/ideationExtract.ts'

export default function DesignChat({
  messages,
  running,
  issueId,
  committing,
  onSend,
  onCommit,
  onCreateIssue,
  choice,
  onChoiceChange,
}: {
  messages: ChatMessage[]
  running: boolean
  issueId?: string
  committing: boolean
  onSend: (message: string, images?: string[]) => void
  onCommit: () => void
  // Creates the issue and links this draft's mockup to it.
  onCreateIssue: (candidate: IdeationCandidate) => Promise<void>
  choice: ClaudeChoice
  onChoiceChange: (choice: ClaudeChoice) => void
}) {
  const cleanedMessages = React.useMemo(() => withCandidateEvents(messages), [messages])

  return (
    <div className="design-chat">
      <ClaudeChoicePicker choice={choice} onChange={onChoiceChange} />
      <ChatThread
        messages={cleanedMessages}
        running={running}
        onSend={onSend}
        enableAttachments
        composerPlaceholder="Describe the screen…"
        dataRenderers={{
          // The Designer proposes one issue once a draft settles (buildDesignPrompt).
          // Once linked there's nothing left to file, so the card disappears.
          ideation_candidates: ({ data }) =>
            issueId ? null : (
              <IdeationCandidatesRenderer data={data as { candidates: IdeationCandidate[] }} onCreate={onCreateIssue} />
            ),
        }}
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
