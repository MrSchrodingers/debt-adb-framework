import { useState, useEffect, useCallback } from 'react'
import {
  CheckCircle2,
  Circle,
  AlertTriangle,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  Users,
  Wand2,
  Smartphone,
  Phone,
  Sparkles,
  ChevronRight,
  RefreshCw,
} from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

// ── Types matching the backend wizard state ────────────────────────────────

interface WizardState {
  device_serial: string
  root_done: boolean
  users_created: Record<string, string>
  bypassed_profiles: Record<string, string>
  wa_installed_profiles: Record<string, string[]>
  wa_registered_profiles: Record<string, string>
  extraction_complete: boolean
  current_step: string | null
  started_at: string | null
  updated_at: string | null
  finished_at: string | null
  exists: boolean
}

type StepId =
  | 'root_check'
  | 'create_users'
  | 'bypass_setup_wizard'
  | 'install_wa'
  | 'register_wa'
  | 'finalize'

interface UserSeed {
  uid: number
  name: string
}

// Default user layout for POCO C71 (mirrors POCO #1: 2 chips × 4 profiles).
const DEFAULT_USERS: UserSeed[] = [
  { uid: 10, name: 'Oralsin 1 1' },
  { uid: 11, name: 'Oralsin 1 2' },
  { uid: 12, name: 'Oralsin 1 3' },
  { uid: 13, name: 'Oralsin 1 4' },
]

// Conservative HTML escape — used only for surfacing operator-supplied
// profile names back into JSX text nodes when constructing diagnostic
// messages.  React already escapes interpolations by default, but we keep
// this helper for any string concatenation in title attributes.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface DeviceSetupWizardProps {
  serial: string
  onClose?: () => void
}

