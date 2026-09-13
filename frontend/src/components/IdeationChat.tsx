import React from 'react'
import type { ChatMessage, ClaudeChoice, IdeationCandidate } from '../types.ts'
import ChatThread from './ChatThread.tsx'
import ClaudeChoicePicker from './ClaudeChoicePicker.tsx'
import { withCandidateEvents } from '../lib/ideationExtract.ts'

// Also used by DesignChat/DesignView to file a mockup as a new issue.
export function CandidateCard({
  candidate,
  onCreate,
}: {
  candidate: IdeationCandidate
  onCreate: (candidate: IdeationCandidate) => Promise<void>
}) {
  const [title, setTitle] = React.useState(candidate.title)
  const [description, setDescription] = React.useState(candidate.description)
  const [creating, setCreating] = React.useState(false)
  const [created, setCreated] = React.useState(false)

  const handleCreate = async () => {
    setCreating(true)
    try {
      await onCreate({ title, description })
      setCreated(true)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="ideation-candidate">
      <div className="ideation-candidate-row">
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Candidate title" />
      </div>
      <textarea
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        aria-label="Candidate description"
      />
      <button type="button" onClick={handleCreate} disabled={creating || created || !title.trim()}>
        {created ? 'Created' : creating ? 'Creating…' : 'Create issue'}
      </button>
    </div>
  )
}

export function IdeationCandidatesRenderer({
  data,
  onCreate,
}: {
  data: { candidates: IdeationCandidate[] }
  onCreate: (candidate: IdeationCandidate) => Promise<void>
}) {
  return (
    <div className="ideation-candidates">
      <div className="ideation-candidates-label">Proposed issues</div>
      {data.candidates.map((candidate, i) => (
        <CandidateCard key={i} candidate={candidate} onCreate={onCreate} />
      ))}
    </div>
  )
}

export default function IdeationChat({
  sessionId,
  projectId,
  messages,
  running,
  onSend,
  onCreateCandidate,
  choice,
  onChoiceChange,
}: {
  sessionId: string
  projectId: string
  messages: ChatMessage[]
  running: boolean
  onSend: (message: string, images?: string[]) => void
  onCreateCandidate: (sessionId: string, candidate: IdeationCandidate, projectId: string) => Promise<void>
  choice: ClaudeChoice
  onChoiceChange: (choice: ClaudeChoice) => void
}) {
  const cleanedMessages = React.useMemo(() => withCandidateEvents(messages), [messages])

  return (
    <div className="ideation-chat">
      <ClaudeChoicePicker choice={choice} onChange={onChoiceChange} />
      <ChatThread
        messages={cleanedMessages}
        running={running}
        onSend={onSend}
        enableAttachments
        composerPlaceholder="What's on your mind?"
        dataRenderers={{
          ideation_candidates: ({ data }) => (
            <IdeationCandidatesRenderer
              data={data as { candidates: IdeationCandidate[] }}
              onCreate={(candidate) => onCreateCandidate(sessionId, candidate, projectId)}
            />
          ),
        }}
      />
    </div>
  )
}
