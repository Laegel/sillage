import React from 'react'
import { unstable_useComposerInput } from '@assistant-ui/react'

// App-level, in-memory store for in-progress chat composer drafts, keyed by
// session id (Ideation/Driver/Design) or issue id (Board refine chat). App
// never remounts, so a ref held here survives the per-session/per-issue chat
// components' remounts — which is exactly when assistant-ui's own composer
// state (owned by the destroyed runtime) would otherwise be lost. Drafts are
// deliberately not persisted anywhere (no localStorage), so they vanish on a
// full page reload.
export type DraftStore = {
  getDraft: (key: string) => string | undefined
  setDraft: (key: string, value: string) => void
  clearDraft: (key: string) => void
}

const DraftStoreContext = React.createContext<DraftStore | null>(null)

// All writes go straight to the ref with no React state, so typing in a
// composer never triggers an App-wide re-render — the store only ever needs
// to be read back at mount time (seeding a freshly-remounted composer) and
// cleared on send, neither of which requires reactivity.
export function DraftStoreProvider({ children }: { children: React.ReactNode }) {
  const draftsRef = React.useRef<Record<string, string>>({})
  const store = React.useMemo<DraftStore>(
    () => ({
      getDraft: (key) => draftsRef.current[key],
      setDraft: (key, value) => {
        draftsRef.current[key] = value
      },
      clearDraft: (key) => {
        delete draftsRef.current[key]
      },
    }),
    [],
  )
  return <DraftStoreContext.Provider value={store}>{children}</DraftStoreContext.Provider>
}

export function useDraftStore(): DraftStore {
  const store = React.useContext(DraftStoreContext)
  if (!store) throw new Error('useDraftStore must be used within DraftStoreProvider')
  return store
}

// Bridges a shared composer's text into the App-level draft store. An empty
// separate component (rendered inside the AssistantRuntimeProvider) because
// unstable_useComposerInput must be called under the runtime context.
//
// * Seed: on mount, if a draft is saved for `draftKey`, write it into the
//   freshly-created composer via setText. Feasible because the composer
//   runtime defaults isEditing = true and setText writes directly (no guard).
// * Persist: as the user types, mirror the composer value back into the store.
// * Clear: once the composer empties (a successful send, or the user deleting
//   everything), drop the stored entry so a future remount starts clean.
export function DraftComposerSync({ draftKey }: { draftKey: string | undefined }) {
  const { getDraft, setDraft, clearDraft } = useDraftStore()
  const { value, setText } = unstable_useComposerInput()
  // The composer's very first value is '' on a fresh mount; skip persisting
  // that so an existing saved draft isn't wiped by the mount's initial empty
  // render before seeding (effect order) has had a chance to populate it.
  const firstRunRef = React.useRef(true)

  React.useEffect(() => {
    if (!draftKey) return
    const saved = getDraft(draftKey)
    if (saved) setText(saved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  React.useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false
      return
    }
    if (!draftKey) return
    if (value) setDraft(draftKey, value)
    else clearDraft(draftKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, draftKey])

  return null
}
