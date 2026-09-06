export default function PreviewPanel({
  html,
  error,
  onRefresh,
  onIframeReady,
}: {
  html: string | null | undefined
  error: string
  onRefresh: () => void
  onIframeReady: (el: HTMLIFrameElement | null) => void
}) {
  return (
    <div className="design-preview">
      <div className="design-preview-toolbar">
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {error && <p className="hint">Couldn't load preview: {error}</p>}
      {!error && html === undefined && <p className="hint">Loading…</p>}
      {!error && html === null && <p className="hint">No mockup yet — describe the screen you want in the chat.</p>}
      {!error && html && (
        <iframe ref={onIframeReady} className="design-preview-frame" srcDoc={html} sandbox="allow-scripts" title="Design preview" />
      )}
    </div>
  )
}
