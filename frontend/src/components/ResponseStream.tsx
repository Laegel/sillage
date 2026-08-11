import React from 'react'
import type { StreamEntry } from '../types.ts'
import AgentEventView from './AgentEventView.tsx'

export default function ResponseStream({ streams, onClear }: { streams: StreamEntry[]; onClear: () => void }) {
  const bottomRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [streams])

  if (streams.length === 0) {
    return (
      <section className="stream empty">
        <h2>Agent output</h2>
        <p>Streams from headless Claude Code will appear here.</p>
      </section>
    )
  }

  return (
    <section className="stream">
      <header className="stream-header">
        <h2>Agent output</h2>
        <button onClick={onClear}>Clear</button>
      </header>
      {streams.map((stream) => (
        <div key={stream.issueId} className={`stream-entry ${stream.done ? 'done' : ''}`}>
          <div className="stream-entry-title">
            <span className="issue-id">{stream.issueId}</span>
            <span className="stream-classification">{stream.classification}</span>
            {stream.errored ? (
              <span className="stream-status error">failed</span>
            ) : stream.done ? (
              <span className="stream-status ok">finished</span>
            ) : (
              <span className="stream-status">running…</span>
            )}
          </div>
          <div className="stream-body">
            {stream.events.map((event, i) => (
              <AgentEventView key={i} event={event} />
            ))}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </section>
  )
}
