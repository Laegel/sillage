import React from 'react'
import { createIssue, fetchIssue, fetchIssues, fetchProjects, setIssueStatus, updateIssue, fetchPlans } from './api.ts'
import { useSocket } from './useSocket.ts'
import IssueTracker from './components/IssueTracker.tsx'
import TaskPanel from './components/TaskPanel.tsx'
import ResponseStream from './components/ResponseStream.tsx'
import IdeationView from './components/IdeationView.tsx'
import DriverView from './components/DriverView.tsx'
import DesignView from './components/DesignView.tsx'
import MetricsView from './components/MetricsView.tsx'
import UsageView from './components/UsageView.tsx'
import PlansView from './components/PlansView.tsx'
import Toasts from './components/Toasts.tsx'
import type { ChatMessage, IdeationCandidate, IdeationSession, Issue, DriverMode, DriverSession, DesignSession, Project, StreamEntry, ToastMessage, WsMessage, Plan } from './types.ts'
import { appendEvent, eventsToPlainText } from './lib/agentEvents.ts'
import { loadRefineHistory, saveRefineHistory, toRefineHistoryStore } from './lib/refineHistory.ts'
import { loadIdeationSessions, saveIdeationSessions } from './lib/ideationHistory.ts'
import { loadDriverSessions, saveDriverSessions } from './lib/driverHistory.ts'
import { loadDesignSessions, saveDesignSessions } from './lib/designHistory.ts'

let toastSeq = 0

// Pairs a piece of React state with a ref that's always kept in sync, so an
// event handler that needs to read another event's just-written value
// synchronously (e.g. refine_turn_done reading the chat text refine_output
// just appended) doesn't have to nest setState calls inside one another.
function useMirroredState<T>(initial: T): [T, React.MutableRefObject<T>, (updater: (prev: T) => T) => void] {
  const [state, setState] = React.useState(initial)
  const ref = React.useRef(initial)
  const set = React.useCallback((updater: (prev: T) => T) => {
    setState((prev) => {
      const next = updater(prev)
      ref.current = next
      return next
    })
  }, [])
  return [state, ref, set]
}

