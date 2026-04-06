import { useEffect, useState, useCallback, useRef } from 'react'
import { io, type Socket } from 'socket.io-client'
import { CORE_URL, authHeaders } from './config'
import { DeviceGrid } from './components/device-grid'
import { DeviceDetail } from './components/device-detail'
import { AlertPanel } from './components/alert-panel'
import { MessageList } from './components/message-list'
import { SendForm } from './components/send-form'
import { SessionManager } from './components/session-manager'
import { MetricsDashboard } from './components/metrics-dashboard'
import { StatsBar } from './components/stats-bar'
import { Sidebar } from './components/sidebar'
import { LiveScreen } from './components/live-screen'
import { ShellTerminal } from './components/shell-terminal'
import { DeviceInfo } from './components/device-info'
import { ToastContainer, type Toast } from './components/toast'
import { AuditLog } from './components/audit-log'
import { DeviceProfileSelector, type DeviceProfileSelection } from './components/device-profile-selector'
import type { DeviceRecord, HealthSnapshot, WhatsAppAccount, Alert } from './types'

type Tab = 'devices' | 'queue' | 'sessions' | 'metricas' | 'auditoria'

export function App() {
  const [devices, setDevices] = useState<DeviceRecord[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [connected, setConnected] = useState(false)
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null)
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null)
  const [detailHealth, setDetailHealth] = useState<HealthSnapshot[]>([])
  const [detailAccounts, setDetailAccounts] = useState<WhatsAppAccount[]>([])
  const [detailAlerts, setDetailAlerts] = useState<Alert[]>([])
  const [activeTab, setActiveTab] = useState<Tab>('devices')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dpSelection, setDpSelection] = useState<DeviceProfileSelection>({
    serial: null,
    profileId: null,
    senderNumber: null,
  })

  const addToast = useCallback((type: Toast['type'], message: string) => {
    const toast: Toast = {
      id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      message,
      timestamp: Date.now(),
    }
    setToasts((prev) => {
      const next = [...prev, toast]
      return next.length > 10 ? next.slice(-10) : next
    })
  }, [])

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const fetchDevices = useCallback(() => {
    fetch(`${CORE_URL}/api/v1/monitor/devices`, { headers: authHeaders() })
      .then((r) => r.json())
      .then(setDevices)
      .catch(() => {})
  }, [])

  const fetchAlerts = useCallback(() => {
    fetch(`${CORE_URL}/api/v1/monitor/alerts`, { headers: authHeaders() })
      .then((r) => r.json())
      .then(setAlerts)
      .catch(() => {})
  }, [])

  const fetchDetail = useCallback((serial: string) => {
    fetch(`${CORE_URL}/api/v1/monitor/devices/${serial}`, { headers: authHeaders() })
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
  }, [fetchDevices, fetchAlerts])

  useEffect(() => {
    if (selectedSerial) fetchDetail(selectedSerial)
  }, [selectedSerial, fetchDetail])

  const selectedSerialRef = useRef(selectedSerial)
  selectedSerialRef.current = selectedSerial

  useEffect(() => {
    const socket: Socket = io(CORE_URL)

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on('message:sent', (data: { id: string; to?: string }) => {
      addToast('success', `Mensagem enviada para ${data.to ?? data.id}`)
    })

    socket.on('message:failed', (data: { id: string; to?: string; error?: string }) => {
      addToast('error', `Falha ao enviar para ${data.to ?? data.id}${data.error ? `: ${data.error}` : ''}`)
    })

    socket.on('device:connected', () => fetchDevices())
    socket.on('device:disconnected', () => {
      fetchDevices()
      fetchAlerts()
    })

    socket.on('device:health', (data: { serial: string }) => {
      if (data.serial === selectedSerialRef.current) fetchDetail(data.serial)
    })

    socket.on('alert:new', (data: { message?: string }) => {
      fetchAlerts()
      if (selectedSerialRef.current) fetchDetail(selectedSerialRef.current)
      addToast('warning', `Alerta: ${data.message ?? 'novo alerta detectado'}`)
    })

    return () => { socket.disconnect() }
  }, [fetchDevices, fetchAlerts, fetchDetail, addToast])

  const handleSend = useCallback(async (to: string, body: string, contactName?: string) => {
    const idempotencyKey = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const res = await fetch(`${CORE_URL}/api/v1/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
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
  const activeAlertCount = alerts.filter((a) => !a.resolved).length

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex">
      <Sidebar
        activeTab={activeTab}
        onTabChange={(tab: Tab) => {
          setActiveTab(tab)
          setSidebarOpen(false)
        }}
        connected={connected}
        deviceCount={devices.length}
        mobileOpen={sidebarOpen}
        onMobileClose={() => setSidebarOpen(false)}
        alertCount={activeAlertCount}
      />

      <div className="flex-1 flex flex-col min-h-screen overflow-hidden">
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

        {/* Desktop header */}
        <header className="hidden lg:flex items-center justify-between px-6 py-4 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-10">
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
          alertCount={activeAlertCount}
        />

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          {activeTab === 'sessions' ? (
            <SessionManager />
          ) : activeTab === 'auditoria' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <DeviceProfileSelector
                  devices={devices}
                  selection={dpSelection}
                  onSelect={setDpSelection}
                />
              </div>
              <AuditLog deviceSerial={dpSelection.serial} />
            </div>
          ) : activeTab === 'metricas' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <DeviceProfileSelector
                  devices={devices}
                  selection={dpSelection}
                  onSelect={setDpSelection}
                />
              </div>
              <MetricsDashboard senderNumber={dpSelection.senderNumber} />
            </div>
          ) : activeTab === 'queue' ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <DeviceProfileSelector
                  devices={devices}
                  selection={dpSelection}
                  onSelect={setDpSelection}
                />
              </div>
              <SendForm onSend={handleSend} disabled={!hasOnlineDevice} />
              <MessageList senderNumber={dpSelection.senderNumber} />
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
                    onClose={() => { setSelectedSerial(null); setSelectedProfileId(null) }}
                    activeProfileId={selectedProfileId}
                    onProfileSelect={setSelectedProfileId}
                  />

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                    <LiveScreen serial={selectedDevice.serial} profileId={selectedProfileId} />
                    <DeviceInfo serial={selectedDevice.serial} profileId={selectedProfileId} />
                  </div>

                  <ShellTerminal serial={selectedDevice.serial} profileId={selectedProfileId} />
                </>
              )}

              {alerts.length > 0 && <AlertPanel alerts={alerts} />}
            </div>
          )}
        </main>
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
