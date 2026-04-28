/**
 * KeyboardShortcutsHelp — modal showing all registered keyboard shortcuts.
 * Opens on `?` keypress (handled in App.tsx), closes on `Esc` or the ✕ button.
 *
 * Uses react-hotkeys-hook for the `?` trigger that is delegated from App.tsx,
 * and a plain useEffect for the `Esc` close.  The parent manages `open` state.
 */

import { useEffect } from 'react'
import { X, Command, ArrowRightLeft } from 'lucide-react'

export interface KeyboardShortcutsHelpProps {
  open: boolean
  onClose: () => void
}

interface ShortcutRow {
  keys: string[]
  description: string
  group: string
}

const SHORTCUTS: ShortcutRow[] = [
  { group: 'Paleta de comandos', keys: ['⌘', 'K'], description: 'Abrir command palette' },
  { group: 'Paleta de comandos', keys: ['Ctrl', 'K'], description: 'Abrir command palette (Windows/Linux)' },
  { group: 'Navegação', keys: ['g', 'd'], description: 'Ir para Dispositivos' },
  { group: 'Navegação', keys: ['g', 'm'], description: 'Ir para Mensagens (fila)' },
  { group: 'Navegação', keys: ['g', 'a'], description: 'Ir para Auditoria' },
  { group: 'Geral', keys: ['?'], description: 'Mostrar esta tela de ajuda' },
  { group: 'Geral', keys: ['Esc'], description: 'Fechar modais' },
]

const GROUPS = Array.from(new Set(SHORTCUTS.map((s) => s.group)))

export function KeyboardShortcutsHelp({ open, onClose }: KeyboardShortcutsHelpProps) {
  // Esc closes
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[9990] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Atalhos de teclado"
    >
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/65 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-lg rounded-xl bg-zinc-900 border border-zinc-700/60 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Command className="h-4 w-4 text-zinc-400" />
            <h2 className="text-sm font-semibold text-zinc-100">Atalhos de teclado</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Shortcut table */}
        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {GROUPS.map((group) => (
            <div key={group}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500 mb-2">
                {group}
              </p>
              <div className="space-y-1">
                {SHORTCUTS.filter((s) => s.group === group).map((s, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-4 rounded-lg px-3 py-2 hover:bg-zinc-800/50"
                  >
                    <span className="text-sm text-zinc-300">{s.description}</span>
                    <KeyCombo keys={s.keys} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="border-t border-zinc-800 px-5 py-3 flex items-center gap-2 text-xs text-zinc-500">
          <ArrowRightLeft className="h-3 w-3" />
          <span>Teclas sequenciais (ex: g d) devem ser pressionadas em até 600ms</span>
        </div>
      </div>
    </div>
  )
}

function KeyCombo({ keys }: { keys: string[] }) {
  return (
    <div className="flex items-center gap-1 shrink-0">
      {keys.map((k, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-zinc-600 text-xs">+</span>}
          <kbd className="inline-flex items-center justify-center rounded bg-zinc-800 border border-zinc-700 px-2 py-0.5 text-[11px] font-mono font-medium text-zinc-200 shadow-sm min-w-[26px]">
            {k}
          </kbd>
        </span>
      ))}
    </div>
  )
}
