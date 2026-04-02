import { useEffect, useState, useCallback } from 'react'
import { io, type Socket } from 'socket.io-client'
import { CORE_URL } from './config'
import { DeviceGrid } from './components/device-grid'
import { DeviceDetail } from './components/device-detail'
import { AlertPanel } from './components/alert-panel'
import { MessageList } from './components/message-list'
import { SendForm } from './components/send-form'
import type { DeviceRecord, HealthSnapshot, WhatsAppAccount, Alert, Message } from './types'

export function App() {
  const [devices, setDevices] = useState<DeviceRecord[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [connected, setConnected] = useState(false)
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null)
  const [detailHealth, setDetailHealth] = useState<HealthSnapshot[]>([])
  const [detailAccounts, setDetailAccounts] = useState<WhatsAppAccount[]>([])
  const [detailAlerts, setDetailAlerts] = useState<Alert[]>([])

  const fetchDevices = useCallback(() => {
    fetch(`${CORE_URL}/api/v1/monitor/devices`)
      .then((r) => r.json())
      .then(setDevices)
      .catch(() => {})
  }, [])

  const fetchAlerts = useCallback(() => {
    fetch(`${CORE_URL}/api/v1/monitor/alerts`)
      .then((r) => r.json())
      .then(setAlerts)
      .catch(() => {})
  }, [])

  const fetchDetail = useCallback((serial: string) => {
    fetch(`${CORE_URL}/api/v1/monitor/devices/${serial}`)
      .then((r) => r.json())
      .then((data) => {
        setDetailHealth(data.health ?? [])
        setDetailAccounts(data.accounts ?? [])
        setDetailAlerts(data.alerts ?? [])
      })
      .catch(() => {})
  }, [])

  // Fetch initial data
  useEffect(() => {
    fetchDevices()
    fetchAlerts()

    fetch(`${CORE_URL}/api/v1/messages`)
      .then((r) => r.json())
      .then(setMessages)
      .catch(() => {})
  }, [fetchDevices, fetchAlerts])

  // Refresh detail when selection changes
  useEffect(() => {
    if (selectedSerial) fetchDetail(selectedSerial)
  }, [selectedSerial, fetchDetail])

  // Socket.IO real-time updates
  useEffect(() => {
    const socket: Socket = io(CORE_URL)

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on('message:queued', (data: { id: string }) => {
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

    socket.on('device:connected', () => fetchDevices())
    socket.on('device:disconnected', () => {
      fetchDevices()
      fetchAlerts()
    })

    socket.on('device:health', (data: { serial: string }) => {
      if (data.serial === selectedSerial) {
        fetchDetail(data.serial)
      }
    })

    socket.on('alert:new', () => {
      fetchAlerts()
      if (selectedSerial) fetchDetail(selectedSerial)
    })

    return () => {
      socket.disconnect()
    }
  }, [fetchDevices, fetchAlerts, fetchDetail, selectedSerial])

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

  const hasOnlineDevice = devices.some((d) => d.status === 'online')
  const selectedDevice = devices.find((d) => d.serial === selectedSerial) ?? null

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-bold">Dispatch</h1>
        <div className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
        <span className="text-xs text-zinc-500">{connected ? 'connected' : 'disconnected'}</span>
        <span className="ml-auto text-xs text-zinc-600">
          {devices.length} device{devices.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: devices + alerts */}
        <div className="lg:col-span-2 space-y-6">
          <section>
            <h2 className="text-sm font-medium text-zinc-400 mb-2">Devices</h2>
            <DeviceGrid
              devices={devices}
              alerts={alerts}
              selectedSerial={selectedSerial}
              onSelect={(serial) =>
                setSelectedSerial(serial === selectedSerial ? null : serial)
              }
            />
          </section>

          {selectedDevice && (
            <section>
              <DeviceDetail
                device={selectedDevice}
                health={detailHealth}
                accounts={detailAccounts}
                alerts={detailAlerts}
                onClose={() => setSelectedSerial(null)}
              />
            </section>
          )}

          <section>
            <h2 className="text-sm font-medium text-zinc-400 mb-2">Send Message</h2>
            <SendForm onSend={handleSend} disabled={!hasOnlineDevice} />
          </section>

          <section>
            <h2 className="text-sm font-medium text-zinc-400 mb-2">
              Queue ({messages.length})
            </h2>
            <MessageList messages={messages} />
          </section>
        </div>

        {/* Right column: alerts */}
        <div>
          <section>
            <h2 className="text-sm font-medium text-zinc-400 mb-2">
              Alerts ({alerts.length})
            </h2>
            <AlertPanel alerts={alerts} />
          </section>
        </div>
      </div>
    </div>
  )
}
