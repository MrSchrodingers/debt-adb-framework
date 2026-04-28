import { useState, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronUp, Smartphone, Key, Radio, Puzzle, XCircle } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

type ChangedCategory = 'device_added' | 'device_removed' | 'key_rotation' | 'session_died' | 'plugin_boot'

interface ChangedItem {
  category: ChangedCategory
  description: string
  occurred_at: string
}

interface Changed24hResponse {
  counts: Record<ChangedCategory, number>
  items: ChangedItem[]
}

const CATEGORY_META: Record<ChangedCategory, { label: string; Icon: typeof Smartphone; color: string }> = {
  device_added:   { label: 'Dispositivos adicionados', Icon: Smartphone, color: 'text-emerald-400' },
  device_removed: { label: 'Dispositivos removidos',   Icon: XCircle,    color: 'text-red-400' },
  key_rotation:   { label: 'Rotações de chave API',    Icon: Key,        color: 'text-amber-400' },
  session_died:   { label: 'Sessões encerradas',       Icon: Radio,      color: 'text-orange-400' },
  plugin_boot:    { label: 'Boots de plugin',          Icon: Puzzle,     color: 'text-sky-400' },
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'agora há pouco'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}min atrás`
  return `${Math.floor(diff / 3600_000)}h atrás`
}

export function Changed24hCard() {
  const [data, setData] = useState<Changed24hResponse | null>(null)
  const [expanded, setExpanded] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/insights/changed-24h`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        setData((await res.json()) as Changed24hResponse)
      }
    } catch {
      // silently fail
    }
  }, [])

  useEffect(() => {
    void fetchData()
    const interval = setInterval(fetchData, 60_000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (!data) return null

  const totalChanges = Object.values(data.counts).reduce((a, b) => a + b, 0)

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded((p) => !p)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800/30 transition rounded-lg"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-zinc-300">O que mudou nas últimas 24h</span>
          {totalChanges > 0 && (
            <span className="rounded-full bg-zinc-700 px-1.5 py-0.5 text-xs text-zinc-300">
              {totalChanges}
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-zinc-500" />
        ) : (
          <ChevronDown className="h-4 w-4 text-zinc-500" />
        )}
      </button>

      {/* Count badges — always visible when there are changes */}
      {totalChanges > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-3">
          {(Object.entries(CATEGORY_META) as [ChangedCategory, typeof CATEGORY_META[ChangedCategory]][]).map(
            ([cat, meta]) => {
              const count = data.counts[cat] ?? 0
              if (count === 0) return null
              const { Icon, color, label } = meta
              return (
                <div
                  key={cat}
                  className="flex items-center gap-1.5 rounded-full bg-zinc-800 border border-zinc-700/40 px-2 py-0.5"
                  title={label}
                >
                  <Icon className={`h-3 w-3 ${color}`} />
                  <span className={`text-xs font-medium ${color}`}>{count}</span>
                  <span className="text-xs text-zinc-500">{label}</span>
                </div>
              )
            },
          )}
        </div>
      )}

      {/* Expanded item list */}
      {expanded && (
        <div className="px-4 pb-4 space-y-2">
          {data.items.length === 0 ? (
            <p className="text-xs text-zinc-500">Nenhuma alteração registrada.</p>
          ) : (
            data.items.map((item, i) => {
              const meta = CATEGORY_META[item.category]
              const Icon = meta.Icon
              return (
                <div
                  key={i}
                  className="flex items-start gap-2.5 rounded-md bg-zinc-800/40 px-3 py-2"
                >
                  <Icon className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${meta.color}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-zinc-300 truncate" title={item.description}>
                      {item.description}
                    </p>
                  </div>
                  <span className="text-xs text-zinc-600 shrink-0 whitespace-nowrap">
                    {formatRelative(item.occurred_at)}
                  </span>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
