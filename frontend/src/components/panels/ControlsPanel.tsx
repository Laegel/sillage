export default function ControlsPanel({ controlsHtml }: { controlsHtml: string | null | undefined }) {
  return (
    <div className="design-controls-pane">
      {controlsHtml === undefined && <p className="hint">Loading controls…</p>}
      {controlsHtml === null && <p className="hint">No controls yet.</p>}
      {controlsHtml && (
        <iframe className="design-controls-frame" srcDoc={controlsHtml} sandbox="allow-scripts" title="Design controls" />
      )}
    </div>
  )
}
