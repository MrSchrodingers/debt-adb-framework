import { useEffect, useState, useCallback, useMemo } from 'react'
import { Search, Radio, RefreshCw, CheckSquare, Shield, X } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

interface SessionWithStatus {
  sessionName: string
  wahaStatus: string
  phoneNumber: string | null
  managed: boolean
  chatwootInboxId: number | null
}

interface QrData {
  sessionName: string
  qr: string
}

const statusColors: Record<string, string> = {
  WORKING: 'bg-emerald-500',
  FAILED: 'bg-red-500',
  STARTING: 'bg-amber-500',
  STOPPED: 'bg-zinc-500',
  SCAN_QR_CODE: 'bg-blue-500',
}

export function SessionManager() {
  const [sessions, setSessions] = useState<SessionWithStatus[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [qrData, setQrData] = useState<QrData | null>(null)
  const [inboxName, setInboxName] = useState('')
  const [creatingInbox, setCreatingInbox] = useState<string | null>(null)

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/sessions`, { headers: authHeaders() })
      if (!res.ok) {
        if (res.status === 503) {
          setError('Session automation not configured. Set WAHA and Chatwoot env vars.')
          return
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const data: SessionWithStatus[] = await res.json()
      setSessions(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions')
    }
  }, [])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

  const toggleSelect = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const selectAll = () => {
    const unmanaged = sessions.filter((s) => !s.managed).map((s) => s.sessionName)
    setSelected(new Set(unmanaged))
  }

  const handleBulkManage = async () => {
    if (selected.size === 0) return
    setLoading(true)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/sessions/managed`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ sessionNames: [...selected] }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSelected(new Set())
      await fetchSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set managed')
    } finally {
      setLoading(false)
    }
  }

  const handleUnmanage = async (name: string) => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/sessions/managed/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await fetchSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unmanage')
    }
  }

  const handleShowQr = async (name: string) => {
    try {
      // Restart session first to ensure it enters SCAN_QR_CODE state
      await fetch(`${CORE_URL}/api/v1/waha/sessions/${encodeURIComponent(name)}/restart`, {
        method: 'POST',
        headers: authHeaders(),
      })
      // Wait for session to reach SCAN_QR_CODE
      await new Promise((r) => setTimeout(r, 4000))

      const res = await fetch(`${CORE_URL}/api/v1/waha/sessions/${encodeURIComponent(name)}/qr`, { headers: authHeaders() })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setQrData({ sessionName: name, qr: data.qr })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'QR code not available')
    }
  }

  const handleCreateInbox = async (name: string) => {
    setCreatingInbox(name)
    try {
      const body: Record<string, string> = {}
      if (inboxName.trim()) body.inboxName = inboxName.trim()

      const res = await fetch(`${CORE_URL}/api/v1/sessions/${encodeURIComponent(name)}/inbox`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail || `HTTP ${res.status}`)
      }
      setInboxName('')
      await fetchSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create inbox')
    } finally {
      setCreatingInbox(null)
    }
  }

  const [search, setSearch] = useState('')
  const managedCount = sessions.filter((s) => s.managed).length
  const workingCount = sessions.filter((s) => s.wahaStatus === 'WORKING').length
  const failedCount = sessions.filter((s) => s.wahaStatus === 'FAILED').length
  const [statusFilter, setStatusFilter] = useState<string | null>(null)

  const filtered = useMemo(() => {
    let result = sessions
    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter(
        (s) =>
          s.sessionName.toLowerCase().includes(q) ||
          (s.phoneNumber && s.phoneNumber.includes(q)),
      )
    }
    if (statusFilter === 'MANAGED') {
      result = result.filter((s) => s.managed)
    } else if (statusFilter) {
      result = result.filter((s) => s.wahaStatus === statusFilter)
    }
    return result
  }, [sessions, search, statusFilter])

  return (
    <div className="space-y-4">
      {/* Search + filters */}
      <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-600" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome ou numero..."
              className="w-full rounded-lg bg-zinc-800/80 pl-10 pr-3 py-2.5 text-sm text-zinc-100 border border-zinc-700/60 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 placeholder:text-zinc-600 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <button
            onClick={fetchSessions}
            className="rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-2.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FilterChip label={`Todas (${sessions.length})`} active={!statusFilter} onClick={() => setStatusFilter(null)} />
            <FilterChip label={`Working (${workingCount})`} active={statusFilter === 'WORKING'} onClick={() => setStatusFilter(statusFilter === 'WORKING' ? null : 'WORKING')} color="emerald" />
            <FilterChip label={`Failed (${failedCount})`} active={statusFilter === 'FAILED'} onClick={() => setStatusFilter(statusFilter === 'FAILED' ? null : 'FAILED')} color="red" />
            <FilterChip label={`Managed (${managedCount})`} active={statusFilter === 'MANAGED'} onClick={() => setStatusFilter(statusFilter === 'MANAGED' ? null : 'MANAGED')} color="blue" />
          </div>
          <div className="flex gap-2">
            <button
              onClick={selectAll}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
            >
              <CheckSquare className="h-3 w-3" />
              Selecionar nao gerenciadas
            </button>
            <button
              onClick={handleBulkManage}
              disabled={selected.size === 0 || loading}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Shield className="h-3 w-3" />
              {loading ? 'Marcando...' : `Marcar managed (${selected.size})`}
            </button>
          </div>
        </div>

        <div className="text-xs text-zinc-600">
          {filtered.length === sessions.length
            ? `${sessions.length} sessoes`
            : `${filtered.length} de ${sessions.length} sessoes`}
        </div>
      </div>

      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-300">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* QR Code Modal */}
      {qrData && (
        <div className="rounded-lg border border-blue-800 bg-zinc-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">QR Code — {qrData.sessionName}</span>
            <button
              onClick={() => setQrData(null)}
              className="text-zinc-400 hover:text-zinc-200 text-sm"
            >
              close
            </button>
          </div>
          <div className="flex justify-center bg-white p-4 rounded">
            <img src={qrData.qr} alt="QR Code" className="max-w-64" />
          </div>
          <p className="text-xs text-zinc-500 mt-2 text-center">
            Scan with WhatsApp on the device to pair
          </p>
        </div>
      )}

      {/* Session List */}
      <div className="space-y-2">
        {filtered.map((session) => (
          <div
            key={session.sessionName}
            className={`rounded-lg border bg-zinc-900 p-3 ${
              session.managed ? 'border-emerald-800/50' : 'border-zinc-800'
            }`}
          >
            <div className="flex items-center gap-3">
              {/* Checkbox for unmanaged sessions */}
              {!session.managed && (
                <input
                  type="checkbox"
                  checked={selected.has(session.sessionName)}
                  onChange={() => toggleSelect(session.sessionName)}
                  className="h-4 w-4 rounded border-zinc-600 bg-zinc-800"
                />
              )}

              {/* Status dot */}
              <div
                className={`h-2.5 w-2.5 rounded-full ${
                  statusColors[session.wahaStatus] ?? 'bg-zinc-500'
                }`}
              />

              {/* Session info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{session.sessionName}</span>
                  {session.managed && (
                    <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] text-emerald-400 font-medium">
                      managed
                    </span>
                  )}
                  {session.chatwootInboxId && (
                    <span className="rounded bg-blue-900/50 px-1.5 py-0.5 text-[10px] text-blue-400 font-medium">
                      inbox #{session.chatwootInboxId}
                    </span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  {session.phoneNumber ?? 'no phone'} · {session.wahaStatus}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-1.5">
                {(session.wahaStatus === 'SCAN_QR_CODE' || session.wahaStatus === 'FAILED' || session.wahaStatus === 'STARTING' || session.wahaStatus === 'STOPPED') && (
                  <button
                    onClick={() => handleShowQr(session.sessionName)}
                    className="rounded bg-blue-800 px-2 py-1 text-xs text-blue-100 hover:bg-blue-700"
                  >
                    {session.wahaStatus === 'SCAN_QR_CODE' ? 'QR' : 'Restart + QR'}
                  </button>
                )}
                {session.managed && !session.chatwootInboxId && (
                  <button
                    onClick={() => handleCreateInbox(session.sessionName)}
                    disabled={creatingInbox === session.sessionName}
                    className="rounded bg-violet-800 px-2 py-1 text-xs text-violet-100 hover:bg-violet-700 disabled:opacity-50"
                  >
                    {creatingInbox === session.sessionName ? '...' : 'Create Inbox'}
                  </button>
                )}
                {session.managed && (
                  <button
                    onClick={() => handleUnmanage(session.sessionName)}
                    className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                  >
                    Unmanage
                  </button>
                )}
              </div>
            </div>

            {/* Inline inbox name input when creating */}
            {creatingInbox === session.sessionName && (
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={inboxName}
                  onChange={(e) => setInboxName(e.target.value)}
                  placeholder={`Dispatch — ${session.phoneNumber ?? session.sessionName}`}
                  className="flex-1 rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-sm text-zinc-200 placeholder:text-zinc-600"
                />
              </div>
            )}
          </div>
        ))}

        {filtered.length === 0 && !error && (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/50 p-8 text-center">
            <Radio className="h-8 w-8 text-zinc-700 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">
              {sessions.length === 0
                ? 'Nenhuma sessao WAHA encontrada'
                : 'Nenhuma sessao corresponde ao filtro'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function FilterChip({ label, active, onClick, color }: {
  label: string
  active: boolean
  onClick: () => void
  color?: string
}) {
  const colors: Record<string, string> = {
    emerald: active ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : '',
    red: active ? 'bg-red-500/10 text-red-400 border-red-500/30' : '',
    blue: active ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' : '',
  }
  const activeClass = color ? colors[color] : (active ? 'bg-zinc-700 text-zinc-200 border-zinc-600' : '')
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 text-xs border transition-colors ${
        active
          ? activeClass
          : 'border-zinc-700/40 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
      }`}
    >
      {label}
    </button>
  )
}
