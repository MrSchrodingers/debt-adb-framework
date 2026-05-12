import { useEffect, useState, useCallback } from 'react'
import { CORE_URL, authHeaders } from '../config'

interface PluginManifest {
  name: string
  version: string
  sdkVersion: string
  description: string
  author?: string
}

interface PluginValidation {
  ok: boolean
  reason?: 'invalid_schema' | 'sdk_incompatible' | 'name_mismatch'
  detail?: string
}

interface PluginRow {
  name: string
  version: string
  enabled: boolean
  status: string
  webhook_url: string
  events: string[]
  loaded: boolean
  manifest: { declared: PluginManifest; validation: PluginValidation | null } | null
  created_at: string
  updated_at: string
}

interface PluginsResponse {
  host_sdk_version: string
  reload_available: boolean
  services: string[]
  plugins: PluginRow[]
}

function statusBadge(row: PluginRow) {
  if (!row.enabled) {
    return (
      <span className="rounded bg-zinc-700/40 text-zinc-400 border border-zinc-600/40 px-2 py-0.5 text-[11px] uppercase tracking-wide">
        disabled
      </span>
    )
  }
  if (row.status === 'error') {
    return (
      <span className="rounded bg-red-500/15 text-red-300 border border-red-500/30 px-2 py-0.5 text-[11px] uppercase tracking-wide">
        error
      </span>
    )
  }
  if (!row.loaded) {
    return (
      <span className="rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2 py-0.5 text-[11px] uppercase tracking-wide">
        not loaded
      </span>
    )
  }
  return (
    <span className="rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-2 py-0.5 text-[11px] uppercase tracking-wide">
      active
    </span>
  )
}

export function PluginAdmin() {
  const [data, setData] = useState<PluginsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionPending, setActionPending] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/plugins`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const doAction = useCallback(
    async (name: string, action: 'enable' | 'disable' | 'reload') => {
      setActionPending(`${name}:${action}`)
      try {
        const res = await fetch(`${CORE_URL}/api/v1/admin/plugins/${encodeURIComponent(name)}/${action}`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
        })
        if (!res.ok) {
          const body = await res.text()
          setError(`${action} failed: ${res.status} ${body.slice(0, 200)}`)
        } else {
          await load()
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setActionPending(null)
      }
    },
    [load],
  )

  if (loading) return <div className="text-zinc-500 text-sm py-8 text-center">Carregando plugins…</div>
  if (error) return <div className="text-red-400 text-sm py-8 text-center">Erro: {error}</div>
  if (!data) return <div className="text-zinc-500 text-sm py-8 text-center">Sem dados.</div>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-zinc-400">
        <span>Host SDK: <span className="font-mono text-zinc-200">{data.host_sdk_version}</span></span>
        <span>Reload {data.reload_available ? 'disponível' : 'bloqueado em produção'}</span>
        <span>Services registrados: {data.services.length === 0 ? '—' : data.services.join(', ')}</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {data.plugins.map((row) => {
          const validation = row.manifest?.validation
          const validationLine =
            !row.manifest
              ? 'sem manifest (legacy — admin introspection limitada)'
              : validation?.ok === false
              ? `manifest inválido (${validation.reason}): ${validation.detail}`
              : 'manifest validado'
          return (
            <div key={row.name} className="bg-zinc-900 rounded-xl border border-zinc-800 p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-sm text-zinc-100 truncate">{row.name}</div>
                  <div className="text-[11px] text-zinc-500 truncate">v{row.version}</div>
                </div>
                {statusBadge(row)}
              </div>

              {row.manifest && (
                <div className="text-[12px] text-zinc-400 leading-snug">{row.manifest.declared.description}</div>
              )}

              <div className="text-[11px] text-zinc-500 space-y-0.5">
                <div>
                  SDK declarado: <span className="font-mono text-zinc-300">{row.manifest?.declared.sdkVersion ?? '—'}</span>
                </div>
                <div>Eventos: {row.events.length === 0 ? '—' : row.events.join(', ')}</div>
                <div className={validation?.ok === false ? 'text-amber-400' : ''}>{validationLine}</div>
              </div>

              <div className="flex gap-2 pt-1">
                {row.enabled ? (
                  <button
                    disabled={actionPending !== null}
                    onClick={() => doAction(row.name, 'disable')}
                    className="text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20 rounded px-2 py-1 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
                  >
                    Disable
                  </button>
                ) : (
                  <button
                    disabled={actionPending !== null}
                    onClick={() => doAction(row.name, 'enable')}
                    className="text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 rounded px-2 py-1 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                  >
                    Enable
                  </button>
                )}
                {data.reload_available && row.enabled && row.loaded && (
                  <button
                    disabled={actionPending !== null}
                    onClick={() => doAction(row.name, 'reload')}
                    className="text-xs bg-zinc-700/40 text-zinc-300 border border-zinc-600/40 rounded px-2 py-1 hover:bg-zinc-700/70 transition-colors disabled:opacity-50"
                    title="Re-init plugin without restarting core (DEV only)"
                  >
                    Reload
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
