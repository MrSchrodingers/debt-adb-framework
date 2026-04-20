import { useState, useEffect, useRef } from 'react'
import { Monitor, Play, Pause, RefreshCw } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

interface LiveScreenProps {
  serial: string
  profileId?: number | null
}

export function LiveScreen({ serial, profileId }: LiveScreenProps) {
  const [image, setImage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [interval, setIntervalMs] = useState(3000)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchScreen = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/devices/${serial}/screen`, { headers: authHeaders() })
      if (res.ok) {
        const data = await res.json()
        setImage(data.image)
      }
    } catch {
      // Device may be offline
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchScreen()
  }, [serial])

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(fetchScreen, interval)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [autoRefresh, interval, serial])

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-blue-400" />
          <h3 className="text-sm font-medium text-zinc-300">Tela ao Vivo</h3>
          {loading && <RefreshCw className="h-3 w-3 text-zinc-600 animate-spin" />}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={interval}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-400"
          >
            <option value={1000}>1s</option>
            <option value={3000}>3s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
          </select>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
              autoRefresh
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                : 'bg-zinc-800 text-zinc-400 border border-zinc-700/40 hover:bg-zinc-700'
            }`}
          >
            {autoRefresh ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            {autoRefresh ? 'Pausar' : 'Auto'}
          </button>
          <button
            onClick={fetchScreen}
            disabled={loading}
            className="rounded-lg bg-zinc-800 border border-zinc-700/40 px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="p-4 flex justify-center">
        {image ? (
          <img
            src={image}
            alt="Device screen"
            className="max-h-[500px] rounded-lg shadow-lg border border-zinc-700/30"
            style={{ imageRendering: 'auto' }}
          />
        ) : (
          <div className="h-64 flex items-center justify-center text-zinc-600 text-sm">
            Carregando tela...
          </div>
        )}
      </div>
    </div>
  )
}