export function DeviceSetupWizard({ serial, onClose }: DeviceSetupWizardProps) {
  const [state, setState] = useState<WizardState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeStep, setActiveStep] = useState<StepId>('root_check')
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [stepResult, setStepResult] = useState<Record<string, string>>({})
  const [users, setUsers] = useState<UserSeed[]>(DEFAULT_USERS)
  const [confirmModal, setConfirmModal] = useState<{
    title: string
    body: string
    onConfirm: () => void
  } | null>(null)
  const [hitlPhone, setHitlPhone] = useState<Record<number, string>>({})

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(
        `${CORE_URL}/api/v1/devices/${encodeURIComponent(serial)}/setup/state`,
        { headers: authHeaders() },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as WizardState
      setState(data)
      // Auto-advance the active step indicator to match persisted progress.
      if (data.extraction_complete) setActiveStep('finalize')
      else if (Object.keys(data.wa_registered_profiles).length > 0)
        setActiveStep('finalize')
      else if (Object.keys(data.wa_installed_profiles).length > 0)
        setActiveStep('register_wa')
      else if (Object.keys(data.bypassed_profiles).length > 0)
        setActiveStep('install_wa')
      else if (Object.keys(data.users_created).length > 0)
        setActiveStep('bypass_setup_wizard')
      else if (data.root_done) setActiveStep('create_users')
      else setActiveStep('root_check')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [serial])

  useEffect(() => {
    void fetchState()
  }, [fetchState])

  const callApi = useCallback(
    async (
      stepId: string,
      path: string,
      method: 'GET' | 'POST',
      body?: unknown,
    ): Promise<{ ok: boolean; data: unknown; status: number }> => {
      setActionLoading(stepId)
      try {
        const res = await fetch(`${CORE_URL}${path}`, {
          method,
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: body !== undefined ? JSON.stringify(body) : undefined,
        })
        const data = await res.json().catch(() => ({}))
        return { ok: res.ok, data, status: res.status }
      } catch (err) {
        return {
          ok: false,
          data: { error: (err as Error).message },
          status: 0,
        }
      } finally {
        setActionLoading(null)
      }
    },
    [],
  )

  const runRootCheck = useCallback(async () => {
    const r = await callApi(
      'root_check',
      `/api/v1/devices/${encodeURIComponent(serial)}/setup/root-check`,
      'POST',
    )
    if (r.ok) {
      setStepResult((p) => ({ ...p, root_check: 'Root detectado.' }))
    } else {
      const data = r.data as { hint?: string; error?: string }
      setStepResult((p) => ({
        ...p,
        root_check: data.hint || data.error || 'Root nao detectado.',
      }))
    }
    await fetchState()
  }, [callApi, serial, fetchState])

  const runManualRootAck = useCallback(() => {
    setConfirmModal({
      title: 'Confirmar root manual?',
      body:
        'Voce esta declarando que o dispositivo ja foi rooteado fora do wizard ' +
        '(Magisk + PIF + Zygisk-Assistant). Isso destrava as proximas etapas. ' +
        'Use apenas se a verificacao automatica falhou mas voce confirmou root pela CLI.',
      onConfirm: async () => {
        setConfirmModal(null)
        await callApi(
          'manual_root_ack',
          `/api/v1/devices/${encodeURIComponent(serial)}/setup/manual-root-ack`,
          'POST',
        )
        await fetchState()
      },
    })
  }, [callApi, serial, fetchState])

  const runCreateUsers = useCallback(async () => {
    const r = await callApi(
      'create_users',
      `/api/v1/devices/${encodeURIComponent(serial)}/setup/create-users`,
      'POST',
      { users: users.map((u) => ({ uid: u.uid, name: u.name })) },
    )
    const data = r.data as {
      results?: Array<{
        requested_name: string
        uid?: number
        created: boolean
        already_existed: boolean
        error?: string
      }>
      error?: string
      detail?: string
    }
    if (!r.ok) {
      setStepResult((p) => ({
        ...p,
        create_users: data.detail || data.error || 'Falha ao criar usuarios.',
      }))
    } else if (data.results) {
      const summary = data.results
        .map(
          (x) =>
            `${x.requested_name}: ${
              x.created
                ? `criado uid=${x.uid}`
                : x.already_existed
                  ? 'ja existia'
                  : `erro (${x.error || 'desconhecido'})`
            }`,
        )
        .join('\n')
      setStepResult((p) => ({ ...p, create_users: summary }))
    }
    await fetchState()
  }, [callApi, serial, users, fetchState])

  const runBypassWizard = useCallback(
    (uid: number) => {
      setConfirmModal({
        title: `Bypass do Setup Wizard em P${uid}?`,
        body:
          'Esta acao desabilita pacotes do Setup Wizard e marca setup-complete ' +
          'para esse profile. Um profile mal configurado pode ficar dificil de ' +
          'recuperar.  So execute apos confirmar que o profile foi criado e o ' +
          'fluxo do wizard padrao nao esta funcionando.',
        onConfirm: async () => {
          setConfirmModal(null)
          const r = await callApi(
            `bypass_${uid}`,
            `/api/v1/devices/${encodeURIComponent(
              serial,
            )}/profiles/${uid}/bypass-setup-wizard`,
            'POST',
            { force: true },
          )
          const data = r.data as { now_running?: boolean; error?: string }
          setStepResult((p) => ({
            ...p,
            [`bypass_${uid}`]: r.ok
              ? `P${uid} agora rodando: ${data.now_running ? 'sim' : 'nao'}`
              : data.error || 'falha no bypass',
          }))
          await fetchState()
        },
      })
    },
    [callApi, serial, fetchState],
  )

  const runInstallWa = useCallback(async () => {
    const r = await callApi(
      'install_wa',
      `/api/v1/devices/${encodeURIComponent(serial)}/setup/install-wa-per-user`,
      'POST',
      {},
    )
    const data = r.data as {
      results?: Array<{ uid: number; package_name: string; ok: boolean }>
      error?: string
      detail?: string
    }
    if (!r.ok) {
      setStepResult((p) => ({
        ...p,
        install_wa: data.detail || data.error || 'Falha ao propagar WA.',
      }))
    } else if (data.results) {
      const ok = data.results.filter((x) => x.ok).length
      setStepResult((p) => ({
        ...p,
        install_wa: `${ok}/${data.results!.length} (uid x package) instalados.`,
      }))
    }
    await fetchState()
  }, [callApi, serial, fetchState])

  const runLaunchWa = useCallback(
    async (uid: number) => {
      const r = await callApi(
        `launch_${uid}`,
        `/api/v1/devices/${encodeURIComponent(
          serial,
        )}/profiles/${uid}/launch-wa`,
        'POST',
        { package_name: 'com.whatsapp' },
      )
      const data = r.data as { ok?: boolean; error?: string; hint?: string }
      setStepResult((p) => ({
        ...p,
        [`launch_${uid}`]: r.ok
          ? `WhatsApp aberto em P${uid} - operador: cole o numero e digite o codigo SMS no device.`
          : data.hint || data.error || 'Falha ao abrir WA.',
      }))
    },
    [callApi, serial],
  )

  const runMarkRegistered = useCallback(
    async (uid: number) => {
      const phone = (hitlPhone[uid] || '').trim()
      const body: { uid: number; phone_number?: string } = { uid }
      if (phone.length >= 8) body.phone_number = phone
      const r = await callApi(
        `register_${uid}`,
        `/api/v1/devices/${encodeURIComponent(serial)}/setup/mark-registered`,
        'POST',
        body,
      )
      if (r.ok) {
        // Trigger an extract pass so the chip table reflects reality.
        await callApi(
          `extract_${uid}`,
          `/api/v1/devices/${encodeURIComponent(serial)}/extract-phones-root`,
          'POST',
        )
        setStepResult((p) => ({
          ...p,
          [`register_${uid}`]: `P${uid} marcado como registrado.`,
        }))
      } else {
        const data = r.data as { error?: string }
        setStepResult((p) => ({
          ...p,
          [`register_${uid}`]: data.error || 'falha ao marcar registrado',
        }))
      }
      await fetchState()
    },
    [callApi, serial, hitlPhone, fetchState],
  )

  const runFinalize = useCallback(async () => {
    const r = await callApi(
      'finalize',
      `/api/v1/devices/${encodeURIComponent(serial)}/setup/finalize`,
      'POST',
    )
    const data = r.data as {
      phones_persisted?: number
      chips_created?: number
      error?: string
    }
    setStepResult((p) => ({
      ...p,
      finalize: r.ok
        ? `Telefones persistidos: ${data.phones_persisted ?? 0}, chips criados: ${data.chips_created ?? 0}.`
        : data.error || 'Falha na finalizacao.',
    }))
    await fetchState()
  }, [callApi, serial, fetchState])

  if (loading) {
    return (
      <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-6 flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
        <span className="text-sm text-zinc-400">Carregando wizard...</span>
      </div>
    )
  }

  if (error || !state) {
    return (
      <div className="rounded-lg bg-red-900/20 border border-red-700/40 p-4 text-sm text-red-300">
        {error || 'Falha ao carregar estado do wizard.'}
      </div>
    )
  }

  const usersCount = Object.keys(state.users_created).length
  const bypassedCount = Object.keys(state.bypassed_profiles).length
  const installedCount = Object.keys(state.wa_installed_profiles).length
  const registeredCount = Object.keys(state.wa_registered_profiles).length

  const stepStatus = (id: StepId): 'done' | 'active' | 'pending' => {
    const order: StepId[] = [
      'root_check',
      'create_users',
      'bypass_setup_wizard',
      'install_wa',
      'register_wa',
      'finalize',
    ]
    const isDone =
      (id === 'root_check' && state.root_done) ||
      (id === 'create_users' && usersCount > 0) ||
      (id === 'bypass_setup_wizard' && bypassedCount > 0) ||
      (id === 'install_wa' && installedCount > 0) ||
      (id === 'register_wa' && registeredCount > 0) ||
      (id === 'finalize' && state.extraction_complete)
    if (isDone) return 'done'
    return id === activeStep
      ? 'active'
      : order.indexOf(id) < order.indexOf(activeStep)
        ? 'done'
        : 'pending'
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between rounded-lg bg-zinc-900 border border-zinc-800 p-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-emerald-400" />
            Setup Wizard
          </h2>
          <p className="text-xs text-zinc-500 mt-1">
            Reproduzir setup do POCO #1 (root + multi-user + WA) em{' '}
            <span className="font-mono text-zinc-300">{escapeHtml(serial)}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchState}
            className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 flex items-center gap-1"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Atualizar
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
            >
              Fechar
            </button>
          )}
        </div>
      </header>

      {/* ── Step 1: Root check ───────────────────────────────────────── */}
      <StepCard
        index={1}
        title="Verificar root"
        icon={state.root_done ? ShieldCheck : ShieldAlert}
        status={stepStatus('root_check')}
        accent={state.root_done ? 'emerald' : 'amber'}
      >
        <p className="text-sm text-zinc-400">
          Confirma se <code className="text-emerald-300">su -c id</code> retorna
          uid=0 no dispositivo. Se nao retornar, siga{' '}
          <code className="text-zinc-300">
            docs/devices/poco-c71-root-procedure.md
          </code>{' '}
          para rootear (Magisk 28.1 + PIF v16 + Zygisk-Assistant 2.1.4).
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          <button
            disabled={actionLoading === 'root_check'}
            onClick={runRootCheck}
            className="text-sm px-3 py-1.5 rounded bg-emerald-700/40 hover:bg-emerald-700/60 text-emerald-100 disabled:opacity-50"
          >
            {actionLoading === 'root_check' ? 'Verificando...' : 'Verificar root'}
          </button>
          {!state.root_done && (
            <button
              onClick={runManualRootAck}
              className="text-sm px-3 py-1.5 rounded bg-amber-700/30 hover:bg-amber-700/50 text-amber-100"
            >
              Ja rooteado manualmente
            </button>
          )}
        </div>
        {stepResult.root_check && (
          <pre className="text-xs text-zinc-400 bg-zinc-950 border border-zinc-800 rounded p-2 mt-3 whitespace-pre-wrap">
            {stepResult.root_check}
          </pre>
        )}
      </StepCard>

      {/* ── Step 2: Create users ─────────────────────────────────────── */}
      <StepCard
        index={2}
        title="Criar usuarios secundarios"
        icon={Users}
        status={stepStatus('create_users')}
        accent={usersCount > 0 ? 'emerald' : 'zinc'}
        disabled={!state.root_done}
        disabledReason="Conclua a verificacao de root antes."
      >
        <div className="space-y-3">
          <p className="text-sm text-zinc-400">
            Cria usuarios secundarios via{' '}
            <code className="text-emerald-300">cmd user create-user</code> (root).
            O Android atribui o uid sequencialmente; nomes sao apenas rotulos
            para o operador.
          </p>
          <div className="space-y-2">
            {users.map((u, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <input
                  type="number"
                  value={u.uid}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setUsers((prev) =>
                      prev.map((x, idx) => (idx === i ? { ...x, uid: v } : x)),
                    )
                  }}
                  className="w-16 rounded bg-zinc-950 border border-zinc-800 px-2 py-1 text-xs text-zinc-200"
                />
                <input
                  value={u.name}
                  onChange={(e) => {
                    const v = e.target.value
                    setUsers((prev) =>
                      prev.map((x, idx) => (idx === i ? { ...x, name: v } : x)),
                    )
                  }}
                  className="flex-1 rounded bg-zinc-950 border border-zinc-800 px-2 py-1 text-xs text-zinc-200 font-mono"
                />
                <span
                  className="text-xs text-zinc-500 w-32"
                  title={state.users_created[String(u.uid)] ?? ''}
                >
                  {state.users_created[String(u.uid)]
                    ? `ok: ${escapeHtml(state.users_created[String(u.uid)])}`
                    : 'pendente'}
                </span>
              </div>
            ))}
          </div>
          <button
            disabled={!state.root_done || actionLoading === 'create_users'}
            onClick={runCreateUsers}
            className="text-sm px-3 py-1.5 rounded bg-emerald-700/40 hover:bg-emerald-700/60 text-emerald-100 disabled:opacity-50"
          >
            {actionLoading === 'create_users' ? 'Criando...' : 'Criar usuarios'}
          </button>
          {stepResult.create_users && (
            <pre className="text-xs text-zinc-400 bg-zinc-950 border border-zinc-800 rounded p-2 whitespace-pre-wrap">
              {stepResult.create_users}
            </pre>
          )}
        </div>
      </StepCard>

      {/* ── Step 3: Bypass setup wizard per profile ──────────────────── */}
      <StepCard
        index={3}
        title="Bypass do Setup Wizard por profile"
        icon={Sparkles}
        status={stepStatus('bypass_setup_wizard')}
        accent={bypassedCount > 0 ? 'emerald' : 'zinc'}
        disabled={usersCount === 0}
        disabledReason="Crie usuarios na etapa 2 antes."
      >
        <p className="text-sm text-zinc-400">
          Para cada profile criado, executa o bypass (destrutivo - desabilita
          pacotes do wizard e marca setup-complete). Confirme antes de cada
          execucao.
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          {Object.keys(state.users_created)
            .map(Number)
            .sort((a, b) => a - b)
            .map((uid) => (
              <button
                key={uid}
                disabled={actionLoading === `bypass_${uid}`}
                onClick={() => runBypassWizard(uid)}
                className={`text-sm px-3 py-1.5 rounded ${
                  state.bypassed_profiles[String(uid)]
                    ? 'bg-emerald-700/40 text-emerald-100'
                    : 'bg-amber-700/30 hover:bg-amber-700/50 text-amber-100'
                } disabled:opacity-50`}
              >
                {state.bypassed_profiles[String(uid)] ? '+' : '!'} Bypass P{uid}
              </button>
            ))}
        </div>
        {Object.entries(stepResult)
          .filter(([k]) => k.startsWith('bypass_'))
          .map(([k, v]) => (
            <pre
              key={k}
              className="text-xs text-zinc-400 bg-zinc-950 border border-zinc-800 rounded p-2 mt-2 whitespace-pre-wrap"
            >
              {k}: {v}
            </pre>
          ))}
      </StepCard>

      {/* ── Step 4: Install WA per user ──────────────────────────────── */}
      <StepCard
        index={4}
        title="Propagar WhatsApp para os profiles"
        icon={Smartphone}
        status={stepStatus('install_wa')}
        accent={installedCount > 0 ? 'emerald' : 'zinc'}
        disabled={usersCount === 0}
        disabledReason="Crie usuarios na etapa 2 antes."
      >
        <p className="text-sm text-zinc-400">
          Roda <code className="text-emerald-300">pm install-existing</code> em
          cada (profile, pacote) para clonar o APK ja instalado em P0. Idempotente.
        </p>
        <button
          disabled={
            usersCount === 0 || actionLoading === 'install_wa'
          }
          onClick={runInstallWa}
          className="text-sm px-3 py-1.5 rounded bg-emerald-700/40 hover:bg-emerald-700/60 text-emerald-100 disabled:opacity-50 mt-3"
        >
          {actionLoading === 'install_wa'
            ? 'Propagando...'
            : 'Propagar WA para todos os users'}
        </button>
        {stepResult.install_wa && (
          <pre className="text-xs text-zinc-400 bg-zinc-950 border border-zinc-800 rounded p-2 mt-2 whitespace-pre-wrap">
            {stepResult.install_wa}
          </pre>
        )}
      </StepCard>

      {/* ── Step 5: HITL register ─────────────────────────────────────── */}
      <StepCard
        index={5}
        title="Registrar WhatsApp por profile (HITL)"
        icon={Phone}
        status={stepStatus('register_wa')}
        accent={registeredCount > 0 ? 'emerald' : 'zinc'}
        disabled={installedCount === 0}
        disabledReason="Propague o WA na etapa 4 antes."
      >
        <p className="text-sm text-zinc-400">
          Para cada profile com WA instalado, abra o app no device, insira o
          chip correspondente, faca login (QR ou SMS) e marque como registrado.
          Cada confirmacao dispara uma extracao root para popular o chip na
          aba Frota.
        </p>
        <div className="space-y-2 mt-3">
          {Object.keys(state.users_created)
            .map(Number)
            .sort((a, b) => a - b)
            .map((uid) => {
              const installed = state.wa_installed_profiles[String(uid)] ?? []
              const registered = state.wa_registered_profiles[String(uid)]
              return (
                <div
                  key={uid}
                  className="rounded border border-zinc-800 bg-zinc-950/40 p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-zinc-200">
                        P{uid}
                      </span>
                      <span className="text-xs text-zinc-500">
                        {escapeHtml(state.users_created[String(uid)] ?? '')}
                      </span>
                    </div>
                    <span
                      className={`text-xs ${
                        registered
                          ? 'text-emerald-400'
                          : installed.length > 0
                            ? 'text-amber-400'
                            : 'text-zinc-500'
                      }`}
                    >
                      {registered
                        ? `+ ${registered}`
                        : installed.length > 0
                          ? 'aguardando login'
                          : 'WA nao instalado'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500">
                    1. Insira o chip do numero correspondente ao P{uid} no slot
                    SIM ativo. 2. Clique em "Abrir WhatsApp" abaixo. 3. Faca
                    login pelo proprio device. 4. Clique em "Ja fiz login".
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      disabled={
                        installed.length === 0 ||
                        actionLoading === `launch_${uid}`
                      }
                      onClick={() => runLaunchWa(uid)}
                      className="text-xs px-2 py-1 rounded bg-emerald-700/40 hover:bg-emerald-700/60 text-emerald-100 disabled:opacity-50"
                    >
                      Abrir WhatsApp
                    </button>
                    <input
                      type="tel"
                      placeholder="+55 43 99193-8235 (opcional)"
                      value={hitlPhone[uid] ?? ''}
                      onChange={(e) =>
                        setHitlPhone((p) => ({ ...p, [uid]: e.target.value }))
                      }
                      className="rounded bg-zinc-950 border border-zinc-800 px-2 py-1 text-xs text-zinc-200 font-mono w-48"
                    />
                    <button
                      disabled={actionLoading === `register_${uid}`}
                      onClick={() => runMarkRegistered(uid)}
                      className="text-xs px-2 py-1 rounded bg-emerald-700/40 hover:bg-emerald-700/60 text-emerald-100 disabled:opacity-50"
                    >
                      Ja fiz login
                    </button>
                  </div>
                  {stepResult[`launch_${uid}`] && (
                    <p className="text-xs text-zinc-400 italic">
                      {stepResult[`launch_${uid}`]}
                    </p>
                  )}
                  {stepResult[`register_${uid}`] && (
                    <p className="text-xs text-emerald-400">
                      {stepResult[`register_${uid}`]}
                    </p>
                  )}
                </div>
              )
            })}
        </div>
      </StepCard>

      {/* ── Step 6: Finalize ─────────────────────────────────────────── */}
      <StepCard
        index={6}
        title="Finalizar e verificar chips"
        icon={CheckCircle2}
        status={stepStatus('finalize')}
        accent={state.extraction_complete ? 'emerald' : 'zinc'}
        disabled={registeredCount === 0}
        disabledReason="Marque pelo menos um profile como registrado antes."
      >
        <p className="text-sm text-zinc-400">
          Roda a extracao root final e popula a tabela de chips. Verifique em{' '}
          <code className="text-zinc-300">/admin/frota</code> apos concluir.
        </p>
        <button
          disabled={registeredCount === 0 || actionLoading === 'finalize'}
          onClick={runFinalize}
          className="text-sm px-3 py-1.5 rounded bg-emerald-700/40 hover:bg-emerald-700/60 text-emerald-100 disabled:opacity-50 mt-3"
        >
          {actionLoading === 'finalize' ? 'Finalizando...' : 'Finalizar'}
        </button>
        {stepResult.finalize && (
          <pre className="text-xs text-zinc-400 bg-zinc-950 border border-zinc-800 rounded p-2 mt-2 whitespace-pre-wrap">
            {stepResult.finalize}
          </pre>
        )}
      </StepCard>

      {/* ── Confirmation modal (destructive operations) ──────────────── */}
      {confirmModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-lg bg-zinc-900 border border-amber-700/40 p-5 shadow-xl">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5" />
              <div className="space-y-2 flex-1">
                <h3 className="text-sm font-semibold text-zinc-100">
                  {confirmModal.title}
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed">
                  {confirmModal.body}
                </p>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => setConfirmModal(null)}
                    className="text-xs px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={confirmModal.onConfirm}
                    className="text-xs px-3 py-1.5 rounded bg-amber-700/40 hover:bg-amber-700/60 text-amber-100"
                  >
                    Confirmar
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Step card primitive ────────────────────────────────────────────────────

interface StepCardProps {
  index: number
  title: string
  icon: typeof CheckCircle2
  status: 'done' | 'active' | 'pending'
  accent: 'emerald' | 'amber' | 'zinc'
  disabled?: boolean
  disabledReason?: string
  children: React.ReactNode
}

function StepCard({
  index,
  title,
  icon: Icon,
  status,
  accent,
  disabled,
  disabledReason,
  children,
}: StepCardProps) {
  const accentBorder =
    accent === 'emerald'
      ? 'border-emerald-700/40'
      : accent === 'amber'
        ? 'border-amber-700/40'
        : 'border-zinc-800'
  return (
    <section
      className={`rounded-lg border ${accentBorder} bg-zinc-900 p-4 transition ${disabled ? 'opacity-60' : ''}`}
      aria-labelledby={`wizard-step-${index}`}
    >
      <header className="flex items-center justify-between mb-3">
        <h3
          id={`wizard-step-${index}`}
          className="flex items-center gap-2 text-sm font-semibold text-zinc-100"
        >
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 text-xs text-zinc-400">
            {index}
          </span>
          <Icon className="h-4 w-4 text-zinc-300" />
          {title}
        </h3>
        <span className="flex items-center gap-1 text-xs">
          {status === 'done' ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-emerald-400">concluido</span>
            </>
          ) : status === 'active' ? (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-amber-400">em andamento</span>
            </>
          ) : (
            <>
              <Circle className="h-3.5 w-3.5 text-zinc-600" />
              <span className="text-zinc-500">pendente</span>
            </>
          )}
        </span>
      </header>
      {disabled && disabledReason && (
        <p className="text-xs text-zinc-500 italic mb-2">{disabledReason}</p>
      )}
      <div className={disabled ? 'pointer-events-none' : ''}>{children}</div>
    </section>
  )
}
