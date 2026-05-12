import { useEffect, useState } from 'react'
import { CORE_URL, authHeaders } from '../config'

interface QualityComponents {
  ackRate: number
  banHistory: number
  age: number
  warmupCompletion: number
  volumeFit: number
  fingerprintFreshness: number
  recipientResponse: number
}

interface ComponentsResponse {
  live: {
    total: number
    components: QualityComponents
  }
}

const COMPONENT_LABELS: Array<[keyof QualityComponents, string]> = [
  ['ackRate', 'Ack rate'],
  ['banHistory', 'Histórico ban'],
  ['age', 'Idade conta'],
  ['warmupCompletion', 'Warmup'],
  ['volumeFit', 'Volume fit'],
  ['fingerprintFreshness', 'Fingerprint'],
  ['recipientResponse', 'Resposta'],
]

function badgeClass(score: number): string {
  if (score >= 70) return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
  if (score >= 40) return 'bg-amber-500/15 text-amber-300 border-amber-500/30'
  return 'bg-red-500/15 text-red-300 border-red-500/30'
}

/**
 * Compact quality score chip — fetches /quality/components/:phone and renders
 * a single colored badge. Click to expand the 7-component breakdown inline.
 * Intended for embedding inside SenderCard so operators see score without
 * leaving the Senders tab.
 */
export function QualityInline({ phone }: { phone: string }) {
  const [data, setData] = useState<ComponentsResponse | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`${CORE_URL}/api/v1/quality/components/${encodeURIComponent(phone)}`, {
          headers: authHeaders(),
        })
        if (!cancelled && res.ok) {
          setData(await res.json())
        }
      } catch {
        /* swallow — chip just hides */
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const t = setInterval(load, 60_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [phone])

  if (loading || !data) return null
  const score = data.live.total

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors hover:opacity-80 ${badgeClass(score)}`}
        title="Clique para ver componentes do quality score"
      >
        Quality: {score}
        <span className="opacity-60">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded bg-zinc-900/60 border border-zinc-800 p-2 text-[11px]">
          {COMPONENT_LABELS.map(([key, label]) => {
            const v = data.live.components[key] ?? 0
            const pct = Math.round(v * 100)
            return (
              <div key={key} className="flex items-center justify-between gap-2 text-zinc-400">
                <span>{label}</span>
                <div className="flex items-center gap-1">
                  <div className="h-1 w-12 overflow-hidden rounded bg-zinc-800">
                    <div
                      className={`h-full ${pct >= 70 ? 'bg-emerald-500/70' : pct >= 40 ? 'bg-amber-500/70' : 'bg-red-500/70'}`}
                      style={{ width: pct + '%' }}
                    />
                  </div>
                  <span className="tabular-nums text-zinc-300 w-8 text-right">{pct}%</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