export default function App() {
  const [issues, setIssues] = React.useState<Issue[]>([])
  const [columns, setColumns] = React.useState<string[]>([])
  const [issuesLoading, setIssuesLoading] = React.useState(true)
  const [issuesError, setIssuesError] = React.useState('')
  const [projects, setProjects] = React.useState<Project[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [streams, setStreams] = React.useState<StreamEntry[]>([])
  const [toasts, setToasts] = React.useState<ToastMessage[]>([])
  const [runningIds, setRunningIds] = React.useState<Set<string>>(new Set())
  const [prByIssue, setPrByIssue] = React.useState<Record<string, string>>({})
  // Seeded from localStorage so a reload shows the real past conversation
  // instead of losing it — see lib/refineHistory.ts.
  const initialRefineHistory = loadRefineHistory()
  const [refineChats, refineChatsRef, setRefineChats] = useMirroredState<Record<string, ChatMessage[]>>(
    Object.fromEntries(Object.entries(initialRefineHistory).map(([id, h]) => [id, h.messages])),
  )
  const [refineRunning, refineRunningRef, setRefineRunning] = useMirroredState<Set<string>>(new Set())
  const [draftPlans, setDraftPlans] = React.useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(initialRefineHistory)
        .filter((entry): entry is [string, { messages: ChatMessage[]; draftPlan: string }] => Boolean(entry[1].draftPlan))
        .map(([id, h]) => [id, h.draftPlan]),
    ),
  )
  const pendingConsolidateRef = React.useRef<Set<string>>(new Set())
  // Ideation sessions are entirely client-owned (see lib/ideationHistory.ts),
  // same split as refine transcripts — the server only ever persists
  // {backend, sessionId} for continuity, never the title/messages/candidates.
  const [ideationSessions, ideationSessionsRef, setIdeationSessions] = useMirroredState<
    Record<string, IdeationSession>
  >(loadIdeationSessions())
  const [ideationRunning, ideationRunningRef, setIdeationRunning] = useMirroredState<Set<string>>(new Set())
  const [selectedIdeationId, setSelectedIdeationId] = React.useState<string | null>(null)
  // Driver sessions mirror ideation's split — client-owned transcript/title, but
  // `mode` here is only the optimistic pre-'hello' default; the server's
  // driverSessionModes (memory-only, resets to manual on restart) is the source
  // of truth once connected — see the 'hello' case below.
  const [driverSessions, driverSessionsRef, setDriverSessions] = useMirroredState<Record<string, DriverSession>>(loadDriverSessions())
  const [driverRunning, driverRunningRef, setDriverRunning] = useMirroredState<Set<string>>(new Set())
  // Ephemeral server state, like driverSessionMode — not folded into DriverSession's
  // localStorage-persisted shape. Seeded from 'hello', updated live on
  // driver_ownership_changed.
  const [driverOwnership, setDriverOwnership] = React.useState<Record<string, string[]>>({})
  const [selectedDriverId, setSelectedDriverId] = React.useState<string | null>(null)
  // Design sessions mirror ideation's split — client-owned transcript/title
  // (including issueId, the one field ideation doesn't have), server only
  // persists {backend, sessionId} for continuity.
  const [designSessions, designSessionsRef, setDesignSessions] = useMirroredState<Record<string, DesignSession>>(loadDesignSessions())
  const [designRunning, designRunningRef, setDesignRunning] = useMirroredState<Set<string>>(new Set())
  const [designCommitting, setDesignCommitting] = React.useState<Set<string>>(new Set())
  // Bumped on design_turn_done so DesignPreview's effect refetches — the
  // preview has no other signal that the mockup file on disk just changed.
  const [designPreviewRefresh, setDesignPreviewRefresh] = React.useState<Record<string, number>>({})
  const [selectedDesignId, setSelectedDesignId] = React.useState<string | null>(null)
  const [view, setView] = React.useState<'project' | 'execution' | 'ideation' | 'driver' | 'design' | 'metrics' | 'usage' | 'plans'>('project')
  const [plans, setPlans] = React.useState<Plan[]>([])
  const [plansLoading, setPlansLoading] = React.useState(false)
  const [plansError, setPlansError] = React.useState('')

  React.useEffect(() => {
    if (!selectedId) {
      setPlans([])
      return
    }
    setPlansLoading(true)
    setPlansError('')
    fetchPlans(selectedId)
      .then((data) => setPlans(data.plans))
      .catch((err) => setPlansError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPlansLoading(false))
  }, [selectedId])

  const refreshPlans = React.useCallback(async () => {
    if (!selectedId) return
    setPlansLoading(true)
    setPlansError('')
    try {
      const data = await fetchPlans(selectedId)
      setPlans(data.plans)
    } catch (err) {
      setPlansError(err instanceof Error ? err.message : String(err))
    } finally {
      setPlansLoading(false)
    }
  }, [selectedId])

  React.useEffect(() => {
    saveRefineHistory(toRefineHistoryStore(refineChats, draftPlans))
  }, [refineChats, draftPlans])

  React.useEffect(() => {
    saveIdeationSessions(ideationSessions)
  }, [ideationSessions])

  React.useEffect(() => {
    saveDriverSessions(driverSessions)
  }, [driverSessions])

  React.useEffect(() => {
    saveDesignSessions(designSessions)
  }, [designSessions])

  const refresh = React.useCallback(async () => {
    try {
      const data = await fetchIssues()
      setIssues(data.issues)
      setColumns(data.columns)
      setIssuesError('')
    } catch (err) {
      setIssuesError(err instanceof Error ? err.message : String(err))
    } finally {
      setIssuesLoading(false)
    }
  }, [])

  // listIssues() costs ~4 Linear API requests per issue on the board (state,
  // milestone, labels, hasSubIssues) — a full refresh() on every single status
  // change/PR/task-completion event scales with total issue count and adds up
  // fast (confirmed: 213 requests per refresh at ~53 issues, enough to exceed
  // Linear's 2500/hour limit from a dozen status changes alone). Events that
  // only touch one issue patch just that issue in place instead.
  const upsertIssue = React.useCallback((issue: Issue) => {
    setIssues((prev) => {
      const exists = prev.some((i) => i.id === issue.id)
      return exists ? prev.map((i) => (i.id === issue.id ? issue : i)) : [...prev, issue]
    })
  }, [])

  const refreshIssue = React.useCallback(
    async (issueId: string) => {
      try {
        const data = await fetchIssue(issueId)
        upsertIssue(data.issue)
      } catch {
        // server/Linear not reachable; stale until the next event
      }
    },
    [upsertIssue],
  )

  React.useEffect(() => {
    refresh()
    fetchProjects()
      .then((data) => setProjects(data.projects))
      .catch(() => {
        // server not reachable; retry on next event
      })
  }, [refresh])

  const addToast = React.useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = ++toastSeq
    setToasts((prev) => [...prev, { id, ...toast }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 9000)
  }, [])

  const dismissToast = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const onMessage = React.useCallback(
    (msg: WsMessage) => {
      switch (msg.type) {
        case 'hello': {
          // The server just (re)connected — it may have restarted since we last
          // talked to it (e.g. during a deploy), wiping its in-memory task state.
          // Anything we still think is "running" that the server doesn't confirm
          // is active anymore would otherwise show "running" forever with no way
          // to tell it's actually dead.
          const active = new Set(msg.activeIssueIds)
          const staleIds = new Set<string>()
          setStreams((prev) =>
            prev.map((s) => {
              if (s.done || active.has(s.issueId)) return s
              staleIds.add(s.issueId)
              return {
                ...s,
                done: true,
                errored: true,
                events: appendEvent(s.events, {
                  kind: 'orchestrator',
                  text: 'Lost connection to the orchestrator while this was running (it may have restarted) — this task\'s real status is unknown. Check Linear directly.',
                }),
              }
            }),
          )
          if (staleIds.size > 0) {
            setRunningIds((prev) => {
              const next = new Set(prev)
              for (const id of staleIds) next.delete(id)
              return next
            })
          }

          // Same recovery, for refine chats: a turn the server no longer confirms
          // as active gets a note appended to its last (in-flight) message instead
          // of spinning forever.
          const activeRefine = new Set(msg.activeRefineIssueIds)
          const staleRefineIds = [...refineRunningRef.current].filter((id) => !activeRefine.has(id))
          if (staleRefineIds.length > 0) {
            setRefineRunning((prev) => {
              const next = new Set(prev)
              for (const id of staleRefineIds) next.delete(id)
              return next
            })
            setRefineChats((prev) => {
              const next = { ...prev }
              for (const issueId of staleRefineIds) {
                const list = next[issueId]
                if (!list || list.length === 0) continue
                const lastMsg = list[list.length - 1]
                next[issueId] = [
                  ...list.slice(0, -1),
                  {
                    ...lastMsg,
                    events: appendEvent(lastMsg.events, {
                      kind: 'orchestrator',
                      text: 'Lost connection while this was running — check back or try again.',
                    }),
                  },
                ]
              }
              return next
            })
          }

          // Same recovery again, for ideation sessions.
          const activeIdeation = new Set(msg.activeIdeationSessionIds)
          const staleIdeationIds = [...ideationRunningRef.current].filter((id) => !activeIdeation.has(id))
          if (staleIdeationIds.length > 0) {
            setIdeationRunning((prev) => {
              const next = new Set(prev)
              for (const id of staleIdeationIds) next.delete(id)
              return next
            })
            setIdeationSessions((prev) => {
              const next = { ...prev }
              for (const sessionId of staleIdeationIds) {
                const session = next[sessionId]
                if (!session || session.messages.length === 0) continue
                const lastMsg = session.messages[session.messages.length - 1]
                next[sessionId] = {
                  ...session,
                  messages: [
                    ...session.messages.slice(0, -1),
                    {
                      ...lastMsg,
                      events: appendEvent(lastMsg.events, {
                        kind: 'orchestrator',
                        text: 'Lost connection while this was running — check back or try again.',
                      }),
                    },
                  ],
                }
              }
              return next
            })
          }

          // Same recovery again, for Driver sessions.
          const activeDriver = new Set(msg.activeDriverSessionIds)
          const staleDriverIds = [...driverRunningRef.current].filter((id) => !activeDriver.has(id))
          if (staleDriverIds.length > 0) {
            setDriverRunning((prev) => {
              const next = new Set(prev)
              for (const id of staleDriverIds) next.delete(id)
              return next
            })
            setDriverSessions((prev) => {
              const next = { ...prev }
              for (const sessionId of staleDriverIds) {
                const session = next[sessionId]
                if (!session || session.messages.length === 0) continue
                const lastMsg = session.messages[session.messages.length - 1]
                next[sessionId] = {
                  ...session,
                  messages: [
                    ...session.messages.slice(0, -1),
                    {
                      ...lastMsg,
                      events: appendEvent(lastMsg.events, {
                        kind: 'orchestrator',
                        text: 'Lost connection while this was running — check back or try again.',
                      }),
                    },
                  ],
                }
              }
              return next
            })
          }

          // Mode is memory-only server-side (see server/index.ts's
          // driverSessionMode) — a restart always resets every session back to
          // manual. Reconcile the local optimistic value against the
          // server's real truth so a reload never shows a stale "autonomous".
          setDriverSessions((prev) => {
            const next = { ...prev }
            let changed = false
            for (const [sessionId, session] of Object.entries(next)) {
              const serverMode: DriverMode = msg.driverSessionModes[sessionId] ?? 'manual'
              if (session.mode === serverMode) continue
              changed = true
              next[sessionId] = { ...session, mode: serverMode }
            }
            return changed ? next : prev
          })
          setDriverOwnership(msg.driverOwnership)

          // Same recovery again, for Design sessions.
          const activeDesign = new Set(msg.activeDesignSessionIds)
          const staleDesignIds = [...designRunningRef.current].filter((id) => !activeDesign.has(id))
          if (staleDesignIds.length > 0) {
            setDesignRunning((prev) => {
              const next = new Set(prev)
              for (const id of staleDesignIds) next.delete(id)
              return next
            })
            setDesignSessions((prev) => {
              const next = { ...prev }
              for (const sessionId of staleDesignIds) {
                const session = next[sessionId]
                if (!session || session.messages.length === 0) continue
                const lastMsg = session.messages[session.messages.length - 1]
                next[sessionId] = {
                  ...session,
                  messages: [
                    ...session.messages.slice(0, -1),
                    {
                      ...lastMsg,
                      events: appendEvent(lastMsg.events, {
                        kind: 'orchestrator',
                        text: 'Lost connection while this was running — check back or try again.',
                      }),
                    },
                  ],
                }
              }
              return next
            })
          }
          break
        }
        case 'task_started':
          // Unconditional replace, not "skip if an entry already exists": a
          // restart legitimately reuses the same issueId while a stale (done)
          // entry from the killed attempt still sits in `streams`.
          setStreams((prev) => [
            ...prev.filter((s) => s.issueId !== msg.issueId),
            { issueId: msg.issueId, events: [], done: false },
          ])
          setRunningIds((prev) => new Set(prev).add(msg.issueId))
          break
        case 'output':
          setStreams((prev) =>
            prev.map((s) => (s.issueId === msg.issueId ? { ...s, events: appendEvent(s.events, msg.event) } : s)),
          )
          break
        case 'done':
          setStreams((prev) => prev.map((s) => (s.issueId === msg.issueId ? { ...s, done: true } : s)))
          setRunningIds((prev) => {
            const next = new Set(prev)
            next.delete(msg.issueId)
            return next
          })
          refreshIssue(msg.issueId)
          break
        case 'stopped':
          setStreams((prev) => prev.map((s) => (s.issueId === msg.issueId ? { ...s, done: true, stopped: true } : s)))
          setRunningIds((prev) => {
            const next = new Set(prev)
            next.delete(msg.issueId)
            return next
          })
          refreshIssue(msg.issueId)
          break
        case 'pr_created':
          setPrByIssue((prev) => ({ ...prev, [msg.issueId]: msg.prUrl }))
          addToast({
            kind: 'success',
            title: `PR created for ${msg.issueId}`,
            body: 'The pull request is ready.',
            prUrl: msg.prUrl,
          })
          refreshIssue(msg.issueId)
          break
        case 'issue_updated':
          refreshIssue(msg.issueId)
          break
        case 'issue_created':
          // The webhook handler already resolved the full issue server-side
          // in the common case — no extra request needed to show it.
          if (msg.issue) {
            upsertIssue(msg.issue)
          } else if (msg.issueId) {
            refreshIssue(msg.issueId)
          }
          break
        case 'issue_removed':
          setIssues((prev) => prev.filter((i) => i.id !== msg.issueId))
          break
        case 'error':
          addToast({ kind: 'error', title: 'Error', body: msg.message })
          if (msg.issueId) {
            const issueId = msg.issueId
            setRunningIds((prev) => {
              const next = new Set(prev)
              next.delete(issueId)
              return next
            })
            setStreams((prev) =>
              prev.map((s) => (s.issueId === issueId ? { ...s, done: true, errored: true } : s)),
            )
            if (refineRunningRef.current.has(issueId)) {
              pendingConsolidateRef.current.delete(issueId)
              setRefineRunning((prev) => {
                const next = new Set(prev)
                next.delete(issueId)
                return next
              })
              setRefineChats((prev) => {
                const list = prev[issueId]
                if (!list || list.length === 0) return prev
                const lastMsg = list[list.length - 1]
                return {
                  ...prev,
                  [issueId]: [
                    ...list.slice(0, -1),
                    { ...lastMsg, events: appendEvent(lastMsg.events, { kind: 'orchestrator', text: `Failed: ${msg.message}` }) },
                  ],
                }
              })
            }
          } else if (msg.sessionId) {
            const sessionId = msg.sessionId
            setIdeationRunning((prev) => {
              const next = new Set(prev)
              next.delete(sessionId)
              return next
            })
            setIdeationSessions((prev) => {
              const session = prev[sessionId]
              if (!session || session.messages.length === 0) return prev
              const lastMsg = session.messages[session.messages.length - 1]
              return {
                ...prev,
                [sessionId]: {
                  ...session,
                  messages: [
                    ...session.messages.slice(0, -1),
                    { ...lastMsg, events: appendEvent(lastMsg.events, { kind: 'orchestrator', text: `Failed: ${msg.message}` }) },
                  ],
                },
              }
            })
          }
          break
        case 'refine_turn_started':
          setRefineChats((prev) => ({
            ...prev,
            [msg.issueId]: [...(prev[msg.issueId] || []), { id: crypto.randomUUID(), role: 'assistant', events: [] }],
          }))
          setRefineRunning((prev) => new Set(prev).add(msg.issueId))
          break
        case 'refine_output':
          setRefineChats((prev) => {
            const list = prev[msg.issueId]
            if (!list || list.length === 0) return prev
            const lastMsg = list[list.length - 1]
            return {
              ...prev,
              [msg.issueId]: [...list.slice(0, -1), { ...lastMsg, events: appendEvent(lastMsg.events, msg.event) }],
            }
          })
          break
        case 'refine_turn_done': {
          const issueId = msg.issueId
          setRefineRunning((prev) => {
            const next = new Set(prev)
            next.delete(issueId)
            return next
          })
          if (pendingConsolidateRef.current.has(issueId)) {
            pendingConsolidateRef.current.delete(issueId)
            const list = refineChatsRef.current[issueId]
            const planText = list && list.length > 0 ? eventsToPlainText(list[list.length - 1].events) : ''
            setDraftPlans((prev) => ({ ...prev, [issueId]: planText }))
          }
          break
        }
        case 'ideation_turn_started':
          setIdeationSessions((prev) => {
            const session = prev[msg.sessionId]
            if (!session) return prev
            return {
              ...prev,
              [msg.sessionId]: {
                ...session,
                createdAt: new Date().toISOString(),
                messages: [...session.messages, { id: crypto.randomUUID(), role: 'assistant', events: [] }],
              },
            }
          })
          setIdeationRunning((prev) => new Set(prev).add(msg.sessionId))
          break
        case 'ideation_output':
          setIdeationSessions((prev) => {
            const session = prev[msg.sessionId]
            if (!session || session.messages.length === 0) return prev
            const lastMsg = session.messages[session.messages.length - 1]
            return {
              ...prev,
              [msg.sessionId]: {
                ...session,
                messages: [...session.messages.slice(0, -1), { ...lastMsg, events: appendEvent(lastMsg.events, msg.event) }],
              },
            }
          })
          break
        case 'ideation_turn_done': {
          const sessionId = msg.sessionId
          setIdeationRunning((prev) => {
            const next = new Set(prev)
            next.delete(sessionId)
            return next
          })
          break
        }
        case 'driver_turn_started':
          setDriverSessions((prev) => {
            const session = prev[msg.sessionId]
            if (!session) return prev
            return {
              ...prev,
              [msg.sessionId]: {
                ...session,
                createdAt: new Date().toISOString(),
                messages: [...session.messages, { id: crypto.randomUUID(), role: 'assistant', events: [] }],
              },
            }
          })
          setDriverRunning((prev) => new Set(prev).add(msg.sessionId))
          break
        case 'driver_output':
          setDriverSessions((prev) => {
            const session = prev[msg.sessionId]
            if (!session || session.messages.length === 0) return prev
            const lastMsg = session.messages[session.messages.length - 1]
            return {
              ...prev,
              [msg.sessionId]: {
                ...session,
                messages: [...session.messages.slice(0, -1), { ...lastMsg, events: appendEvent(lastMsg.events, msg.event) }],
              },
            }
          })
          break
        case 'driver_turn_done':
          setDriverRunning((prev) => {
            const next = new Set(prev)
            next.delete(msg.sessionId)
            return next
          })
          break
        case 'driver_action': {
          // Rendered via the existing orchestrator-note component, same as
          // runTask's own narration — no new AgentEvent kind needed for this.
          const verb = msg.status === 'started' ? '→' : msg.status === 'done' ? '✓' : msg.status === 'skipped' ? '⊘' : '✗'
          // 'create' has no issueId until it succeeds (the id doesn't exist yet
          // on the 'started'/failed-before-creation broadcasts).
          const text = `${verb} ${msg.action}${msg.issueId ? ` ${msg.issueId}` : ''}: ${msg.status}${msg.message ? ` — ${msg.message}` : ''}`
          setDriverSessions((prev) => {
            const session = prev[msg.sessionId]
            if (!session || session.messages.length === 0) return prev
            const lastMsg = session.messages[session.messages.length - 1]
            return {
              ...prev,
              [msg.sessionId]: {
                ...session,
                messages: [...session.messages.slice(0, -1), { ...lastMsg, events: appendEvent(lastMsg.events, { kind: 'orchestrator', text }) }],
              },
            }
          })
          break
        }
        case 'driver_mode_changed':
          setDriverSessions((prev) => {
            const session = prev[msg.sessionId]
            if (!session) return prev
            const withMode = { ...session, mode: msg.mode }
            if (!msg.reason || withMode.messages.length === 0) return { ...prev, [msg.sessionId]: withMode }
            const lastMsg = withMode.messages[withMode.messages.length - 1]
            return {
              ...prev,
              [msg.sessionId]: {
                ...withMode,
                messages: [
                  ...withMode.messages.slice(0, -1),
                  { ...lastMsg, events: appendEvent(lastMsg.events, { kind: 'orchestrator', text: msg.reason }) },
                ],
              },
            }
          })
          break
        case 'driver_ownership_changed':
          setDriverOwnership((prev) => ({ ...prev, [msg.sessionId]: msg.ownedIssueIds }))
          break
        case 'design_turn_started':
          setDesignSessions((prev) => {
            const session = prev[msg.sessionId]
            if (!session) return prev
            return {
              ...prev,
              [msg.sessionId]: {
                ...session,
                createdAt: new Date().toISOString(),
                messages: [...session.messages, { id: crypto.randomUUID(), role: 'assistant', events: [] }],
              },
            }
          })
          setDesignRunning((prev) => new Set(prev).add(msg.sessionId))
          break
        case 'design_output':
          setDesignSessions((prev) => {
            const session = prev[msg.sessionId]
            if (!session || session.messages.length === 0) return prev
            const lastMsg = session.messages[session.messages.length - 1]
            return {
              ...prev,
              [msg.sessionId]: {
                ...session,
                messages: [...session.messages.slice(0, -1), { ...lastMsg, events: appendEvent(lastMsg.events, msg.event) }],
              },
            }
          })
          break
        case 'design_turn_done':
          setDesignRunning((prev) => {
            const next = new Set(prev)
            next.delete(msg.sessionId)
            return next
          })
          setDesignPreviewRefresh((prev) => ({ ...prev, [msg.sessionId]: (prev[msg.sessionId] ?? 0) + 1 }))
          break
        case 'design_issue_linked':
          setDesignSessions((prev) => {
            const session = prev[msg.sessionId]
            if (!session) return prev
            return { ...prev, [msg.sessionId]: { ...session, issueId: msg.issueId } }
          })
          break
        case 'design_committed':
          setDesignCommitting((prev) => {
            const next = new Set(prev)
            next.delete(msg.sessionId)
            return next
          })
          addToast(
            msg.ok
              ? { kind: 'success', title: 'Design committed', body: msg.message }
              : { kind: 'error', title: 'Commit failed', body: msg.message },
          )
          break
        default:
          break
      }
    },
    [
      addToast,
      refresh,
      refreshIssue,
      upsertIssue,
      refineChatsRef,
      refineRunningRef,
      setRefineChats,
      setRefineRunning,
      ideationSessionsRef,
      ideationRunningRef,
      setIdeationSessions,
      setIdeationRunning,
      driverRunningRef,
      setDriverSessions,
      setDriverRunning,
      setDriverOwnership,
      designRunningRef,
      setDesignSessions,
      setDesignRunning,
      setDesignPreviewRefresh,
      setDesignCommitting,
    ],
  )

  const { connected, send } = useSocket(onMessage)

  const selected = issues.find((issue) => issue.id === selectedId) || null
  const running = selectedId ? runningIds.has(selectedId) : false
  const selectedPrUrl = selectedId ? prByIssue[selectedId] : null

  const handleCreate = async (payload: { title: string; description?: string; projectId?: string }) => {
    const { issue } = await createIssue(payload)
    upsertIssue(issue)
  }

  const handleStart = (issueId: string, task: string, fresh?: boolean) => {
    send({ type: 'start', issueId, task, fresh })
  }

  const handleStop = (issueId: string) => {
    send({ type: 'stop', issueId })
  }

  const handleRestart = (issueId: string) => {
    send({ type: 'restart', issueId })
  }

  const handleRefineStart = (issueId: string) => {
    send({ type: 'refine_start', issueId })
  }

  const handleRefineMessage = (issueId: string, message: string) => {
    setRefineChats((prev) => ({
      ...prev,
      [issueId]: [...(prev[issueId] || []), { id: crypto.randomUUID(), role: 'user', events: [{ kind: 'text', text: message }] }],
    }))
    send({ type: 'refine_message', issueId, message })
  }

  const handleConsolidate = (issueId: string) => {
    pendingConsolidateRef.current.add(issueId)
    send({ type: 'refine_consolidate', issueId })
  }

  const handleApplyPlan = async (issueId: string, planText: string) => {
    await updateIssue(issueId, { description: planText })
    const { issue } = await setIssueStatus(issueId, 'Todo')
    setDraftPlans((prev) => {
      const next = { ...prev }
      delete next[issueId]
      return next
    })
    upsertIssue(issue)
  }

  const handleMove = async (issueId: string, status: string) => {
    const { issue } = await setIssueStatus(issueId, status)
    upsertIssue(issue)
  }

  const handleUpdate = async (issueId: string, payload: { title?: string; description?: string }) => {
    const { issue } = await updateIssue(issueId, payload)
    upsertIssue(issue)
  }

  const handleNewIdeation = (projectId: string) => {
    const sessionId = `ideation:${crypto.randomUUID()}`
    const session: IdeationSession = { id: sessionId, title: '', projectId, createdAt: new Date().toISOString(), messages: [] }
    setIdeationSessions((prev) => ({ ...prev, [sessionId]: session }))
    setSelectedIdeationId(sessionId)
  }

  const handleDeleteIdeation = (sessionId: string) => {
    if (!window.confirm('Delete this discussion?')) return
    setIdeationSessions((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    if (selectedIdeationId === sessionId) setSelectedIdeationId(null)
    send({ type: 'delete_session', sessionId })
  }

  const handleIdeationMessage = (sessionId: string, message: string, images?: string[]) => {
    const projectId = ideationSessionsRef.current[sessionId]?.projectId
    setIdeationSessions((prev) => {
      const session = prev[sessionId]
      if (!session) return prev
      return {
        ...prev,
        [sessionId]: {
          ...session,
          title: session.title || message.slice(0, 60) || (images?.length ? 'Screenshot' : ''),
          createdAt: new Date().toISOString(),
          messages: [
            ...session.messages,
            {
              id: crypto.randomUUID(),
              role: 'user',
              events: message.trim() ? [{ kind: 'text', text: message }] : [],
              images,
            },
          ],
        },
      }
    })
    send({ type: 'ideation_message', sessionId, projectId, message, images })
  }

  const handleCreateCandidate = async (sessionId: string, candidate: IdeationCandidate, projectId: string) => {
    const { issue } = await createIssue({ title: candidate.title, description: candidate.description, projectId })
    upsertIssue(issue)
    addToast({ kind: 'success', title: `Created ${issue.id}`, body: issue.title })
  }

  const handleNewDriver = (projectId: string) => {
    const sessionId = `driver:${crypto.randomUUID()}`
    const session: DriverSession = { id: sessionId, title: '', projectId, createdAt: new Date().toISOString(), mode: 'manual', messages: [] }
    setDriverSessions((prev) => ({ ...prev, [sessionId]: session }))
    setSelectedDriverId(sessionId)
  }

  const handleDeleteDriver = (sessionId: string) => {
    if (!window.confirm('Delete this Driver session?')) return
    setDriverSessions((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    if (selectedDriverId === sessionId) setSelectedDriverId(null)
    send({ type: 'delete_session', sessionId })
  }

  const handleDriverMessage = (sessionId: string, message: string, images?: string[]) => {
    const projectId = driverSessionsRef.current[sessionId]?.projectId
    setDriverSessions((prev) => {
      const session = prev[sessionId]
      if (!session) return prev
      return {
        ...prev,
        [sessionId]: {
          ...session,
          title: session.title || message.slice(0, 60) || (images?.length ? 'Screenshot' : ''),
          createdAt: new Date().toISOString(),
          messages: [
            ...session.messages,
            {
              id: crypto.randomUUID(),
              role: 'user',
              events: message.trim() ? [{ kind: 'text', text: message }] : [],
              images,
            },
          ],
        },
      }
    })
    send({ type: 'driver_message', sessionId, projectId, message, images })
  }

  // A digest of recent Ideation discussions for the same project, so
  // autonomous mode's backlog picks are "based on our discussions" instead of
  // just the raw backlog — Ideation transcripts are client-only, so this is
  // the only way that context can reach the server.
  const buildDiscussionContext = (projectId: string): string | undefined => {
    const sessions = Object.values(ideationSessionsRef.current)
      .filter((s) => s.projectId === projectId && s.messages.length > 0)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5)
    if (sessions.length === 0) return undefined
    const text = sessions
      .map((s) => `### ${s.title || 'Untitled discussion'}\n${s.messages.map((m) => `${m.role}: ${eventsToPlainText(m.events)}`).join('\n')}`)
      .join('\n\n')
    return text.slice(0, 8000)
  }

  const handleDriverSetMode = (sessionId: string, mode: DriverMode) => {
    const projectId = driverSessionsRef.current[sessionId]?.projectId
    setDriverSessions((prev) => {
      const session = prev[sessionId]
      if (!session) return prev
      return { ...prev, [sessionId]: { ...session, mode } }
    })
    const discussionContext = mode === 'autonomous' && projectId ? buildDiscussionContext(projectId) : undefined
    send({ type: 'driver_set_mode', sessionId, projectId, mode, discussionContext })
  }

  const handleNewDesign = (projectId: string, issueId?: string) => {
    const sessionId = `design:${crypto.randomUUID()}`
    const session: DesignSession = { id: sessionId, title: '', projectId, issueId, createdAt: new Date().toISOString(), messages: [] }
    setDesignSessions((prev) => ({ ...prev, [sessionId]: session }))
    setSelectedDesignId(sessionId)
  }

  const handleDeleteDesign = (sessionId: string) => {
    if (!window.confirm('Delete this design?')) return
    const projectId = designSessionsRef.current[sessionId]?.projectId
    setDesignSessions((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    if (selectedDesignId === sessionId) setSelectedDesignId(null)
    send({ type: 'delete_session', sessionId, projectId })
  }

  const handleDesignMessage = (sessionId: string, message: string, images?: string[]) => {
    const projectId = designSessionsRef.current[sessionId]?.projectId
    setDesignSessions((prev) => {
      const session = prev[sessionId]
      if (!session) return prev
      return {
        ...prev,
        [sessionId]: {
          ...session,
          title: session.title || message.slice(0, 60) || (images?.length ? 'Screenshot' : ''),
          createdAt: new Date().toISOString(),
          messages: [
            ...session.messages,
            {
              id: crypto.randomUUID(),
              role: 'user',
              events: message.trim() ? [{ kind: 'text', text: message }] : [],
              images,
            },
          ],
        },
      }
    })
    send({ type: 'design_message', sessionId, projectId, message, images })
  }

  const handleLinkDesignIssue = (sessionId: string, issueId: string) => {
    const projectId = designSessionsRef.current[sessionId]?.projectId
    send({ type: 'design_link_issue', sessionId, projectId, issueId })
  }

  const handleCommitDesign = (sessionId: string) => {
    const projectId = designSessionsRef.current[sessionId]?.projectId
    const issueId = designSessionsRef.current[sessionId]?.issueId
    setDesignCommitting((prev) => new Set(prev).add(sessionId))
    send({ type: 'design_commit', sessionId, projectId, issueId })
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <img src="/favicon.png" alt="Sillage" className="app-logo" />
          Sillage
        </h1>
        <nav className="view-tabs">
          <button type="button" className={view === 'ideation' ? 'active' : ''} onClick={() => setView('ideation')}>
            Ideation
          </button>
          <button type="button" className={view === 'project' ? 'active' : ''} onClick={() => setView('project')}>
            Board
          </button>
          <button type="button" className={view === 'execution' ? 'active' : ''} onClick={() => setView('execution')}>
            Agent output
          </button>
          <button type="button" className={view === 'driver' ? 'active' : ''} onClick={() => setView('driver')}>
            Driver
          </button>
          <button type="button" className={view === 'design' ? 'active' : ''} onClick={() => setView('design')}>
            Design
          </button>
          <button type="button" className={view === 'metrics' ? 'active' : ''} onClick={() => setView('metrics')}>
            Metrics
          </button>
          <button type="button" className={view === 'usage' ? 'active' : ''} onClick={() => setView('usage')}>
            Usage
          </button>
          <button type="button" className={view === 'plans' ? 'active' : ''} onClick={() => setView('plans')}>
            Plans
          </button>
        </nav>
        <div className={`status-dot ${connected ? 'online' : 'offline'}`} title={connected ? 'orchestrator online' : 'orchestrator offline'}>
          {connected ? 'orchestrator online' : 'orchestrator offline'}
        </div>
      </header>
      <main className="layout">
        {view === 'project' && (
          <IssueTracker
            issues={issues}
            columns={columns}
            projects={projects}
            selectedId={selectedId}
            runningIds={runningIds}
            loading={issuesLoading}
            loadError={issuesError}
            onSelect={(issue) => setSelectedId(issue.id)}
            onCreate={handleCreate}
            onMove={handleMove}
          />
        )}
        {view === 'execution' && (
          <ResponseStream
            streams={streams}
            onClear={() => setStreams([])}
          />
        )}
        {view === 'ideation' && (
          <IdeationView
            sessions={ideationSessions}
            selectedId={selectedIdeationId}
            running={ideationRunning}
            projects={projects}
            connected={connected}
            onSelect={setSelectedIdeationId}
            onNew={handleNewIdeation}
            onSend={handleIdeationMessage}
            onCreateCandidate={handleCreateCandidate}
            onDelete={handleDeleteIdeation}
          />
        )}
        {view === 'driver' && (
          <DriverView
            sessions={driverSessions}
            selectedId={selectedDriverId}
            running={driverRunning}
            ownership={driverOwnership}
            projects={projects}
            connected={connected}
            onSelect={setSelectedDriverId}
            onNew={handleNewDriver}
            onSend={handleDriverMessage}
            onSetMode={handleDriverSetMode}
            onDelete={handleDeleteDriver}
          />
        )}
        {view === 'design' && (
          <DesignView
            sessions={designSessions}
            selectedId={selectedDesignId}
            running={designRunning}
            committing={designCommitting}
            previewRefresh={designPreviewRefresh}
            projects={projects}
            issues={issues}
            connected={connected}
            onSelect={setSelectedDesignId}
            onNew={handleNewDesign}
            onSend={handleDesignMessage}
            onLinkIssue={handleLinkDesignIssue}
            onCommit={handleCommitDesign}
            onDelete={handleDeleteDesign}
          />
        )}
        {view === 'metrics' && <MetricsView issues={issues} projects={projects} columns={columns} />}
        {view === 'usage' && <UsageView />}
        {view === 'plans' && (
          <div className="plans-panel">
            <h2>Plans{selectedId ? ` for ${selectedId}` : ''}</h2>
            {plansError && <p className="error">{plansError}</p>}
            <PlansView plans={plans} disabled={plansLoading} onApply={refreshPlans} />
          </div>
        )}
      </main>
      <TaskPanel
        key={selected?.id}
        issue={selected ? { ...selected, prUrl: selectedPrUrl } : null}
        connected={connected}
        running={running}
        onStart={handleStart}
        onStop={handleStop}
        onRestart={handleRestart}
        onUpdate={handleUpdate}
        onMove={handleMove}
        onClose={() => setSelectedId(null)}
        refineChat={selectedId ? refineChats[selectedId] || [] : []}
        refineRunning={selectedId ? refineRunning.has(selectedId) : false}
        draftPlan={selectedId ? draftPlans[selectedId] || null : null}
        onRefineStart={handleRefineStart}
        onRefineMessage={handleRefineMessage}
        onConsolidate={handleConsolidate}
        onApplyPlan={handleApplyPlan}
      />
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
