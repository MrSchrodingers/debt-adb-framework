import { useState, useEffect, useCallback } from 'react'
import { ShieldCheck } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

/**
 * Persistent banner shown across the whole app while an "Modo Higienização"
 * scan has paused production globally.
 *
 * Source of truth: GET /api/v1/admin/pause — when an active row exists with
 * scope='global' AND `paused_by` or `reason` references hygienization, we
 * surface a yellow banner so the operator sees the freeze regardless of
 * which tab they're on.
 */
interface PauseRecord {
  scope: string
  key: string
  reason: string
  paused_by: string
  paused_at: string
  resumed_at: string | null
}

const POLL_INTERVAL = 15_000 // 15s

function isHygienizationPause(p: PauseRecord): boolean {
  if (p.scope !== 'global') return false
  return /hygienization|higieniza/i.test(p.paused_by) || /hygienization|higieniza/i.test(p.reason)
}

export function HygienizationBanner() {
  const [pause, setPause] = useState<PauseRecord | null>(null)

  const fetchPause = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/pause`, { headers: authHeaders() })
      if (res.ok) {
        const data = (await res.json()) as PauseRecord[]
        const hyg = data.find(isHygienizationPause)
        setPause(hyg ?? null)
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    void fetchPause()
    const it = setInterval(fetchPause, POLL_INTERVAL)
    return () => clearInterval(it)
  }, [fetchPause])

  if (!pause) return null

  return (
    <div
      role="status"
      className="flex items-center gap-3 px-4 py-2.5 bg-amber-950/60 border-b border-amber-700/40 text-amber-200 text-sm"
    >
      <ShieldCheck className="h-4 w-4 text-amber-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-semibold text-amber-200">Modo Higienização ativo</span>
        <span className="ml-2 text-amber-300/80">
          Sender de produção pausado por <code className="text-amber-100">{pause.paused_by}</code>
        </span>
        <span className="ml-2 text-amber-400/60 text-xs">desde {new Date(pause.paused_at).toLocaleTimeString('pt-BR')}</span>
      </div>
    </div>
  )
}
