import { useCallback, useEffect, useState } from 'react'
import { PauseCircle, PlayCircle, AlertOctagon } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

interface PauseRow {
  scope: string
  key: string
  reason: string
  by: string
  paused_at: string
}

const REASONS = [
  'Manutenção operacional',
  'Investigando ban / quarentena em cadeia',
  'Pico de erro inesperado',
  'Outro (descrever)',
] as const

/**
 * Sticky global-pause control bar (NEW-7, Sprint 3 v2 roadmap).
 *
 * Visible across all tabs above StatsBar. Polls /api/v1/admin/pause every
 * 10s and surfaces whether the "global:*" pause row is active. Operator can
 * trigger pause-all with a reason picker (drop-down) — under the hood
 * POSTs scope=global, key=* to the existing pause API. Resume button when
 * active. Auto-clears local state after action.
 */
export function GlobalThrottleBar() {
  const [globalPause, setGlobalPause] = useState<PauseRow | null>(null)
  const [opening, setOpening] = useState(false)
  const [reason, setReason] = useState<string>(REASONS[0])
  const [customReason, setCustomReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/pause`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const rows = (await res.json()) as PauseRow[]
      const g = rows.find((r) => r.scope === 'global' && r.key === '*') ?? null
      setGlobalPause(g)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [refresh])

  const pauseAll = useCallback(async () => {
    const finalReason = reason === REASONS[3] ? (customReason.trim() || 'manual pause') : reason
    setPending(true)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/pause`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ scope: 'global', reason: finalReason, by: 'operator-ui' }),
      })
      if (!res.ok) {
        const body = await res.text()
        setError(`pause-all falhou: ${res.status} ${body.slice(0, 200)}`)
      } else {
        await refresh()
        setOpening(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }, [reason, customReason, refresh])

  const resumeAll = useCallback(async () => {
    setPending(true)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/pause/resume`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ scope: 'global', by: 'operator-ui' }),
      })
      if (!res.ok) {
        const body = await res.text()
        setError(`resume falhou: ${res.status} ${body.slice(0, 200)}`)
      } else {
        await refresh()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }, [refresh])

  return (
    <div className="px-4 lg:px-6 pt-3">
      {error && (
        <div className="mb-2 rounded bg-red-500/10 text-red-300 border border-red-500/20 px-3 py-1 text-xs">
          {error}
        </div>
      )}
      {globalPause ? (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 text-red-200 px-3 py-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm">
            <AlertOctagon className="h-4 w-4 text-red-400" />
            <span>
              <span className="font-semibold">Dispatch pausado globalmente</span>
              <span className="mx-2 text-red-300/70">·</span>
              <span className="text-xs">motivo: {globalPause.reason}</span>
              <span className="mx-2 text-red-300/70">·</span>
              <span className="text-xs">por: {globalPause.by}</span>
            </span>
          </div>
          <button
            disabled={pending}
            onClick={resumeAll}
            className="text-xs bg-emerald-500/15 text-emerald-200 border border-emerald-500/30 rounded px-2 py-1 hover:bg-emerald-500/25 transition-colors disabled:opacity-50 inline-flex items-center gap-1"
          >
            <PlayCircle className="h-3.5 w-3.5" />
            Retomar
          </button>
        </div>
      ) : opening ? (
        <div className="rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 space-y-2">
          <div className="text-xs text-zinc-300 font-medium">Pausar Dispatch globalmente — motivo:</div>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 px-2 py-1"
          >
            {REASONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          {reason === REASONS[3] && (
            <input
              type="text"
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
              placeholder="Descreva o motivo"
              className="w-full rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 px-2 py-1"
            />
          )}
          <div className="flex gap-2">
            <button
              disabled={pending}
              onClick={pauseAll}
              className="text-xs bg-red-500/15 text-red-200 border border-red-500/30 rounded px-3 py-1 hover:bg-red-500/25 transition-colors disabled:opacity-50 inline-flex items-center gap-1"
            >
              <PauseCircle className="h-3.5 w-3.5" />
              Confirmar Pause All
            </button>
            <button
              disabled={pending}
              onClick={() => setOpening(false)}
              className="text-xs bg-zinc-800 text-zinc-400 border border-zinc-700 rounded px-3 py-1 hover:bg-zinc-700/60 transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            onClick={() => setOpening(true)}
            className="text-[11px] bg-zinc-900/60 text-zinc-400 border border-zinc-800 rounded px-2 py-1 hover:bg-zinc-800 hover:text-zinc-200 transition-colors inline-flex items-center gap-1"
            title="Pausa global todos os senders + plugins via POST /api/v1/admin/pause scope=global"
          >
            <PauseCircle className="h-3 w-3" />
            Pause All
          </button>
        </div>
      )}
    </div>
  )
}
