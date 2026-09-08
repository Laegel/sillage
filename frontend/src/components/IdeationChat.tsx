import React from 'react'
import type { AgentEvent, ChatMessage, IdeationCandidate } from '../types.ts'
import ChatThread from './ChatThread.tsx'
import { parseCandidates, stripJsonBlock } from '../lib/ideationExtract.ts'

function CandidateCard({
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

function IdeationCandidatesRenderer({
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
  draftKey,
}: {
  sessionId: string
  projectId: string
  messages: ChatMessage[]
  running: boolean
  onSend: (message: string, images?: string[]) => void
  onCreateCandidate: (sessionId: string, candidate: IdeationCandidate, projectId: string) => Promise<void>
  draftKey?: string
}) {
  // Candidates are derived per-message and injected as a synthetic
  // ideation_candidates event into that specific message's own event list —
  // this makes the card render inline, right where it was proposed, and only
  // there, instead of once globally per session.
  const cleanedMessages = React.useMemo(
    () =>
      messages.map((m) => {
        const candidates = parseCandidates(m.events)
        if (!candidates) return m
        const strippedEvents: AgentEvent[] = m.events.map((e) =>
          e.kind === 'text' ? { ...e, text: stripJsonBlock(e.text) } : e,
        )
        return { ...m, events: [...strippedEvents, { kind: 'ideation_candidates', candidates } as AgentEvent] }
      }),
    [messages],
  )

  return (
    <div className="ideation-chat">
      <ChatThread
        messages={cleanedMessages}
        running={running}
        onSend={onSend}
        enableAttachments
        composerPlaceholder="What's on your mind?"
        draftKey={draftKey}
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
