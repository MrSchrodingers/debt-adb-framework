import { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts'
import { X, Camera, RotateCcw, RefreshCw, Battery, Thermometer, MemoryStick, HardDrive, Phone, Sun, Sparkles } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import type { Alert, DeviceRecord, HealthSnapshot, WhatsAppAccount } from '../types'

interface DeviceDetailProps {
  device: DeviceRecord
  health: HealthSnapshot[]
  accounts: WhatsAppAccount[]
  alerts: Alert[]
  onClose: () => void
}

export function DeviceDetail({ device, health, accounts, alerts, onClose }: DeviceDetailProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<string | null>(null)

  const latest = health[health.length - 1] ?? null
  const hasAlert = (type: string) => alerts.some((a) => a.type === type)

  const executeAction = async (action: string) => {
    setActionLoading(action)
    setConfirmAction(null)
    try {
      const url =
        action === 'reboot'
          ? `${CORE_URL}/api/v1/monitor/devices/${device.serial}/reboot`
          : `${CORE_URL}/api/v1/monitor/devices/${device.serial}/restart-whatsapp`
      const res = await fetch(url, { method: 'POST', headers: authHeaders() })
      if (!res.ok) {
        const err = await res.json()
        alert(err.error || 'Action failed')
      }
    } catch {
      alert('Failed to execute action')
    } finally {
      setActionLoading(null)
    }
  }

  const chartData = health.map((h) => ({
    time: new Date(h.collectedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    battery: h.batteryPercent,
    temp: h.temperatureCelsius,
    ram: h.ramAvailableMb,
  }))

  return (
    <div className="rounded-xl border border-blue-500/30 bg-zinc-900/80 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800/40 bg-blue-500/5">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-emerald-500/10 flex items-center justify-center">
            <Phone className="h-5 w-5 text-emerald-400" />
          </div>
          <div>
            <h3 className="font-medium text-zinc-100">
              {device.brand} {device.model}
            </h3>
            <p className="text-xs text-zinc-500 font-mono">{device.serial}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="p-5 space-y-5">
        {/* Health Metrics */}
        {latest && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <MetricCard icon={Battery} label="Bateria" value={`${latest.batteryPercent}%`} warn={hasAlert('battery_low') || hasAlert('battery_critical')} />
            <MetricCard icon={Thermometer} label="Temperatura" value={`${latest.temperatureCelsius.toFixed(1)}°C`} warn={hasAlert('temperature_high') || hasAlert('temperature_critical')} />
            <MetricCard icon={MemoryStick} label="RAM Livre" value={`${latest.ramAvailableMb}MB`} warn={hasAlert('ram_low')} />
            <MetricCard
              icon={HardDrive}
              label="Storage Livre"
              value={`${(latest.storageFreeBytes / 1_000_000_000).toFixed(1)}GB`}
              warn={hasAlert('storage_low')}
            />
          </div>
        )}

        {/* Spark Charts */}
        {chartData.length > 1 && (
          <div className="grid grid-cols-3 gap-3">
            <SparkChart data={chartData} dataKey="battery" label="Bateria %" color="#10b981" />
            <SparkChart data={chartData} dataKey="temp" label="Temp °C" color="#f59e0b" />
            <SparkChart data={chartData} dataKey="ram" label="RAM MB" color="#3b82f6" />
          </div>
        )}

        {/* WA Accounts */}
        {accounts.length > 0 && (
          <div>
            <h4 className="text-xs font-medium text-zinc-400 mb-2">Contas WhatsApp</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {accounts.map((acc) => (
                <div
                  key={`${acc.profileId}-${acc.packageName}`}
                  className="flex items-center gap-3 rounded-lg bg-zinc-800/60 border border-zinc-700/40 px-3 py-2"
                >
                  <div className="h-7 w-7 rounded-full bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-bold text-emerald-400">{acc.profileId}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-zinc-400">
                      {acc.packageName === 'com.whatsapp' ? 'WhatsApp' : 'WhatsApp Business'}
                    </p>
                    <p className="text-sm font-mono text-zinc-200 truncate">{acc.phoneNumber ?? 'N/A'}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/40 flex-wrap">
          <ActionBtn
            icon={Sparkles}
            label="Higienizar"
            loading={actionLoading === 'hygienize'}
            onClick={async () => {
              setActionLoading('hygienize')
              try {
                await fetch(`${CORE_URL}/api/v1/devices/${device.serial}/hygienize`, { method: 'POST', headers: authHeaders() })
              } finally {
                setActionLoading(null)
              }
            }}
          />
          <ActionBtn
            icon={Sun}
            label="Keep Awake"
            loading={actionLoading === 'keep-awake'}
            onClick={async () => {
              setActionLoading('keep-awake')
              try {
                await fetch(`${CORE_URL}/api/v1/devices/${device.serial}/keep-awake`, { method: 'POST', headers: authHeaders() })
              } finally {
                setActionLoading(null)
              }
            }}
          />
          <ActionBtn
            icon={Camera}
            label="Screenshot"
            loading={actionLoading === 'screenshot'}
            onClick={async () => {
              setActionLoading('screenshot')
              try {
                const res = await fetch(`${CORE_URL}/api/v1/devices/${device.serial}/screenshot`, { method: 'POST', headers: authHeaders() })
                if (res.ok) {
                  const blob = await res.blob()
                  window.open(URL.createObjectURL(blob))
                }
              } finally {
                setActionLoading(null)
              }
            }}
          />
          {confirmAction === 'reboot' ? (
            <ConfirmButtons
              onConfirm={() => executeAction('reboot')}
              onCancel={() => setConfirmAction(null)}
            />
          ) : (
            <ActionBtn icon={RotateCcw} label="Reboot" loading={actionLoading === 'reboot'} onClick={() => setConfirmAction('reboot')} danger />
          )}
          {confirmAction === 'restart-wa' ? (
            <ConfirmButtons
              onConfirm={() => executeAction('restart-wa')}
              onCancel={() => setConfirmAction(null)}
            />
          ) : (
            <ActionBtn icon={RefreshCw} label="Restart WA" loading={actionLoading === 'restart-wa'} onClick={() => setConfirmAction('restart-wa')} danger />
          )}
        </div>
      </div>
    </div>
  )
}

function MetricCard({ icon: Icon, label, value, warn }: { icon: typeof Battery; label: string; value: string; warn: boolean }) {
  return (
    <div className={`rounded-lg p-3 flex items-center gap-3 ${warn ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-zinc-800/60 border border-zinc-700/30'}`}>
      <Icon className={`h-4 w-4 flex-shrink-0 ${warn ? 'text-amber-400' : 'text-zinc-500'}`} />
      <div>
        <p className="text-xs text-zinc-500">{label}</p>
        <p className={`text-sm font-semibold ${warn ? 'text-amber-400' : 'text-zinc-200'}`}>{value}</p>
      </div>
    </div>
  )
}

function SparkChart({ data, dataKey, label, color }: { data: Record<string, unknown>[]; dataKey: string; label: string; color: string }) {
  return (
    <div className="rounded-lg bg-zinc-800/60 border border-zinc-700/30 p-3">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <ResponsiveContainer width="100%" height={50}>
        <LineChart data={data}>
          <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} dot={false} />
          <XAxis dataKey="time" hide />
          <YAxis hide />
          <Tooltip
            contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', fontSize: 11, borderRadius: 8 }}
            labelStyle={{ color: '#a1a1aa' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function ActionBtn({ icon: Icon, label, loading, onClick, danger }: { icon: typeof Camera; label: string; loading: boolean; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${
        danger
          ? 'bg-zinc-800 text-zinc-400 hover:bg-red-500/10 hover:text-red-400 border border-zinc-700/40'
          : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700/40'
      }`}
    >
      <Icon className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
      {loading ? '...' : label}
    </button>
  )
}

function ConfirmButtons({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="flex gap-1">
      <button onClick={onConfirm} className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-500">
        Confirmar
      </button>
      <button onClick={onCancel} className="rounded-lg bg-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-600">
        Cancelar
      </button>
    </div>
  )
}
