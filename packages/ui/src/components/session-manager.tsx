import { useEffect, useState, useCallback, useMemo } from 'react'
import { Search, Radio, RefreshCw, CheckSquare, Shield, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CORE_URL, authHeaders } from '../config'

interface SessionWithStatus {
  sessionName: string
  wahaStatus: string
  phoneNumber: string | null
  managed: boolean
  chatwootInboxId: number | null
  deviceSerial: string | null
  profileId: number | null
}

interface DeviceWithProfiles {
  serial: string
  status?: string
  profiles: Array<{ profileId: number; phoneNumber: string | null; packageName: string }>
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
  const { t } = useTranslation()
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
          setError(t('sessionManager.errorNotConfigured'))
          return
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const data: SessionWithStatus[] = await res.json()
      setSessions(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sessionManager.fetchFailed'))
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
      setError(err instanceof Error ? err.message : t('sessionManager.setManagedFailed'))
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
      setError(err instanceof Error ? err.message : t('sessionManager.unmanagedFailed'))
    }
  }

  const [pairing, setPairing] = useState<string | null>(null)
  const [pairSteps, setPairSteps] = useState<string[]>([])
  const [devices, setDevices] = useState<DeviceWithProfiles[]>([])
  // Per-session attach selection (pre-pair). Keyed by session name.
  const [attachSelection, setAttachSelection] = useState<Record<string, { serial: string; profileId: number | null }>>({})

  // Load devices + their profiles once on mount.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await fetch(`${CORE_URL}/api/v1/monitor/devices`, { headers: authHeaders() })
        if (!r.ok) return
        const list = (await r.json()) as Array<{ serial: string; status?: string }>
        const out: DeviceWithProfiles[] = await Promise.all(
          list.map(async (d) => {
            try {
              const a = await fetch(
                `${CORE_URL}/api/v1/monitor/devices/${encodeURIComponent(d.serial)}/accounts`,
                { headers: authHeaders() },
              )
              if (!a.ok) return { serial: d.serial, status: d.status, profiles: [] }
              const accs = (await a.json()) as Array<{
                profileId: number
                packageName: string
                phoneNumber: string | null
                stale?: boolean
              }>
              const profiles = accs
                .filter((x) => !x.stale)
                .map((x) => ({
                  profileId: x.profileId,
                  phoneNumber: x.phoneNumber,
                  packageName: x.packageName,
                }))
              return { serial: d.serial, status: d.status, profiles }
            } catch {
              return { serial: d.serial, status: d.status, profiles: [] }
            }
          }),
        )
        if (!cancelled) setDevices(out)
      } catch { /* ignore */ }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const attachSessionToDevice = async (
    sessionName: string,
    deviceSerial: string,
    profileId: number,
  ): Promise<boolean> => {
    try {
      const r = await fetch(
        `${CORE_URL}/api/v1/sessions/managed/${encodeURIComponent(sessionName)}/device`,
        {
          method: 'PUT',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ device_serial: deviceSerial, profile_id: profileId }),
        },
      )
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        setError(`Falha ao atribuir device (HTTP ${r.status}): ${body.slice(0, 200)}`)
        return false
      }
      await fetchSessions()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'attach failed')
      return false
    }
  }

  const handleShowQr = async (name: string) => {
    setPairing(name)
    setPairSteps([t('sessionManager.startingPairing')])
    setError(null)

    // Pre-flight: if the session has no device yet, the operator must
    // have picked one in the inline dropdown. Push that to the backend
    // BEFORE asking for the QR — otherwise pair returns 412.
    const session = sessions.find((s) => s.sessionName === name)
    if (session && !session.deviceSerial) {
      const sel = attachSelection[name]
      if (!sel?.serial || sel.profileId === null) {
        setError('Selecione device + profile antes de parear esta sessão.')
        setPairing(null)
        return
      }
      setPairSteps((prev) => [...prev, `Atribuindo ${sel.serial.slice(0, 12)}.../profile ${sel.profileId}...`])
      const ok = await attachSessionToDevice(name, sel.serial, sel.profileId)
      if (!ok) {
        setPairing(null)
        return
      }
      setPairSteps((prev) => [...prev, 'Atribuído. Iniciando pareamento...'])
    }

    try {
      const res = await fetch(`${CORE_URL}/api/v1/waha/sessions/${encodeURIComponent(name)}/pair`, {
        method: 'POST',
        headers: authHeaders(),
      })
      const data = await res.json()
      if (res.status === 412) {
        setError(data.detail || 'Sessão sem device atribuído. Selecione device + profile.')
        setPairing(null)
        return
      }

      if (data.steps) setPairSteps(data.steps)

      if (data.qr) {
        setQrData({ sessionName: name, qr: data.qr })
      } else {
        // QR not ready yet — try fetching directly
        setPairSteps(prev => [...prev, t('sessionManager.fetchingQr')])
        await new Promise((r) => setTimeout(r, 3000))
        const qrRes = await fetch(`${CORE_URL}/api/v1/waha/sessions/${encodeURIComponent(name)}/qr`, { headers: authHeaders() })
        if (qrRes.ok) {
          const qrData = await qrRes.json()
          setQrData({ sessionName: name, qr: qrData.qr })
          setPairSteps(prev => [...prev, t('sessionManager.qrObtained')])
        } else {
          setPairSteps(prev => [...prev, t('sessionManager.qrUnavailable')])
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sessionManager.pairingFailed'))
    } finally {
      setPairing(null)
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
      setError(err instanceof Error ? err.message : t('sessionManager.inboxFailed'))
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
              placeholder={t('sessionManager.searchPlaceholder')}
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
            <FilterChip label={`${t('sessionManager.filterAll')} (${sessions.length})`} active={!statusFilter} onClick={() => setStatusFilter(null)} />
            <FilterChip label={`${t('sessionManager.filterWorking')} (${workingCount})`} active={statusFilter === 'WORKING'} onClick={() => setStatusFilter(statusFilter === 'WORKING' ? null : 'WORKING')} color="emerald" />
            <FilterChip label={`${t('sessionManager.filterFailed')} (${failedCount})`} active={statusFilter === 'FAILED'} onClick={() => setStatusFilter(statusFilter === 'FAILED' ? null : 'FAILED')} color="red" />
            <FilterChip label={`${t('sessionManager.filterManaged')} (${managedCount})`} active={statusFilter === 'MANAGED'} onClick={() => setStatusFilter(statusFilter === 'MANAGED' ? null : 'MANAGED')} color="blue" />
          </div>
          <div className="flex gap-2">
            <button
              onClick={selectAll}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 border border-zinc-700/40 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
            >
              <CheckSquare className="h-3 w-3" />
              {t('sessionManager.selectUnmanaged')}
            </button>
            <button
              onClick={handleBulkManage}
              disabled={selected.size === 0 || loading}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Shield className="h-3 w-3" />
              {loading ? t('sessionManager.markingManaged') : `${t('sessionManager.markManaged')} (${selected.size})`}
            </button>
          </div>
        </div>

        <div className="text-xs text-zinc-600">
          {filtered.length === sessions.length
            ? `${sessions.length} ${t('sessionManager.sessionCount')}`
            : `${filtered.length} ${t('sessionManager.sessionCountFiltered')} ${sessions.length} ${t('sessionManager.sessionCount')}`}
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

      {/* Pairing Steps */}
      {pairSteps.length > 0 && !qrData && (
        <div className="rounded-lg border border-amber-800/50 bg-zinc-900 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-amber-400">{t('sessionManager.pairingInProgress')}</span>
            <button onClick={() => { setPairSteps([]); setPairing(null) }} className="text-zinc-400 hover:text-zinc-200 text-sm"><X className="h-4 w-4" /></button>
          </div>
          <div className="space-y-1">
            {pairSteps.map((step, i) => (
              <div key={i} className="text-xs text-zinc-400 flex items-center gap-2">
                <span className="text-emerald-500">&#10003;</span> {step}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* QR Code Modal */}
      {qrData && (
        <div className="rounded-lg border border-blue-800 bg-zinc-900 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">{t('sessionManager.qrCode')} — {qrData.sessionName}</span>
            <button
              onClick={() => { setQrData(null); setPairSteps([]) }}
              className="text-zinc-400 hover:text-zinc-200 text-sm"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {pairSteps.length > 0 && (
            <div className="mb-3 space-y-0.5">
              {pairSteps.map((step, i) => (
                <div key={i} className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                  <span className="text-emerald-600">&#10003;</span> {step}
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-center bg-white p-4 rounded">
            <img src={qrData.qr} alt="QR Code" className="max-w-64" />
          </div>
          <p className="text-xs text-zinc-500 mt-2 text-center">
            {t('sessionManager.qrInstruction')}
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
                  {session.phoneNumber ?? t('sessionManager.noPhone')} · {session.wahaStatus}
                  {session.deviceSerial ? (
                    <span className="ml-2 text-zinc-600">
                      · {session.deviceSerial.slice(0, 12)}…/profile {session.profileId}
                    </span>
                  ) : session.managed ? (
                    <span className="ml-2 text-amber-500">· sem device atribuído</span>
                  ) : null}
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-1.5">
                {(session.wahaStatus !== 'WORKING') && (
                  <button
                    onClick={() => handleShowQr(session.sessionName)}
                    disabled={pairing === session.sessionName}
                    className="rounded bg-blue-800 px-2 py-1 text-xs text-blue-100 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-wait"
                  >
                    {pairing === session.sessionName ? t('sessionManager.pairing') : t('sessionManager.pair')}
                  </button>
                )}
                {session.managed && !session.chatwootInboxId && (
                  <button
                    onClick={() => handleCreateInbox(session.sessionName)}
                    disabled={creatingInbox === session.sessionName}
                    className="rounded bg-violet-800 px-2 py-1 text-xs text-violet-100 hover:bg-violet-700 disabled:opacity-50"
                  >
                    {creatingInbox === session.sessionName ? '...' : t('sessionManager.createInbox')}
                  </button>
                )}
                {session.managed && (
                  <button
                    onClick={() => handleUnmanage(session.sessionName)}
                    className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                  >
                    {t('sessionManager.unmanage')}
                  </button>
                )}
              </div>
            </div>

            {/* Device + profile picker for managed sessions without
                an attached device. Shown inline so the operator can
                pick before clicking Pair. */}
            {session.managed && !session.deviceSerial && (
              <div className="mt-2 flex items-center gap-2">
                <select
                  value={attachSelection[session.sessionName]?.serial ?? ''}
                  onChange={(e) =>
                    setAttachSelection((prev) => ({
                      ...prev,
                      [session.sessionName]: { serial: e.target.value, profileId: null },
                    }))
                  }
                  className="rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200"
                >
                  <option value="">— device —</option>
                  {devices.map((d) => (
                    <option key={d.serial} value={d.serial} disabled={d.status !== 'online'}>
                      {d.serial.slice(0, 12)}…
                      {d.status !== 'online' ? ' (offline)' : ''}
                    </option>
                  ))}
                </select>
                <select
                  value={attachSelection[session.sessionName]?.profileId ?? ''}
                  onChange={(e) =>
                    setAttachSelection((prev) => ({
                      ...prev,
                      [session.sessionName]: {
                        serial: prev[session.sessionName]?.serial ?? '',
                        profileId: e.target.value === '' ? null : Number(e.target.value),
                      },
                    }))
                  }
                  disabled={!attachSelection[session.sessionName]?.serial}
                  className="rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200 disabled:opacity-50"
                >
                  <option value="">— profile —</option>
                  {(devices.find((d) => d.serial === attachSelection[session.sessionName]?.serial)?.profiles ?? [])
                    .map((p) => (
                      <option key={p.profileId} value={p.profileId}>
                        profile {p.profileId}
                        {p.phoneNumber ? ` · ${p.phoneNumber}` : ' · vazio'}
                      </option>
                    ))}
                </select>
              </div>
            )}

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
                ? t('sessionManager.noSessions')
                : t('sessionManager.noMatch')}
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
