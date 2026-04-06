import { useState } from 'react'
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts'
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
      const res = await fetch(url, { method: 'POST' })
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
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-medium">
            {device.brand} {device.model}
          </h3>
          <p className="text-xs text-zinc-500 font-mono">{device.serial}</p>
        </div>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-sm">
          Close
        </button>
      </div>

      {/* Health Metrics */}
      {latest && (
        <div className="grid grid-cols-4 gap-3 mb-4">
          <MetricCard label="Battery" value={`${latest.batteryPercent}%`} warn={hasAlert('battery_low') || hasAlert('battery_critical')} />
          <MetricCard label="Temp" value={`${latest.temperatureCelsius.toFixed(1)}C`} warn={hasAlert('temperature_high') || hasAlert('temperature_critical')} />
          <MetricCard label="RAM" value={`${latest.ramAvailableMb}MB`} warn={hasAlert('ram_low')} />
          <MetricCard
            label="Storage"
            value={`${Math.round(latest.storageFreeBytes / 1_000_000)}MB`}
            warn={hasAlert('storage_low')}
          />
        </div>
      )}

      {/* Spark Charts */}
      {chartData.length > 1 && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <SparkChart data={chartData} dataKey="battery" label="Battery %" color="#10b981" />
          <SparkChart data={chartData} dataKey="temp" label="Temp C" color="#f59e0b" />
          <SparkChart data={chartData} dataKey="ram" label="RAM MB" color="#3b82f6" />
        </div>
      )}

      {/* WA Accounts */}
      {accounts.length > 0 && (
        <div className="mb-4">
          <h4 className="text-xs font-medium text-zinc-400 mb-2">WhatsApp Accounts</h4>
          <div className="space-y-1">
            {accounts.map((acc) => (
              <div
                key={`${acc.profileId}-${acc.packageName}`}
                className="flex items-center gap-2 text-xs rounded bg-zinc-800 px-2 py-1"
              >
                <span className="text-zinc-400">User {acc.profileId}</span>
                <span className="text-zinc-500">{acc.packageName === 'com.whatsapp' ? 'WA' : 'WABA'}</span>
                <span className="ml-auto font-mono text-zinc-300">{acc.phoneNumber ?? 'unknown'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active Alerts */}
      {alerts.length > 0 && (
        <div className="mb-4">
          <h4 className="text-xs font-medium text-zinc-400 mb-2">Active Alerts</h4>
          <div className="space-y-1">
            {alerts.map((a) => (
              <div key={a.id} className={`text-xs rounded px-2 py-1 ${severityBg(a.severity)}`}>
                <span className={severityText(a.severity)}>{a.severity}</span>
                <span className="ml-2 text-zinc-300">{a.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <ActionButton
          label="Screenshot"
          loading={actionLoading === 'screenshot'}
          onClick={async () => {
            setActionLoading('screenshot')
            try {
              const res = await fetch(`${CORE_URL}/api/v1/devices/${device.serial}/screenshot`, {
                method: 'POST',
                headers: authHeaders(),
              })
              if (res.ok) {
                const blob = await res.blob()
                window.open(URL.createObjectURL(blob))
              }
            } finally {
              setActionLoading(null)
            }
          }}
        />
        <ConfirmableAction
          action="reboot"
          label="Reboot"
          confirmAction={confirmAction}
          actionLoading={actionLoading}
          onConfirm={executeAction}
          onRequestConfirm={setConfirmAction}
          onCancel={() => setConfirmAction(null)}
        />
        <ConfirmableAction
          action="restart-wa"
          label="Restart WA"
          confirmAction={confirmAction}
          actionLoading={actionLoading}
          onConfirm={executeAction}
          onRequestConfirm={setConfirmAction}
          onCancel={() => setConfirmAction(null)}
        />
      </div>
    </div>
  )
}

function MetricCard({ label, value, warn }: { label: string; value: string; warn: boolean }) {
  return (
    <div className={`rounded p-2 text-center ${warn ? 'bg-amber-500/10' : 'bg-zinc-800'}`}>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`text-sm font-medium ${warn ? 'text-amber-400' : 'text-zinc-200'}`}>{value}</p>
    </div>
  )
}

function SparkChart({
  data,
  dataKey,
  label,
  color,
}: {
  data: Record<string, unknown>[]
  dataKey: string
  label: string
  color: string
}) {
  return (
    <div className="rounded bg-zinc-800 p-2">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <ResponsiveContainer width="100%" height={60}>
        <LineChart data={data}>
          <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} dot={false} />
          <XAxis dataKey="time" hide />
          <YAxis hide />
          <Tooltip
            contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', fontSize: 11 }}
            labelStyle={{ color: '#a1a1aa' }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function ActionButton({
  label,
  loading,
  onClick,
}: {
  label: string
  loading: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
    >
      {loading ? '...' : label}
    </button>
  )
}

function ConfirmableAction({
  action,
  label,
  confirmAction,
  actionLoading,
  onConfirm,
  onRequestConfirm,
  onCancel,
}: {
  action: string
  label: string
  confirmAction: string | null
  actionLoading: string | null
  onConfirm: (action: string) => void
  onRequestConfirm: (action: string) => void
  onCancel: () => void
}) {
  if (confirmAction === action) {
    return (
      <div className="flex gap-1">
        <button
          onClick={() => onConfirm(action)}
          className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-500"
        >
          Confirmar
        </button>
        <button
          onClick={onCancel}
          className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-600"
        >
          Cancelar
        </button>
      </div>
    )
  }
  return (
    <ActionButton
      label={label}
      loading={actionLoading === action}
      onClick={() => onRequestConfirm(action)}
    />
  )
}

function severityBg(s: Alert['severity']) {
  if (s === 'critical') return 'bg-red-500/10'
  if (s === 'high') return 'bg-amber-500/10'
  return 'bg-zinc-800'
}

function severityText(s: Alert['severity']) {
  if (s === 'critical') return 'text-red-400 font-medium'
  if (s === 'high') return 'text-amber-400 font-medium'
  return 'text-zinc-400'
}
