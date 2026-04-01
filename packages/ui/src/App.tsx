import { useEffect, useState, useCallback } from 'react'
import { io, type Socket } from 'socket.io-client'
import { CORE_URL } from './config'
import { DeviceCard } from './components/device-card'
import { MessageList } from './components/message-list'
import { SendForm } from './components/send-form'
import type { DeviceInfo, Message } from './types'

export function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [connected, setConnected] = useState(false)

  // Fetch initial data
  useEffect(() => {
    fetch(`${CORE_URL}/api/v1/devices`)
      .then((r) => r.json())
      .then(setDevices)
      .catch(() => {})

    fetch(`${CORE_URL}/api/v1/messages`)
      .then((r) => r.json())
      .then(setMessages)
      .catch(() => {})
  }, [])

  // Socket.IO real-time updates
  useEffect(() => {
    const socket: Socket = io(CORE_URL)

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on('message:queued', (data: { id: string }) => {
      // Refetch messages on new queue event
      fetch(`${CORE_URL}/api/v1/messages/${data.id}`)
        .then((r) => r.json())
        .then((msg: Message) => {
          setMessages((prev) => [msg, ...prev.filter((m) => m.id !== msg.id)])
        })
        .catch(() => {})
    })

    const statusEvents = ['message:sending', 'message:sent', 'message:failed'] as const
    for (const event of statusEvents) {
      socket.on(event, (data: { id: string }) => {
        fetch(`${CORE_URL}/api/v1/messages/${data.id}`)
          .then((r) => r.json())
          .then((msg: Message) => {
            setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)))
          })
          .catch(() => {})
      })
    }

    socket.on('device:connected', () => {
      fetch(`${CORE_URL}/api/v1/devices`)
        .then((r) => r.json())
        .then(setDevices)
        .catch(() => {})
    })

    socket.on('device:disconnected', () => {
      fetch(`${CORE_URL}/api/v1/devices`)
        .then((r) => r.json())
        .then(setDevices)
        .catch(() => {})
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  const handleSend = useCallback(async (to: string, body: string) => {
    const idempotencyKey = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const res = await fetch(`${CORE_URL}/api/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, body, idempotencyKey }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to send')
    }
  }, [])

  const device = devices[0] ?? null

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-bold">Dispatch</h1>
        <div className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <span className="text-xs text-zinc-500">{connected ? 'connected' : 'disconnected'}</span>
      </div>

      <section className="mb-6">
        <h2 className="text-sm font-medium text-zinc-400 mb-2">Device</h2>
        <DeviceCard device={device} />
      </section>

      <section className="mb-6">
        <h2 className="text-sm font-medium text-zinc-400 mb-2">Send Message</h2>
        <SendForm onSend={handleSend} disabled={!device || device.type !== 'device'} />
      </section>

      <section>
        <h2 className="text-sm font-medium text-zinc-400 mb-2">
          Queue ({messages.length})
        </h2>
        <MessageList messages={messages} />
      </section>
    </div>
  )
}
