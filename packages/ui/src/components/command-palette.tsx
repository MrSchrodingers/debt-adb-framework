/**
 * CommandPalette — Cmd-K / Ctrl-K fuzzy command launcher.
 *
 * Uses cmdk's CommandDialog (Radix Dialog-backed) with manual `open` state.
 * The parent passes `open`/`onClose` so the Cmd-K keydown listener can live
 * in App.tsx without prop-drilling the dialog internals.
 *
 * Pattern: each "dynamic" command (goto-device, rotate-key…) shows an inline
 * sub-prompt once selected: the list is replaced with a text input + async
 * suggestions.  Static commands execute immediately on selection.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from 'cmdk'
import {
  Monitor,
  MessageSquare,
  Send,
  Key,
  RefreshCw,
  Moon,
  Download,
  Activity,
  LogOut,
  Loader2,
  ChevronRight,
} from 'lucide-react'
import {
  COMMANDS,
  GROUP_LABELS,
  searchDevices,
  searchMessages,
  fetchPluginNames,
  executeRotateKey,
  executeSendTest,
  type CommandContext,
  type CommandDef,
  type DeviceSuggestion,
  type MessageSuggestion,
} from '../lib/commands'

// ── Icon map ───────────────────────────────────────────────────────────────

const ICONS: Record<string, typeof Monitor> = {
  'goto-device': Monitor,
  'open-message': MessageSquare,
  'send-test': Send,
  'rotate-plugin-key': Key,
  'restart-core': RefreshCw,
  'toggle-theme': Moon,
  'export-csv': Download,
  'open-jaeger': Activity,
  'logout': LogOut,
}

// ── Sub-prompt state ───────────────────────────────────────────────────────

type SubMode =
  | { type: 'device'; query: string; results: DeviceSuggestion[]; loading: boolean }
  | { type: 'message'; query: string; results: MessageSuggestion[]; loading: boolean }
  | { type: 'rotate-key'; query: string; results: string[]; loading: boolean }
  | { type: 'send-test'; phone: string }
  | { type: 'restart-confirm' }
  | null

// ── Component ──────────────────────────────────────────────────────────────

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  ctx: CommandContext
}

export function CommandPalette({ open, onClose, ctx }: CommandPaletteProps) {
  const [subMode, setSubMode] = useState<SubMode>(null)
  const [mainSearch, setMainSearch] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reset on close
  useEffect(() => {
    if (!open) {
      setSubMode(null)
      setMainSearch('')
    }
  }, [open])

  const close = useCallback(() => {
    onClose()
  }, [onClose])

  // ── Debounced autocomplete for sub-modes ─────────────────────────────────

  const runDeviceSearch = useCallback((q: string) => {
    setSubMode({ type: 'device', query: q, results: [], loading: true })
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const results = await searchDevices(q)
      setSubMode((prev) =>
        prev?.type === 'device' ? { ...prev, results, loading: false } : prev,
      )
    }, 220)
  }, [])

  const runMessageSearch = useCallback((q: string) => {
    setSubMode({ type: 'message', query: q, results: [], loading: true })
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const results = await searchMessages(q)
      setSubMode((prev) =>
        prev?.type === 'message' ? { ...prev, results, loading: false } : prev,
      )
    }, 220)
  }, [])

  const runPluginSearch = useCallback((q: string) => {
    setSubMode({ type: 'rotate-key', query: q, results: [], loading: true })
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const all = await fetchPluginNames()
      const results = q
        ? all.filter((n) => n.toLowerCase().includes(q.toLowerCase()))
        : all
      setSubMode((prev) =>
        prev?.type === 'rotate-key' ? { ...prev, results, loading: false } : prev,
      )
    }, 220)
  }, [])

  // ── Command select handler ────────────────────────────────────────────────

  const handleSelect = useCallback(
    async (cmd: CommandDef) => {
      switch (cmd.id) {
        case 'goto-device':
          runDeviceSearch('')
          break
        case 'open-message':
          runMessageSearch('')
          break
        case 'send-test':
          setSubMode({ type: 'send-test', phone: '' })
          break
        case 'rotate-plugin-key':
          runPluginSearch('')
          break
        case 'restart-core':
          setSubMode({ type: 'restart-confirm' })
          break
        case 'toggle-theme': {
          const isDark = document.documentElement.classList.contains('dark') ||
            !document.documentElement.classList.contains('light')
          document.documentElement.classList.toggle('dark', !isDark)
          document.documentElement.classList.toggle('light', isDark)
          try { localStorage.setItem('dispatch.theme', isDark ? 'light' : 'dark') } catch { /* ignore */ }
          ctx.addToast('info', `Tema: ${isDark ? 'light' : 'dark'}`)
          close()
          break
        }
        case 'export-csv':
          ctx.exportCurrentView()
          ctx.addToast('info', 'Exportação CSV iniciada.')
          close()
          break
        case 'open-jaeger':
          window.open(`${window.location.origin}/admin/jaeger`, '_blank')
          close()
          break
        case 'logout':
          ctx.logout()
          close()
          break
      }
    },
    [runDeviceSearch, runMessageSearch, runPluginSearch, ctx, close],
  )

  // ── Grouped commands for main view ────────────────────────────────────────

  const groups = ['navigation', 'actions', 'settings', 'developer'] as const
  const grouped = groups.map((g) => ({
    group: g,
    label: GROUP_LABELS[g],
    items: COMMANDS.filter((c) => c.group === g),
  }))

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => { if (!v) close() }}
      label="Command palette"
      className="dispatch-cmdk"
      overlayClassName="dispatch-cmdk-overlay"
      contentClassName="dispatch-cmdk-content"
    >
      <style>{CMDK_STYLES}</style>

      {subMode === null && (
        <>
          <CommandInput
            placeholder="Digite um comando…"
            value={mainSearch}
            onValueChange={setMainSearch}
            className="dispatch-cmdk-input"
          />
          <CommandList className="dispatch-cmdk-list">
            <CommandEmpty className="dispatch-cmdk-empty">
              Nenhum resultado para "{mainSearch}"
            </CommandEmpty>
            {grouped.map((g, gi) => (
              <span key={g.group}>
                {gi > 0 && <CommandSeparator className="dispatch-cmdk-sep" />}
                <CommandGroup
                  heading={g.label}
                  className="dispatch-cmdk-group"
                >
                  {g.items.map((cmd) => {
                    const Icon = ICONS[cmd.id] ?? ChevronRight
                    return (
                      <CommandItem
                        key={cmd.id}
                        value={[cmd.label, ...(cmd.keywords ?? [])].join(' ')}
                        onSelect={() => handleSelect(cmd)}
                        className="dispatch-cmdk-item"
                      >
                        <Icon className="dispatch-cmdk-item-icon" />
                        <span>{cmd.label}</span>
                        {cmd.dynamic && (
                          <ChevronRight className="dispatch-cmdk-item-chevron" />
                        )}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </span>
            ))}
          </CommandList>
        </>
      )}

      {subMode?.type === 'device' && (
        <DeviceSubMode
          subMode={subMode}
          onQueryChange={runDeviceSearch}
          onSelect={(serial) => {
            ctx.navigateTo('devices')
            ctx.onSelectDevice?.(serial)
            ctx.addToast('info', `Device ${serial} selecionado.`)
            close()
          }}
          onBack={() => setSubMode(null)}
        />
      )}

      {subMode?.type === 'message' && (
        <MessageSubMode
          subMode={subMode}
          onQueryChange={runMessageSearch}
          onSelect={(msg) => {
            ctx.navigateTo('queue')
            ctx.addToast('info', `Mensagem ${msg.id.slice(0, 8)}… — para ${msg.to}`)
            close()
          }}
          onBack={() => setSubMode(null)}
        />
      )}

      {subMode?.type === 'rotate-key' && (
        <RotateKeySubMode
          subMode={subMode}
          onQueryChange={runPluginSearch}
          onSelect={async (name) => {
            await executeRotateKey(name, ctx.addToast)
            close()
          }}
          onBack={() => setSubMode(null)}
        />
      )}

      {subMode?.type === 'send-test' && (
        <SendTestSubMode
          phone={subMode.phone}
          onPhoneChange={(phone) => setSubMode({ type: 'send-test', phone })}
          onConfirm={async () => {
            await executeSendTest(subMode.phone, ctx.addToast)
            close()
          }}
          onBack={() => setSubMode(null)}
        />
      )}

      {subMode?.type === 'restart-confirm' && (
        <RestartConfirmSubMode
          onConfirm={() => {
            ctx.addToast('info', 'Reinicialização solicitada (operação pendente de integração ops).')
            close()
          }}
          onBack={() => setSubMode(null)}
        />
      )}
    </CommandDialog>
  )
}

// ── Sub-mode components ────────────────────────────────────────────────────

function DeviceSubMode({
  subMode,
  onQueryChange,
  onSelect,
  onBack,
}: {
  subMode: Extract<SubMode, { type: 'device' }>
  onQueryChange: (q: string) => void
  onSelect: (serial: string) => void
  onBack: () => void
}) {
  return (
    <>
      <div className="dispatch-cmdk-sub-header">
        <button className="dispatch-cmdk-back" onClick={onBack}>← voltar</button>
        <span className="dispatch-cmdk-sub-label">Ir para device</span>
      </div>
      <CommandInput
        placeholder="Serial do device…"
        value={subMode.query}
        onValueChange={onQueryChange}
        autoFocus
        className="dispatch-cmdk-input"
      />
      <CommandList className="dispatch-cmdk-list">
        {subMode.loading && <LoadingRow />}
        {!subMode.loading && subMode.results.length === 0 && subMode.query && (
          <CommandEmpty className="dispatch-cmdk-empty">Nenhum device encontrado.</CommandEmpty>
        )}
        {subMode.results.map((d) => (
          <CommandItem
            key={d.serial}
            value={d.serial}
            onSelect={() => onSelect(d.serial)}
            className="dispatch-cmdk-item"
          >
            <Monitor className="dispatch-cmdk-item-icon" />
            <span className="font-mono text-sm">{d.serial}</span>
            <span className={`ml-auto text-xs ${d.status === 'online' ? 'text-emerald-400' : 'text-zinc-500'}`}>
              {d.status}
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </>
  )
}

function MessageSubMode({
  subMode,
  onQueryChange,
  onSelect,
  onBack,
}: {
  subMode: Extract<SubMode, { type: 'message' }>
  onQueryChange: (q: string) => void
  onSelect: (msg: MessageSuggestion) => void
  onBack: () => void
}) {
  return (
    <>
      <div className="dispatch-cmdk-sub-header">
        <button className="dispatch-cmdk-back" onClick={onBack}>← voltar</button>
        <span className="dispatch-cmdk-sub-label">Abrir mensagem</span>
      </div>
      <CommandInput
        placeholder="ID ou número de destino…"
        value={subMode.query}
        onValueChange={onQueryChange}
        autoFocus
        className="dispatch-cmdk-input"
      />
      <CommandList className="dispatch-cmdk-list">
        {subMode.loading && <LoadingRow />}
        {!subMode.loading && subMode.results.length === 0 && subMode.query && (
          <CommandEmpty className="dispatch-cmdk-empty">Nenhuma mensagem encontrada.</CommandEmpty>
        )}
        {subMode.results.map((m) => (
          <CommandItem
            key={m.id}
            value={`${m.id} ${m.to}`}
            onSelect={() => onSelect(m)}
            className="dispatch-cmdk-item"
          >
            <MessageSquare className="dispatch-cmdk-item-icon" />
            <span className="font-mono text-xs">{m.id.slice(0, 12)}…</span>
            <span className="ml-2 text-zinc-400 text-xs">→ {m.to}</span>
            <span className="ml-auto text-xs text-zinc-500">{m.status}</span>
          </CommandItem>
        ))}
      </CommandList>
    </>
  )
}

function RotateKeySubMode({
  subMode,
  onQueryChange,
  onSelect,
  onBack,
}: {
  subMode: Extract<SubMode, { type: 'rotate-key' }>
  onQueryChange: (q: string) => void
  onSelect: (name: string) => Promise<void>
  onBack: () => void
}) {
  return (
    <>
      <div className="dispatch-cmdk-sub-header">
        <button className="dispatch-cmdk-back" onClick={onBack}>← voltar</button>
        <span className="dispatch-cmdk-sub-label">Rotacionar API key</span>
      </div>
      <CommandInput
        placeholder="Nome do plugin…"
        value={subMode.query}
        onValueChange={onQueryChange}
        autoFocus
        className="dispatch-cmdk-input"
      />
      <CommandList className="dispatch-cmdk-list">
        {subMode.loading && <LoadingRow />}
        {!subMode.loading && subMode.results.length === 0 && (
          <CommandEmpty className="dispatch-cmdk-empty">Nenhum plugin encontrado.</CommandEmpty>
        )}
        {subMode.results.map((name) => (
          <CommandItem
            key={name}
            value={name}
            onSelect={() => onSelect(name)}
            className="dispatch-cmdk-item"
          >
            <Key className="dispatch-cmdk-item-icon" />
            <span>{name}</span>
          </CommandItem>
        ))}
      </CommandList>
    </>
  )
}

function SendTestSubMode({
  phone,
  onPhoneChange,
  onConfirm,
  onBack,
}: {
  phone: string
  onPhoneChange: (v: string) => void
  onConfirm: () => Promise<void>
  onBack: () => void
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onConfirm()
    if (e.key === 'Escape') onBack()
  }

  return (
    <div className="dispatch-cmdk-send-form">
      <div className="dispatch-cmdk-sub-header">
        <button className="dispatch-cmdk-back" onClick={onBack}>← voltar</button>
        <span className="dispatch-cmdk-sub-label">Enviar mensagem teste</span>
      </div>
      <div className="px-4 pb-4 space-y-3">
        <p className="text-xs text-zinc-400">Número de destino (somente dígitos, 10–15 chars):</p>
        <input
          type="text"
          autoFocus
          className="dispatch-cmdk-text-input"
          placeholder="5543999887766"
          value={phone}
          onChange={(e) => onPhoneChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="dispatch-cmdk-confirm-btn"
          onClick={onConfirm}
          disabled={!/^\d{10,15}$/.test(phone)}
        >
          Enviar
        </button>
      </div>
    </div>
  )
}

function RestartConfirmSubMode({
  onConfirm,
  onBack,
}: {
  onConfirm: () => void
  onBack: () => void
}) {
  return (
    <div className="dispatch-cmdk-send-form">
      <div className="dispatch-cmdk-sub-header">
        <button className="dispatch-cmdk-back" onClick={onBack}>← voltar</button>
        <span className="dispatch-cmdk-sub-label">Reiniciar core</span>
      </div>
      <div className="px-4 pb-4 space-y-3">
        <p className="text-sm text-zinc-300">
          Confirmar reinicialização do core?<br />
          <span className="text-xs text-zinc-500">
            (Endpoint de integração pendente — operação registrada como noop.)
          </span>
        </p>
        <div className="flex gap-2">
          <button className="dispatch-cmdk-confirm-btn" onClick={onConfirm}>
            Confirmar
          </button>
          <button className="dispatch-cmdk-cancel-btn" onClick={onBack}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}

function LoadingRow() {
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-zinc-500 text-sm">
      <Loader2 className="h-3 w-3 animate-spin" />
      <span>Buscando…</span>
    </div>
  )
}

// ── Inline styles (avoids Tailwind purge issues with dynamic cmdk classes) ─

const CMDK_STYLES = `
  .dispatch-cmdk-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.65);
    z-index: 9998;
    backdrop-filter: blur(2px);
  }

  .dispatch-cmdk-content {
    position: fixed;
    top: 20vh;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    width: min(640px, 92vw);
    background: #18181b;
    border: 1px solid #3f3f46;
    border-radius: 12px;
    box-shadow: 0 24px 80px rgba(0,0,0,0.7);
    overflow: hidden;
  }

  .dispatch-cmdk-input {
    width: 100%;
    padding: 14px 16px;
    font-size: 15px;
    color: #f4f4f5;
    background: transparent;
    border: none;
    border-bottom: 1px solid #3f3f46;
    outline: none;
  }
  .dispatch-cmdk-input::placeholder { color: #71717a; }

  .dispatch-cmdk-list {
    max-height: 360px;
    overflow-y: auto;
    padding: 6px 0;
  }

  .dispatch-cmdk-empty {
    padding: 20px 16px;
    text-align: center;
    color: #71717a;
    font-size: 13px;
  }

  .dispatch-cmdk-group [cmdk-group-heading] {
    padding: 6px 12px 2px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #52525b;
  }

  .dispatch-cmdk-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 14px;
    font-size: 13px;
    color: #e4e4e7;
    cursor: pointer;
    border-radius: 6px;
    margin: 1px 6px;
    transition: background 0.1s;
  }
  .dispatch-cmdk-item[aria-selected="true"],
  .dispatch-cmdk-item[data-selected="true"] {
    background: #27272a;
    color: #fff;
  }

  .dispatch-cmdk-item-icon {
    width: 14px;
    height: 14px;
    color: #71717a;
    flex-shrink: 0;
  }

  .dispatch-cmdk-item-chevron {
    width: 12px;
    height: 12px;
    color: #52525b;
    margin-left: auto;
  }

  .dispatch-cmdk-sep {
    height: 1px;
    background: #27272a;
    margin: 4px 0;
  }

  .dispatch-cmdk-sub-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-bottom: 1px solid #3f3f46;
  }

  .dispatch-cmdk-back {
    font-size: 11px;
    color: #71717a;
    background: none;
    border: 1px solid #3f3f46;
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .dispatch-cmdk-back:hover { color: #a1a1aa; border-color: #52525b; }

  .dispatch-cmdk-sub-label {
    font-size: 12px;
    color: #a1a1aa;
    font-weight: 500;
  }

  .dispatch-cmdk-send-form {
    /* wrapper for freeform sub-mode panels */
  }

  .dispatch-cmdk-text-input {
    width: 100%;
    padding: 8px 12px;
    font-size: 13px;
    font-family: 'JetBrains Mono', monospace;
    color: #f4f4f5;
    background: #09090b;
    border: 1px solid #3f3f46;
    border-radius: 6px;
    outline: none;
  }
  .dispatch-cmdk-text-input:focus { border-color: #71717a; }

  .dispatch-cmdk-confirm-btn {
    padding: 7px 18px;
    font-size: 13px;
    font-weight: 500;
    color: #052e16;
    background: #4ade80;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: opacity 0.1s;
  }
  .dispatch-cmdk-confirm-btn:hover { opacity: 0.85; }
  .dispatch-cmdk-confirm-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  .dispatch-cmdk-cancel-btn {
    padding: 7px 18px;
    font-size: 13px;
    font-weight: 500;
    color: #a1a1aa;
    background: #27272a;
    border: 1px solid #3f3f46;
    border-radius: 6px;
    cursor: pointer;
  }
  .dispatch-cmdk-cancel-btn:hover { background: #3f3f46; }
`
