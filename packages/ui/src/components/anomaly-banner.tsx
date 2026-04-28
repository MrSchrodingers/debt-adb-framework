import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

interface AnomalyResult {
  active: boolean
  latency_30min_ms: number
  latency_24h_ms: number
  delta_pct: number
  started_at: string | null
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatRelative(iso: string | null): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'agora há pouco'
  if (diff < 3600_000) return `há ${Math.floor(diff / 60_000)} min`
  return `há ${Math.floor(diff / 3600_000)}h`
}

const POLL_INTERVAL = 60_000 // 60s

export function AnomalyBanner() {
  const [anomaly, setAnomaly] = useState<AnomalyResult | null>(null)
  const [dismissed, setDismissed] = useState(false)

  const fetchAnomaly = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/anomalies/current`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        const data = (await res.json()) as AnomalyResult
        setAnomaly(data)
        // Auto-reset dismiss when anomaly clears
        if (!data.active) setDismissed(false)
      }
    } catch {
      // silently fail
    }
  }, [])

  useEffect(() => {
    void fetchAnomaly()
    const interval = setInterval(fetchAnomaly, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchAnomaly])

  if (!anomaly?.active || dismissed) return null

  return (
    <div
      role="alert"
      className="flex items-start gap-3 px-4 py-3 bg-red-950/60 border border-red-700/40 text-red-200 text-sm"
    >
      <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <span className="font-semibold text-red-300">Anomalia de Latência Detectada</span>
        <span className="ml-2 text-red-300/70">
          Mediana 30min: {formatMs(anomaly.latency_30min_ms)} vs 24h: {formatMs(anomaly.latency_24h_ms)}
          {' '}({anomaly.delta_pct > 0 ? '+' : ''}{anomaly.delta_pct.toFixed(1)}%)
        </span>
        {anomaly.started_at && (
          <span className="ml-2 text-red-400/60 text-xs">
            Iniciou {formatRelative(anomaly.started_at)}
          </span>
        )}
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-red-400/60 hover:text-red-300 transition text-xs shrink-0"
        aria-label="Fechar alerta"
      >
        ✕
      </button>
    </div>
  )
}
