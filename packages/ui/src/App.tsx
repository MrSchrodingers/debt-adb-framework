import { useEffect, useState, useCallback } from 'react'
import { io, type Socket } from 'socket.io-client'
import { CORE_URL } from './config'
import { DeviceGrid } from './components/device-grid'
import { DeviceDetail } from './components/device-detail'
import { AlertPanel } from './components/alert-panel'
import { MessageList } from './components/message-list'
import { SendForm } from './components/send-form'
import { SessionManager } from './components/session-manager'
import { MetricsDashboard } from './components/metrics-dashboard'
import { Sidebar } from './components/sidebar'
import type { DeviceRecord, HealthSnapshot, WhatsAppAccount, Alert } from './types'

type ActiveTab = 'dashboard' | 'sessions' | 'metricas'

export function App() {
  const [devices, setDevices] = useState<DeviceRecord[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [connected, setConnected] = useState(false)
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null)
  const [detailHealth, setDetailHealth] = useState<HealthSnapshot[]>([])
  const [detailAccounts, setDetailAccounts] = useState<WhatsAppAccount[]>([])
  const [detailAlerts, setDetailAlerts] = useState<Alert[]>([])
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard')
  const [sidebarOpen, setSidebarOpen] = useState(false)

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
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
      {/* Sidebar */}
      <Sidebar
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab)
          setSidebarOpen(false)
        }}
        connected={connected}
        deviceCount={devices.length}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
      />

      {/* Main content */}
      <main className="flex-1 min-w-0">
        {/* Mobile header */}
        <div className="lg:hidden flex items-center gap-3 p-4 border-b border-zinc-800">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-lg bg-zinc-800 border border-zinc-700/40 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <svg className="h-5 w-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 className="text-lg font-bold">Dispatch</h1>
          <div className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
        </div>

        <div className="p-4 lg:p-6 max-w-6xl mx-auto">
          {activeTab === 'sessions' && (
            <section>
              <h2 className="text-sm font-medium text-zinc-400 mb-3">Session Manager</h2>
              <SessionManager />
            </section>
          )}

          {activeTab === 'metricas' && (
            <section>
              <h2 className="text-sm font-medium text-zinc-400 mb-3">Metricas</h2>
              <MetricsDashboard />
            </section>
          )}

          {activeTab === 'dashboard' && (
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
                  <h2 className="text-sm font-medium text-zinc-400 mb-2">Enviar Mensagem</h2>
                  <SendForm onSend={handleSend} disabled={!hasOnlineDevice} />
                </section>

                <section>
                  <h2 className="text-sm font-medium text-zinc-400 mb-2">Fila de Mensagens</h2>
                  <MessageList />
                </section>
              </div>

              {/* Right column: alerts */}
              <div>
                <section>
                  <h2 className="text-sm font-medium text-zinc-400 mb-2">
                    Alertas ({alerts.length})
                  </h2>
                  <AlertPanel alerts={alerts} />
                </section>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
