import { useEffect, useState, useCallback } from 'react'
import { io, type Socket } from 'socket.io-client'
import { CORE_URL } from './config'
import { DeviceGrid } from './components/device-grid'
import { DeviceDetail } from './components/device-detail'
import { AlertPanel } from './components/alert-panel'
import { MessageList } from './components/message-list'
import { SendForm } from './components/send-form'
import { SessionManager } from './components/session-manager'
import { StatsBar } from './components/stats-bar'
import { Sidebar } from './components/sidebar'
import { LiveScreen } from './components/live-screen'
import { ShellTerminal } from './components/shell-terminal'
import { DeviceInfo } from './components/device-info'
import type { DeviceRecord, HealthSnapshot, WhatsAppAccount, Alert, Message } from './types'

type Tab = 'devices' | 'queue' | 'sessions'

export function App() {
  const [devices, setDevices] = useState<DeviceRecord[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [connected, setConnected] = useState(false)
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null)
  const [detailHealth, setDetailHealth] = useState<HealthSnapshot[]>([])
  const [detailAccounts, setDetailAccounts] = useState<WhatsAppAccount[]>([])
  const [detailAlerts, setDetailAlerts] = useState<Alert[]>([])
  const [activeTab, setActiveTab] = useState<Tab>('devices')

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

  useEffect(() => {
    fetchDevices()
    fetchAlerts()
    fetch(`${CORE_URL}/api/v1/messages`)
      .then((r) => r.json())
      .then(setMessages)
      .catch(() => {})
  }, [fetchDevices, fetchAlerts])

  useEffect(() => {
    if (selectedSerial) fetchDetail(selectedSerial)
  }, [selectedSerial, fetchDetail])

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
      if (data.serial === selectedSerial) fetchDetail(data.serial)
    })

    socket.on('alert:new', () => {
      fetchAlerts()
      if (selectedSerial) fetchDetail(selectedSerial)
    })

    return () => { socket.disconnect() }
  }, [fetchDevices, fetchAlerts, fetchDetail, selectedSerial])

  const handleSend = useCallback(async (to: string, body: string, contactName?: string) => {
    const idempotencyKey = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const res = await fetch(`${CORE_URL}/api/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, body, idempotencyKey, contactName }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Failed to send')
    }
  }, [])

  const hasOnlineDevice = devices.some((d) => d.status === 'online')
  const selectedDevice = devices.find((d) => d.serial === selectedSerial) ?? null
  const onlineCount = devices.filter((d) => d.status === 'online').length
  const sentToday = messages.filter((m) => m.status === 'sent').length
  const pendingCount = messages.filter((m) => m.status === 'queued' || m.status === 'locked').length
  const activeAlertCount = alerts.filter((a) => !a.resolved).length

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
      <Sidebar activeTab={activeTab} onTabChange={setActiveTab} alertCount={activeAlertCount} />

      <div className="flex-1 flex flex-col min-h-screen overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold tracking-tight">Dispatch</h1>
            <span className="text-xs text-zinc-600 font-medium">ADB Orchestrator</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.5)]'} transition-colors`} />
              <span className="text-xs text-zinc-500">{connected ? 'Live' : 'Offline'}</span>
            </div>
            <span className="text-xs text-zinc-600 font-mono">{CORE_URL.replace('http://', '')}</span>
          </div>
        </header>

        {/* Stats */}
        <StatsBar
          deviceCount={devices.length}
          onlineCount={onlineCount}
          sentToday={sentToday}
          pendingCount={pendingCount}
          alertCount={activeAlertCount}
        />

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-6">
          {activeTab === 'sessions' ? (
            <SessionManager />
          ) : activeTab === 'queue' ? (
            <div className="space-y-6">
              <SendForm onSend={handleSend} disabled={!hasOnlineDevice} />
              <MessageList messages={messages} />
            </div>
          ) : (
            <div className="space-y-6">
              <DeviceGrid
                devices={devices}
                alerts={alerts}
                selectedSerial={selectedSerial}
                onSelect={(serial) =>
                  setSelectedSerial(serial === selectedSerial ? null : serial)
                }
              />

              {selectedDevice && (
                <>
                  <DeviceDetail
                    device={selectedDevice}
                    health={detailHealth}
                    accounts={detailAccounts}
                    alerts={detailAlerts}
                    onClose={() => setSelectedSerial(null)}
                  />

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    <LiveScreen serial={selectedDevice.serial} />
                    <DeviceInfo serial={selectedDevice.serial} />
                  </div>

                  <ShellTerminal serial={selectedDevice.serial} />
                </>
              )}

              {alerts.length > 0 && <AlertPanel alerts={alerts} />}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
