// `allow-scripts` without `allow-same-origin` is the safe pairing: the
// mockup's own interactivity (modals, hover, click-through) works, but it
// gets an opaque origin and can't reach Sillage's DOM, storage, or session.
//
// Thin renderer only — DesignView.tsx owns the fetch (its design-tokens panel
// needs the same html string, so fetching it in two places would mean two
// requests and two copies of "what's the current mockup").
import React from 'react'

export default function DesignPreview({
  html,
  controlsHtml,
  error,
  onRefresh,
}: {
  html: string | null | undefined
  controlsHtml: string | null | undefined
  error: string
  onRefresh: () => void
}) {
  const previewRef = React.useRef<HTMLIFrameElement>(null)
  const controlsRef = React.useRef<HTMLIFrameElement>(null)

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'design-command') return
      const previewFrame = previewRef.current?.contentWindow
      if (previewFrame) {
        previewFrame.postMessage(data, '*')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <div className="design-preview">
      <div className="design-preview-toolbar">
        <span className="design-preview-label">Preview</span>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {error && <p className="hint">Couldn't load preview: {error}</p>}
      {!error && html === undefined && <p className="hint">Loading…</p>}
      {!error && html === null && <p className="hint">No mockup yet — describe the screen you want in the chat.</p>}
      <div className="design-preview-split">
        <div className="design-preview-pane">
          {!error && html && (
            <iframe
              ref={previewRef}
              className="design-preview-frame"
              srcDoc={html}
              sandbox="allow-scripts"
              title="Design preview"
            />
          )}
        </div>
        <div className="design-controls-pane">
          {!error && controlsHtml === undefined && <p className="hint">Loading controls…</p>}
          {!error && controlsHtml === null && <p className="hint">No controls yet.</p>}
          {!error && controlsHtml && (
            <iframe
              ref={controlsRef}
              className="design-controls-frame"
              srcDoc={controlsHtml}
              sandbox="allow-scripts"
              title="Design controls"
            />
          )}
        </div>
      </div>
    </div>
  )
}
