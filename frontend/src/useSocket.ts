import React from 'react'
import type { WsMessage } from './types.ts'

const wsBase = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'

export function useSocket(onMessage: (msg: WsMessage) => void) {
  const [connected, setConnected] = React.useState(false)
  const socketRef = React.useRef<WebSocket | null>(null)

  React.useEffect(() => {
    let ws: WebSocket
    let retry: ReturnType<typeof setTimeout>
    let disposed = false

    const connect = () => {
      ws = new WebSocket(wsBase())
      socketRef.current = ws
      ws.onopen = () => {
        if (!disposed) setConnected(true)
      }
      ws.onclose = () => {
        if (disposed) return
        setConnected(false)
        socketRef.current = null
        retry = setTimeout(connect, 1500)
      }
      ws.onmessage = (event) => {
        if (disposed) return
        try {
          onMessage(JSON.parse(event.data))
        } catch {
          // ignore malformed frames
        }
      }
    }

    connect()
    return () => {
      disposed = true
      clearTimeout(retry)
      if (ws) {
        ws.onopen = ws.onclose = ws.onmessage = null
        ws.close()
      }
      if (socketRef.current === ws) socketRef.current = null
    }
  }, [onMessage])

  const send = React.useCallback((payload: unknown) => {
    const ws = socketRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }, [])

  return { connected, send }
}
