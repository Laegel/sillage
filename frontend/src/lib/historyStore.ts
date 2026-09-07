function isQuotaExceeded(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
}

// Chat/session history is an unbounded, ever-growing convenience cache (full
// tool-call output, images, etc. pile up per issue/session with nothing ever
// evicted) — it will eventually exceed localStorage's quota. When it does,
// losing the oldest entries beats throwing and permanently breaking every
// future save (the write that triggers this runs on every render).
export function saveHistoryStore<T>(key: string, store: Record<string, T>): void {
  let entries = Object.entries(store)
  for (;;) {
    try {
      localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)))
      return
    } catch (err) {
      if (!isQuotaExceeded(err)) throw err
      if (entries.length === 0) {
        console.warn(`[history] dropped ${key}: storage quota exceeded even with no entries left`)
        return
      }
      entries = entries.slice(1)
    }
  }
}
