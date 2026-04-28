import { useState, useEffect, useRef, useCallback } from 'react'
import { Monitor, RefreshCw, X, Pause, Play } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

interface LiveScreenModalProps {
  serial: string
  onClose: () => void
}

/**
 * LiveScreenModal — 1Hz adaptive screen mirror for a device.
 *
 * Refresh strategy:
 * - Polls at 1Hz (1000ms) when modal is mounted and document is visible.
 * - Pauses automatically when `document.visibilityState !== 'visible'`
 *   (tab hidden, minimised window, etc.) — avoids wasting ADB screencaps.
 * - User can manually toggle auto-refresh on/off.
 */
export function LiveScreenModal({ serial, onClose }: LiveScreenModalProps) {
  const [image, setImage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchScreen = useCallback(async () => {
    if (loading) return
    setLoading(true)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/devices/${serial}/screen`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        const data = await res.json() as { image: string }
        setImage(data.image)
      }
    } catch {
      // Device may be offline — keep last image
    } finally {
      setLoading(false)
    }
  }, [serial, loading])

  // Initial fetch
  useEffect(() => {
    void fetchScreen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial])

  // Visibility-aware interval at 1Hz
  useEffect(() => {
    const startInterval = () => {
      if (timerRef.current) clearInterval(timerRef.current)
      timerRef.current = setInterval(() => {
        if (document.visibilityState === 'visible') {
          void fetchScreen()
        }
      }, 1000)
    }

    const stopInterval = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && autoRefresh) {
        startInterval()
      } else {
        stopInterval()
      }
    }

    if (autoRefresh) {
      startInterval()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stopInterval()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [autoRefresh, fetchScreen])

  // Dismiss on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Modal panel */}
      <div
        className="relative w-full max-w-lg mx-4 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-blue-400" />
            <span className="text-sm font-medium text-zinc-200">Mirror</span>
            <span className="text-xs font-mono text-zinc-500">{serial.slice(0, 12)}</span>
            {loading && <RefreshCw className="h-3 w-3 text-zinc-600 animate-spin" />}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh(p => !p)}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition ${
                autoRefresh
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  : 'bg-zinc-800 text-zinc-400 border border-zinc-700/40 hover:bg-zinc-700'
              }`}
            >
              {autoRefresh ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {autoRefresh ? '1Hz' : 'Pausado'}
            </button>
            <button
              onClick={() => void fetchScreen()}
              disabled={loading}
              className="rounded bg-zinc-800 border border-zinc-700/40 p-1.5 text-zinc-400 hover:bg-zinc-700 disabled:opacity-50 transition"
              title="Atualizar agora"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="rounded bg-zinc-800 border border-zinc-700/40 p-1.5 text-zinc-400 hover:bg-zinc-700 transition"
              title="Fechar (Esc)"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Screen content */}
        <div className="flex justify-center p-4 bg-black/20 min-h-[200px]">
          {image ? (
            <img
              src={image}
              alt={`Tela ao vivo do device ${serial}`}
              className="max-w-full max-h-[60vh] rounded-lg shadow-lg border border-zinc-700/30"
              style={{ imageRendering: 'auto' }}
            />
          ) : (
            <div className="flex items-center justify-center h-48 text-zinc-600 text-sm">
              {loading ? 'Capturando tela...' : 'Tela indisponivel'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
