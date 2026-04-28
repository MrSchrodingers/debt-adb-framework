import { useState, useEffect, useCallback } from 'react'
import { CheckCircle, AlertTriangle as AlertTriangleIcon, Monitor } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'
import type { DeviceRecord, Alert } from '../types'
import { LiveScreenModal } from './live-screen-modal'

const statusColors: Record<string, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-zinc-500',
  unauthorized: 'bg-amber-500',
}

interface BulkActionResult {
  serial: string
  success: boolean
  error?: string
}

interface DeviceGridProps {
  devices: DeviceRecord[]
  alerts: Alert[]
  selectedSerial: string | null
  onSelect: (serial: string) => void
}

interface ValidationResult {
  serial: string
  ready: boolean
  profiles?: number
  issues: string[]
}

export function DeviceGrid({ devices, alerts, selectedSerial, onSelect }: DeviceGridProps) {
  const [checkedSerials, setCheckedSerials] = useState<Set<string>>(new Set())
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkResults, setBulkResults] = useState<BulkActionResult[] | null>(null)
  const [confirmReboot, setConfirmReboot] = useState(false)
  const [validations, setValidations] = useState<Record<string, ValidationResult>>({})
  // Task 7.3: live screen mirror modal
  const [mirrorSerial, setMirrorSerial] = useState<string | null>(null)

  useEffect(() => {
    const onlineDevices = devices.filter(d => d.status === 'online')
    if (onlineDevices.length === 0) return

    const controller = new AbortController()
    for (const device of onlineDevices) {
      fetch(`${CORE_URL}/api/v1/devices/${device.serial}/validate`, {
        headers: authHeaders(),
        signal: controller.signal,
      })
        .then(r => r.ok ? r.json() : null)
        .then((data: ValidationResult | null) => {
          if (data) {
            setValidations(prev => ({ ...prev, [device.serial]: data }))
          }
        })
        .catch(() => { /* aborted or network error */ })
    }

    return () => controller.abort()
  }, [devices])

  const toggleCheck = useCallback((serial: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setCheckedSerials(prev => {
      const next = new Set(prev)
      if (next.has(serial)) {
        next.delete(serial)
      } else {
        next.add(serial)
      }
      return next
    })
    setBulkResults(null)
  }, [])

  const executeBulkAction = useCallback(async (action: 'keep-awake' | 'screenshot' | 'reboot') => {
    if (checkedSerials.size === 0) return
    setBulkLoading(true)
    setBulkResults(null)
    setConfirmReboot(false)

    try {
      const res = await fetch(`${CORE_URL}/api/v1/devices/bulk-action`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          serials: [...checkedSerials],
          action,
        }),
      })

      if (res.ok) {
        const data = await res.json() as { results: BulkActionResult[] }
        setBulkResults(data.results)
      } else {
        const err = await res.json() as { error: string }
        setBulkResults([{ serial: 'all', success: false, error: err.error }])
      }
    } catch {
      setBulkResults([{ serial: 'all', success: false, error: 'Erro de rede' }])
    } finally {
      setBulkLoading(false)
    }
  }, [checkedSerials])

  const hasChecked = checkedSerials.size > 0

  if (devices.length === 0) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-6 text-center">
        <p className="text-zinc-500">No devices detected</p>
      </div>
    )
  }

  return (
    <div className="relative">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {devices.map((device) => {
          const deviceAlerts = alerts.filter((a) => a.deviceSerial === device.serial)
          const hasCritical = deviceAlerts.some((a) => a.severity === 'critical')
          const hasAlerts = deviceAlerts.length > 0
          const isSelected = selectedSerial === device.serial
          const isChecked = checkedSerials.has(device.serial)
          const validation = validations[device.serial]

          return (
            <button
              key={device.serial}
              onClick={() => onSelect(device.serial)}
              className={`relative rounded-lg border p-3 text-left transition-colors ${
                isSelected
                  ? 'border-blue-500 bg-zinc-800'
                  : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
              }`}
            >
              {/* Checkbox */}
              <div
                onClick={(e) => toggleCheck(device.serial, e)}
                className={`absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded border cursor-pointer transition-colors ${
                  isChecked
                    ? 'border-emerald-500 bg-emerald-500'
                    : 'border-zinc-600 bg-zinc-800 hover:border-zinc-400'
                }`}
              >
                {isChecked && (
                  <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>

              <div className="flex items-center gap-2 mb-1 pr-6">
                <div className={`h-2 w-2 rounded-full ${statusColors[device.status] ?? 'bg-zinc-500'}`} />
                <span className="text-xs font-medium truncate">
                  {device.brand ?? 'Unknown'} {device.model ?? ''}
                </span>
              </div>
              <p className="text-xs text-zinc-500 truncate font-mono">{device.serial.slice(0, 12)}</p>
              <div className="flex items-center gap-1 mt-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    device.status === 'online'
                      ? 'bg-emerald-500/10 text-emerald-400'
                      : device.status === 'unauthorized'
                        ? 'bg-amber-500/10 text-amber-400'
                        : 'bg-zinc-800 text-zinc-500'
                  }`}
                >
                  {device.status}
                </span>
                {hasAlerts && (
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      hasCritical ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'
                    }`}
                  >
                    {deviceAlerts.length} alert{deviceAlerts.length > 1 ? 's' : ''}
                  </span>
                )}
                {validation && (
                  <span
                    className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs ${
                      validation.ready
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'bg-red-500/10 text-red-400'
                    }`}
                    title={validation.ready ? 'Pronto para envio' : validation.issues.join(', ')}
                  >
                    {validation.ready
                      ? <CheckCircle className="h-3 w-3" />
                      : <AlertTriangleIcon className="h-3 w-3" />
                    }
                    {validation.profiles && (
                      <span>{validation.profiles}P</span>
                    )}
                  </span>
                )}
              </div>
              {/* Mirror button (Task 7.3) */}
              {device.status === 'online' && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setMirrorSerial(device.serial)
                  }}
                  className="mt-2 flex w-full items-center justify-center gap-1 rounded bg-zinc-800/60 border border-zinc-700/40 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
                  title="Abrir mirror da tela"
                >
                  <Monitor className="h-3 w-3" />
                  Mirror
                </button>
              )}
            </button>
          )
        })}
      </div>

      {/* Live Screen Mirror modal (Task 7.3) */}
      {mirrorSerial && (
        <LiveScreenModal
          serial={mirrorSerial}
          onClose={() => setMirrorSerial(null)}
        />
      )}

      {/* Bulk Action Bar */}
      {hasChecked && (
        <div className="sticky bottom-4 mt-4 flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 shadow-xl">
          <span className="text-xs text-zinc-400">
            {checkedSerials.size} dispositivo{checkedSerials.size > 1 ? 's' : ''} selecionado{checkedSerials.size > 1 ? 's' : ''}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => executeBulkAction('keep-awake')}
              disabled={bulkLoading}
              className="min-h-[44px] rounded bg-zinc-700 px-4 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-50 transition-colors"
            >
              {bulkLoading ? '...' : 'Manter Acordado'}
            </button>

            <button
              onClick={() => executeBulkAction('screenshot')}
              disabled={bulkLoading}
              className="min-h-[44px] rounded bg-zinc-700 px-4 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-50 transition-colors"
            >
              {bulkLoading ? '...' : 'Screenshot'}
            </button>

            {confirmReboot ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => executeBulkAction('reboot')}
                  disabled={bulkLoading}
                  className="min-h-[44px] rounded bg-red-600 px-4 py-2 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors"
                >
                  Confirmar Reboot
                </button>
                <button
                  onClick={() => setConfirmReboot(false)}
                  className="min-h-[44px] rounded bg-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-600 transition-colors"
                >
                  Cancelar
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmReboot(true)}
                disabled={bulkLoading}
                className="min-h-[44px] rounded bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-400 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50 transition-colors"
              >
                Reiniciar
              </button>
            )}

            <button
              onClick={() => {
                setCheckedSerials(new Set())
                setBulkResults(null)
                setConfirmReboot(false)
              }}
              className="min-h-[44px] rounded px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Limpar
            </button>
          </div>
        </div>
      )}

      {/* Bulk Results */}
      {bulkResults && bulkResults.length > 0 && (
        <div className="mt-3 space-y-1">
          {bulkResults.map((r) => (
            <div
              key={r.serial}
              className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs ${
                r.success ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
              }`}
            >
              <span className="font-mono">{r.serial.slice(0, 12)}</span>
              <span>{r.success ? 'OK' : r.error ?? 'Erro'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
