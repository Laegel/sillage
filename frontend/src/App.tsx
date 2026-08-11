import React from 'react'
import { createIssue, fetchIssues, fetchProjects, setIssueStatus, updateIssue } from './api.ts'
import { useSocket } from './useSocket.ts'
import IssueTracker from './components/IssueTracker.tsx'
import TaskPanel from './components/TaskPanel.tsx'
import ResponseStream from './components/ResponseStream.tsx'
import Toasts from './components/Toasts.tsx'
import type { ChatMessage, Issue, Project, StreamEntry, ToastMessage, WsMessage } from './types.ts'
import { appendEvent, eventsToPlainText } from './lib/agentEvents.ts'

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
  const [projects, setProjects] = React.useState<Project[]>([])
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [streams, setStreams] = React.useState<StreamEntry[]>([])
  const [toasts, setToasts] = React.useState<ToastMessage[]>([])
  const [runningIds, setRunningIds] = React.useState<Set<string>>(new Set())
  const [prByIssue, setPrByIssue] = React.useState<Record<string, string>>({})
  const [classifications, setClassifications] = React.useState<Record<string, string>>({})
  const [refineChats, refineChatsRef, setRefineChats] = useMirroredState<Record<string, ChatMessage[]>>({})
  const [refineRunning, refineRunningRef, setRefineRunning] = useMirroredState<Set<string>>(new Set())
  const [draftPlans, setDraftPlans] = React.useState<Record<string, string>>({})
  const pendingConsolidateRef = React.useRef<Set<string>>(new Set())

  const refresh = React.useCallback(async () => {
    try {
      const data = await fetchIssues()
      setIssues(data.issues)
      setColumns(data.columns)
    } catch {
      // server not reachable; retry on next event
    }
  }, [])

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
          break
        }
        case 'task_started':
          setClassifications((prev) => ({ ...prev, [msg.issueId]: msg.classification }))
          setStreams((prev) => {
            if (prev.some((s) => s.issueId === msg.issueId)) return prev
            return [...prev, { issueId: msg.issueId, classification: msg.classification, events: [], done: false }]
          })
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
          refresh()
          break
        case 'pr_created':
          setPrByIssue((prev) => ({ ...prev, [msg.issueId]: msg.prUrl }))
          addToast({
            kind: 'success',
            title: `PR created for ${msg.issueId}`,
            body: 'The pull request is ready.',
            prUrl: msg.prUrl,
          })
          refresh()
          break
        case 'issue_updated':
          refresh()
          break
        case 'issue_created':
          refresh()
          break
        case 'issue_removed':
          refresh()
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
        default:
          break
      }
    },
    [addToast, refresh, refineChatsRef, refineRunningRef, setRefineChats, setRefineRunning],
  )

  const { connected, send } = useSocket(onMessage)

  const selected = issues.find((issue) => issue.id === selectedId) || null
  const running = selectedId ? runningIds.has(selectedId) : false
  const classification = selectedId ? classifications[selectedId] : null
  const selectedPrUrl = selectedId ? prByIssue[selectedId] : null

  const handleCreate = async (payload: { title: string; description?: string; projectId?: string }) => {
    await createIssue(payload)
    await refresh()
  }

  const handleStart = (issueId: string, task: string) => {
    send({ type: 'start', issueId, task })
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
    await setIssueStatus(issueId, 'Todo')
    setDraftPlans((prev) => {
      const next = { ...prev }
      delete next[issueId]
      return next
    })
    await refresh()
  }

  const handleMove = async (issueId: string, status: string) => {
    await setIssueStatus(issueId, status)
    await refresh()
  }

  const handleUpdate = async (issueId: string, payload: { title?: string; description?: string }) => {
    await updateIssue(issueId, payload)
    await refresh()
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Pilot <span className="muted">· Linear Co-pilot</span></h1>
        <div className={`status-dot ${connected ? 'online' : 'offline'}`} title={connected ? 'orchestrator connected' : 'orchestrator offline'}>
          {connected ? 'orchestrator online' : 'orchestrator offline'}
        </div>
      </header>
      <main className="layout">
        <IssueTracker
          issues={issues}
          columns={columns}
          projects={projects}
          selectedId={selectedId}
          runningIds={runningIds}
          onSelect={(issue) => setSelectedId(issue.id)}
          onCreate={handleCreate}
          onMove={handleMove}
        />
        <TaskPanel
          issue={selected ? { ...selected, prUrl: selectedPrUrl } : null}
          classification={classification}
          connected={connected}
          running={running}
          onStart={handleStart}
          onUpdate={handleUpdate}
          refineChat={selectedId ? refineChats[selectedId] || [] : []}
          refineRunning={selectedId ? refineRunning.has(selectedId) : false}
          draftPlan={selectedId ? draftPlans[selectedId] || null : null}
          onRefineStart={handleRefineStart}
          onRefineMessage={handleRefineMessage}
          onConsolidate={handleConsolidate}
          onApplyPlan={handleApplyPlan}
        />
        <ResponseStream
          streams={streams}
          onClear={() => setStreams([])}
        />
      </main>
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
