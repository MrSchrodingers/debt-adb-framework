import { useState, useEffect, useCallback, useRef } from 'react'
import { Monitor, RefreshCw, Pause, Play, Maximize2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CORE_URL, authHeaders } from '../config'

interface Device {
  serial: string
  brand?: string
  model?: string
  status: 'online' | 'offline' | 'unknown'
}

/**
 * DevicesGridMirror — operator-facing tile view of every connected device.
 *
 * Each tile polls /api/v1/devices/:serial/screen at 1 Hz when the tab is
 * visible and refresh is enabled. Click a tile to expand it. The grid is
 * intended for the dashboard so the operator sees ALL devices simultaneously
 * (replacing N scrcpy windows).
 *
 * - Auto-pause when document is hidden (visibilitychange listener).
 * - Per-tile manual pause/resume button.
 * - Click-to-expand fullscreen overlay.
 * - Last-update timestamp + offline indicator on stale tiles.
 */
export function DevicesGridMirror() {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<Device[]>([])
  const [globalRefresh, setGlobalRefresh] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetch device list once and refresh every 30s in the background
  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/devices`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { devices?: Device[] } | Device[]
      const list = Array.isArray(data) ? data : (data.devices ?? [])
      setDevices(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar devices')
    }
  }, [])

  useEffect(() => {
    void fetchDevices()
    const id = setInterval(fetchDevices, 30_000)
    return () => clearInterval(id)
  }, [fetchDevices])

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
        <div className="flex items-center gap-2">
          <Monitor className="h-5 w-5 text-zinc-400" />
          <h2 className="text-base font-semibold text-zinc-100">{t('mirror.title')}</h2>
          <span className="text-xs text-zinc-500">({devices.length})</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setGlobalRefresh(v => !v)}
            className="flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            {globalRefresh ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {globalRefresh ? t('mirror.pauseAll') : t('mirror.resumeAll')}
          </button>
          <button
            onClick={fetchDevices}
            className="flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            <RefreshCw className="h-3 w-3" />
            {t('mirror.refresh')}
          </button>
        </div>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {devices.length === 0 && !error && (
        <p className="text-xs text-zinc-500 italic">{t('mirror.noDevices')}</p>
      )}

      {/* Tile grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {devices.map(d => (
          <DeviceTile
            key={d.serial}
            device={d}
            globalEnabled={globalRefresh}
            onExpand={() => setExpanded(d.serial)}
          />
        ))}
      </div>

      {/* Expanded overlay */}
      {expanded && (
        <ExpandedTile
          serial={expanded}
          onClose={() => setExpanded(null)}
        />
      )}
    </div>
  )
}

// ── Per-device tile ────────────────────────────────────────────────────────

interface DeviceTileProps {
  device: Device
  globalEnabled: boolean
  onExpand: () => void
}

function DeviceTile({ device, globalEnabled, onExpand }: DeviceTileProps) {
  const { t } = useTranslation()
  const [image, setImage] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  const [tileEnabled, setTileEnabled] = useState(true)
  const [tabVisible, setTabVisible] = useState(true)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fetchingRef = useRef(false)

  const fetchScreen = useCallback(async () => {
    if (fetchingRef.current || device.status !== 'online') return
    fetchingRef.current = true
    setLoading(true)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/devices/${device.serial}/screen`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        const data = (await res.json()) as { image: string }
        setImage(data.image)
        setLastUpdate(new Date())
      }
    } catch {
      // Device may have just gone offline; keep the last frame
    } finally {
      fetchingRef.current = false
      setLoading(false)
    }
  }, [device.serial, device.status])

  // Visibility tracking — auto-pause when tab hidden
  useEffect(() => {
    const onVis = () => setTabVisible(document.visibilityState === 'visible')
    setTabVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Refresh loop
  useEffect(() => {
    const active = globalEnabled && tileEnabled && tabVisible && device.status === 'online'
    if (!active) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      return
    }
    void fetchScreen()
    timerRef.current = setInterval(() => { void fetchScreen() }, 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [globalEnabled, tileEnabled, tabVisible, device.status, fetchScreen])

  const stale = lastUpdate ? (Date.now() - lastUpdate.getTime() > 5000) : false

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-zinc-800">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`h-2 w-2 rounded-full shrink-0 ${
            device.status === 'online' ? 'bg-emerald-400' : 'bg-zinc-500'
          }`} />
          <span className="text-xs font-mono text-zinc-300 truncate" title={device.serial}>
            {device.serial.slice(-8)}
          </span>
          {device.model && (
            <span className="text-[10px] text-zinc-500 truncate">{device.model}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setTileEnabled(v => !v)}
            className="text-zinc-500 hover:text-zinc-300 transition"
            title={tileEnabled ? t('mirror.pauseTile') : t('mirror.resumeTile')}
          >
            {tileEnabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </button>
          <button
            onClick={onExpand}
            className="text-zinc-500 hover:text-zinc-300 transition"
            title={t('mirror.expand')}
          >
            <Maximize2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div className="relative aspect-[9/16] bg-zinc-950 flex items-center justify-center">
        {device.status !== 'online' ? (
          <div className="flex flex-col items-center gap-1 text-zinc-600">
            <Monitor className="h-6 w-6" />
            <span className="text-[10px]">{t('mirror.offline')}</span>
          </div>
        ) : image ? (
          <img
            src={image}
            alt={`${device.serial} screen`}
            className={`w-full h-full object-contain ${stale ? 'opacity-50' : ''}`}
          />
        ) : (
          <div className="flex flex-col items-center gap-1 text-zinc-600">
            <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
            <span className="text-[10px]">{t('mirror.loading')}</span>
          </div>
        )}
        {loading && image && (
          <div className="absolute top-1 right-1">
            <RefreshCw className="h-3 w-3 text-emerald-400/70 animate-spin" />
          </div>
        )}
        {lastUpdate && (
          <div className={`absolute bottom-1 left-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-mono ${
            stale ? 'text-amber-300' : 'text-emerald-300'
          }`}>
            {lastUpdate.toLocaleTimeString('pt-BR')}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Expanded fullscreen view ───────────────────────────────────────────────

function ExpandedTile({ serial, onClose }: { serial: string; onClose: () => void }) {
  const [image, setImage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetch_ = async () => {
      try {
        const res = await fetch(`${CORE_URL}/api/v1/devices/${serial}/screen`, {
          headers: authHeaders(),
        })
        if (res.ok && !cancelled) {
          const data = (await res.json()) as { image: string }
          setImage(data.image)
        }
      } catch { /* ignore */ }
    }
    void fetch_()
    const id = setInterval(fetch_, 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [serial])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="relative max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
        <button
          onClick={onClose}
          className="absolute -top-10 right-0 text-white/60 hover:text-white transition"
        >
          <X className="h-6 w-6" />
        </button>
        {image ? (
          <img
            src={image}
            alt={`${serial} screen`}
            className="w-full rounded-xl border border-zinc-700/40 shadow-2xl"
          />
        ) : (
          <div className="w-full aspect-[9/16] flex items-center justify-center text-zinc-600 bg-zinc-900 rounded-xl">
            <RefreshCw className="h-6 w-6 animate-spin" />
          </div>
        )}
        <p className="text-center text-xs text-white/40 mt-2 font-mono">{serial}</p>
      </div>
    </div>
  )
}
