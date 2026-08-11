import type { ToastMessage } from '../types.ts'

export default function Toasts({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind || 'info'}`}>
          <div className="toast-title">{toast.title}</div>
          {toast.body}
          {toast.prUrl && (
            <a className="toast-link" href={toast.prUrl} target="_blank" rel="noreferrer">
              Open PR ↗
            </a>
          )}
          <button className="toast-close" onClick={() => onDismiss(toast.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
