import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, RefreshCw, Trash2, Search, Database, ShieldOff, PauseCircle, PlayCircle, Plus, Gauge, Link2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CORE_URL, authHeaders } from '../config'
import { AckRatePage } from './ack-rate-page'
import { PipedrivePage } from './pipedrive-page'

// ── Types ──────────────────────────────────────────────────────────────────

interface DeadLetterCallback {
  id: string
  plugin_name: string
  message_id: string
  callback_type: string
  payload: string
  webhook_url: string
  attempts: number
  last_error: string
  created_at: string
  last_attempt_at: string
  abandoned_at: string | null
  abandoned_reason: string | null
}

interface BannedNumber {
  phone_number: string
  reason: string
  hits: number
  detected_message: string | null
  detected_pattern: string | null
  source_session: string | null
  created_at: string
  last_hit_at: string | null
}

// ── Sub-component: Dead-letter callbacks ───────────────────────────────────

function DeadLetterPanel() {
  const { t } = useTranslation()
  const [items, setItems] = useState<DeadLetterCallback[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<Set<string>>(new Set())

  const fetchDeadLetter = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/callbacks/dead-letter`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as DeadLetterCallback[]
      setItems(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void fetchDeadLetter() }, [fetchDeadLetter])

  const handleRetry = async (id: string) => {
    setRetrying(prev => new Set(prev).add(id))
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/callbacks/${id}/retry`, {
        method: 'POST', headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await fetchDeadLetter()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry falhou')
    } finally {
      setRetrying(prev => { const s = new Set(prev); s.delete(id); return s })
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">{t('admin.deadLetterTitle')}</h3>
          <span className="text-xs text-zinc-500">({items.length})</span>
        </div>
        <button
          onClick={fetchDeadLetter}
          className="flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          {t('admin.refresh')}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {items.length === 0 && !loading && (
        <p className="text-xs text-zinc-500 italic">{t('admin.deadLetterEmpty')}</p>
      )}
      <div className="space-y-2">
        {items.map(item => (
          <div key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium text-zinc-200">{item.plugin_name}</span>
                  <span className="rounded bg-red-500/10 text-red-400 px-1.5 py-0.5 text-xs">{item.callback_type}</span>
                  <span className="text-xs text-zinc-500">{t('admin.attempts')}: {item.attempts}</span>
                </div>
                <p className="text-xs text-zinc-400 font-mono truncate mt-1">{item.message_id}</p>
                <p className="text-xs text-zinc-500 truncate mt-0.5">{item.webhook_url}</p>
                {item.last_error && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-zinc-500">{t('admin.lastError')}</summary>
                    <code className="block mt-1 text-xs text-red-400 break-all">{item.last_error}</code>
                  </details>
                )}
                <p className="text-xs text-zinc-600 mt-1">
                  {t('admin.abandonedAt')}: {item.abandoned_at ? new Date(item.abandoned_at).toLocaleString('pt-BR') : '—'}
                </p>
              </div>
              <button
                onClick={() => handleRetry(item.id)}
                disabled={retrying.has(item.id)}
                className="shrink-0 rounded-md bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                {retrying.has(item.id) ? '...' : t('admin.retry')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Sub-component: Banned numbers ──────────────────────────────────────────

function BannedNumbersPanel() {
  const { t } = useTranslation()
  const [items, setItems] = useState<BannedNumber[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [removing, setRemoving] = useState<Set<string>>(new Set())

  const fetchBanned = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/banned-numbers`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as BannedNumber[]
      setItems(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void fetchBanned() }, [fetchBanned])

  const handleUnban = async (phone: string) => {
    if (!confirm(t('admin.unbanConfirm', { phone }))) return
    setRemoving(prev => new Set(prev).add(phone))
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/banned-numbers/${encodeURIComponent(phone)}`, {
        method: 'DELETE', headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await fetchBanned()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unban falhou')
    } finally {
      setRemoving(prev => { const s = new Set(prev); s.delete(phone); return s })
    }
  }

  const filtered = filter
    ? items.filter(i => i.phone_number.includes(filter.replace(/\D/g, '')))
    : items

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldOff className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">{t('admin.bannedTitle')}</h3>
          <span className="text-xs text-zinc-500">({filtered.length}/{items.length})</span>
        </div>
        <button
          onClick={fetchBanned}
          className="flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          {t('admin.refresh')}
        </button>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
        <input
          type="text"
          placeholder={t('admin.bannedSearchPlaceholder')}
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="w-full rounded-md bg-zinc-800 border border-zinc-700/40 pl-9 pr-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
        />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {filtered.length === 0 && !loading && (
        <p className="text-xs text-zinc-500 italic">{t('admin.bannedEmpty')}</p>
      )}
      <div className="space-y-2">
        {filtered.map(item => (
          <div key={item.phone_number} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-mono text-zinc-200">{item.phone_number}</span>
                  <span className="rounded bg-amber-500/10 text-amber-400 px-1.5 py-0.5 text-xs">{item.reason}</span>
                  <span className="text-xs text-zinc-500">{t('admin.hits')}: {item.hits}</span>
                </div>
                <p className="text-xs text-zinc-500 mt-1">
                  {t('admin.firstSeen')}: {new Date(item.created_at).toLocaleString('pt-BR')}
                </p>
                {item.last_hit_at && (
                  <p className="text-xs text-zinc-500">
                    {t('admin.lastHit')}: {new Date(item.last_hit_at).toLocaleString('pt-BR')}
                  </p>
                )}
                {item.detected_message && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-zinc-500">{t('admin.detectedMessage')}</summary>
                    <code className="block mt-1 text-xs text-zinc-400 break-all">{item.detected_message}</code>
                  </details>
                )}
              </div>
              <button
                onClick={() => handleUnban(item.phone_number)}
                disabled={removing.has(item.phone_number)}
                className="shrink-0 flex items-center gap-1 rounded-md bg-red-500/10 border border-red-500/30 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" />
                {removing.has(item.phone_number) ? '...' : t('admin.unban')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Sub-component: Manual circuit breaker (pause state) ───────────────────

interface PauseRow {
  scope: 'global' | 'plugin' | 'sender' | 'device' | 'chain' | 'message'
  key: string
  reason: string
  paused_by: string
  paused_at: string
  resumed_at: string | null
}

function PausePanel() {
  const { t } = useTranslation()
  const [items, setItems] = useState<PauseRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // New-pause form state
  const [scope, setScope] = useState<PauseRow['scope']>('global')
  const [key, setKey] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchPauses = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/pause`, { headers: authHeaders() })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setItems(await res.json() as PauseRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void fetchPauses() }, [fetchPauses])

  const handlePause = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) { setError(t('admin.pauseReasonRequired')); return }
    if (scope !== 'global' && !key.trim()) { setError(t('admin.pauseKeyRequired')); return }
    setSubmitting(true); setError(null)
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/pause`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, key: scope === 'global' ? '*' : key, reason, by: 'ui' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      setKey(''); setReason('')
      await fetchPauses()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao pausar')
    } finally { setSubmitting(false) }
  }

  const handleResume = async (item: PauseRow) => {
    try {
      const res = await fetch(`${CORE_URL}/api/v1/admin/pause/resume`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: item.scope, key: item.key, by: 'ui' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await fetchPauses()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao retomar')
    }
  }

  const isGlobalPaused = items.some(p => p.scope === 'global')

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PauseCircle className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-medium text-zinc-200">{t('admin.pauseTitle')}</h3>
          <span className="text-xs text-zinc-500">({items.length})</span>
          {isGlobalPaused && (
            <span className="rounded bg-red-500/20 text-red-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
              {t('admin.pauseGlobalActive')}
            </span>
          )}
        </div>
        <button
          onClick={fetchPauses}
          className="flex items-center gap-1.5 rounded-md bg-zinc-800 border border-zinc-700/40 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          {t('admin.refresh')}
        </button>
      </div>

      {/* New pause form */}
      <form onSubmit={handlePause} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 space-y-3">
        <div className="flex items-center gap-2 text-xs text-zinc-300 font-medium">
          <Plus className="h-3.5 w-3.5" />
          {t('admin.pauseNew')}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] text-zinc-500 uppercase tracking-wide">{t('admin.pauseScope')}</label>
            <select
              value={scope}
              onChange={e => setScope(e.target.value as PauseRow['scope'])}
              className="w-full rounded-md bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
            >
              <option value="global">global — toda a fila</option>
              <option value="plugin">plugin — por plugin (ex: oralsin)</option>
              <option value="sender">sender — por número do sender</option>
              <option value="device">device — por serial</option>
              <option value="chain">chain — por correlation_id</option>
              <option value="message">message — por idempotency_key</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-zinc-500 uppercase tracking-wide">{t('admin.pauseKey')}</label>
            <input
              type="text"
              value={key}
              onChange={e => setKey(e.target.value)}
              disabled={scope === 'global'}
              placeholder={scope === 'global' ? '*' : 'oralsin / 554396837945 / 9b01... / ...'}
              className="w-full rounded-md bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600 disabled:opacity-50"
            />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-zinc-500 uppercase tracking-wide">{t('admin.pauseReason')}</label>
          <input
            type="text"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="Motivo (visível em audit + Telegram)..."
            className="w-full rounded-md bg-zinc-800 border border-zinc-700/40 px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
          />
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center gap-1.5 rounded-md bg-red-500/10 border border-red-500/30 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-50"
          >
            <PauseCircle className="h-3.5 w-3.5" />
            {submitting ? t('admin.pausing') : t('admin.pauseSubmit')}
          </button>
        </div>
      </form>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {items.length === 0 && !loading && (
        <p className="text-xs text-zinc-500 italic">{t('admin.pauseEmpty')}</p>
      )}

      {/* Active pauses list */}
      <div className="space-y-2">
        {items.map(item => (
          <div
            key={`${item.scope}:${item.key}`}
            className="flex items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="rounded bg-zinc-800 text-zinc-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide font-medium">
                  {item.scope}
                </span>
                <span className="text-xs font-mono text-zinc-200 truncate">{item.key}</span>
              </div>
              <p className="text-xs text-zinc-400 mt-1">{item.reason}</p>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                {t('admin.pauseBy')}: {item.paused_by} · {new Date(item.paused_at).toLocaleString('pt-BR')}
              </p>
            </div>
            <button
              onClick={() => handleResume(item)}
              className="shrink-0 flex items-center gap-1 rounded-md bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 text-xs text-emerald-300 hover:bg-emerald-500/20"
            >
              <PlayCircle className="h-3 w-3" />
              {t('admin.resume')}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────

type AdminTab = 'dead-letter' | 'banned' | 'pause' | 'ack-rate' | 'pipedrive'

export function AdminPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<AdminTab>('dead-letter')

  const tabLabel = (id: AdminTab): string => {
    if (id === 'pause') return t('admin.pauseTab')
    if (id === 'dead-letter') return t('admin.deadLetterTab')
    if (id === 'banned') return t('admin.bannedTab')
    if (id === 'pipedrive') return t('admin.pipedriveTab', { defaultValue: 'Pipedrive' })
    return t('admin.ackRateTab')
  }
  const tabIcon = (id: AdminTab) => {
    if (id === 'ack-rate') return <Gauge className="h-3.5 w-3.5" />
    if (id === 'pipedrive') return <Link2 className="h-3.5 w-3.5" />
    return null
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-3">
        <AlertTriangle className="h-5 w-5 text-amber-400" />
        <h2 className="text-base font-semibold text-zinc-100">{t('admin.title')}</h2>
      </div>

      <div className="flex gap-2 border-b border-zinc-800 flex-wrap">
        {(['pause', 'dead-letter', 'banned', 'ack-rate', 'pipedrive'] as AdminTab[]).map(id => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition ${
              tab === id
                ? 'border-emerald-400 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tabIcon(id)}
            {tabLabel(id)}
          </button>
        ))}
      </div>

      {tab === 'pause' && <PausePanel />}
      {tab === 'dead-letter' && <DeadLetterPanel />}
      {tab === 'banned' && <BannedNumbersPanel />}
      {tab === 'ack-rate' && <AckRatePage />}
      {tab === 'pipedrive' && <PipedrivePage />}
    </div>
  )
}
