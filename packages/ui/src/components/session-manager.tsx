import { useEffect, useState, useCallback } from 'react'
import { CORE_URL } from '../config'

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
      const res = await fetch(`${CORE_URL}/api/v1/sessions`)
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
        headers: { 'Content-Type': 'application/json' },
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
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await fetchSessions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unmanage')
    }
  }

  const handleShowQr = async (name: string) => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/sessions/${encodeURIComponent(name)}/qr`)
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
        headers: { 'Content-Type': 'application/json' },
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

  const managedCount = sessions.filter((s) => s.managed).length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-zinc-400">
          {sessions.length} sessions ({managedCount} managed)
        </div>
        <div className="flex gap-2">
          <button
            onClick={selectAll}
            className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            Select unmanaged
          </button>
          <button
            onClick={handleBulkManage}
            disabled={selected.size === 0 || loading}
            className="rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Setting...' : `Mark managed (${selected.size})`}
          </button>
          <button
            onClick={fetchSessions}
            className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded bg-red-900/30 border border-red-800 p-3 text-sm text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-200">
            dismiss
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
            <img src={`data:image/png;base64,${qrData.qr}`} alt="QR Code" className="max-w-64" />
          </div>
          <p className="text-xs text-zinc-500 mt-2 text-center">
            Scan with WhatsApp on the device to pair
          </p>
        </div>
      )}

      {/* Session List */}
      <div className="space-y-2">
        {sessions.map((session) => (
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
                {session.wahaStatus === 'SCAN_QR_CODE' && (
                  <button
                    onClick={() => handleShowQr(session.sessionName)}
                    className="rounded bg-blue-800 px-2 py-1 text-xs text-blue-100 hover:bg-blue-700"
                  >
                    QR
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

        {sessions.length === 0 && !error && (
          <div className="text-center text-zinc-500 py-8 text-sm">
            No WAHA sessions found. Check WAHA API connection.
          </div>
        )}
      </div>
    </div>
  )
}
