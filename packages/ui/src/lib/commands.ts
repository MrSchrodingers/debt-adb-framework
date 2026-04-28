/**
 * Command catalog for the Cmd-K command palette.
 *
 * Each command has a stable id, a display label, an optional group,
 * optional keywords for fuzzy matching, and an action factory that
 * receives the app-wide context and returns a callable.
 */

import { CORE_URL, authHeaders } from '../config'

// ── Types ──────────────────────────────────────────────────────────────────

export type CommandId =
  | 'goto-device'
  | 'open-message'
  | 'send-test'
  | 'rotate-plugin-key'
  | 'restart-core'
  | 'toggle-theme'
  | 'export-csv'
  | 'open-jaeger'
  | 'logout'

export interface CommandDef {
  id: CommandId
  label: string
  group: 'navigation' | 'actions' | 'settings' | 'developer'
  keywords?: string[]
  /** Static commands have no dynamic suggestions; dynamic ones produce them. */
  dynamic?: boolean
}

/** Returned by search endpoints */
export interface DeviceSuggestion {
  serial: string
  status: string
}

export interface MessageSuggestion {
  id: string
  to: string
  status: string
  createdAt: string
}

/** Context passed to action factories so they can call APIs / mutate state. */
export interface CommandContext {
  navigateTo: (tab: string) => void
  addToast: (type: 'success' | 'error' | 'warning' | 'info', msg: string) => void
  logout: () => void
  exportCurrentView: () => void
  /** Serial selected in the devices tab — used for goto-device */
  onSelectDevice?: (serial: string) => void
}

// ── Static command catalog ─────────────────────────────────────────────────

export const COMMANDS: CommandDef[] = [
  {
    id: 'goto-device',
    label: 'Ir para device…',
    group: 'navigation',
    keywords: ['device', 'dispositivo', 'serial', 'adb'],
    dynamic: true,
  },
  {
    id: 'open-message',
    label: 'Abrir mensagem…',
    group: 'navigation',
    keywords: ['message', 'mensagem', 'id', 'fila'],
    dynamic: true,
  },
  {
    id: 'send-test',
    label: 'Enviar mensagem teste…',
    group: 'actions',
    keywords: ['send', 'enviar', 'teste', 'whatsapp', 'oralsin'],
  },
  {
    id: 'rotate-plugin-key',
    label: 'Rotacionar API key do plugin…',
    group: 'actions',
    keywords: ['rotate', 'key', 'api', 'plugin', 'hmac', 'secret'],
    dynamic: true,
  },
  {
    id: 'restart-core',
    label: 'Reiniciar core',
    group: 'actions',
    keywords: ['restart', 'reiniciar', 'core', 'reload'],
  },
  {
    id: 'toggle-theme',
    label: 'Toggle dark/light',
    group: 'settings',
    keywords: ['theme', 'dark', 'light', 'modo'],
  },
  {
    id: 'export-csv',
    label: 'Exportar view atual como CSV',
    group: 'settings',
    keywords: ['export', 'csv', 'download', 'exportar'],
  },
  {
    id: 'open-jaeger',
    label: 'Abrir Jaeger trace',
    group: 'developer',
    keywords: ['jaeger', 'trace', 'otel', 'telemetry', 'tracing'],
  },
  {
    id: 'logout',
    label: 'Logout',
    group: 'settings',
    keywords: ['sair', 'desconectar', 'logout', 'exit'],
  },
]

export const GROUP_LABELS: Record<CommandDef['group'], string> = {
  navigation: 'Navegar',
  actions: 'Ações',
  settings: 'Configurações',
  developer: 'Desenvolvedor',
}

// ── Search helpers (call backend) ──────────────────────────────────────────

export async function searchDevices(q: string): Promise<DeviceSuggestion[]> {
  try {
    const res = await fetch(`${CORE_URL}/api/v1/devices/search?q=${encodeURIComponent(q)}`, {
      headers: authHeaders(),
    })
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    return Array.isArray(data) ? (data as DeviceSuggestion[]) : []
  } catch {
    return []
  }
}

export async function searchMessages(q: string): Promise<MessageSuggestion[]> {
  try {
    const res = await fetch(`${CORE_URL}/api/v1/messages/search?q=${encodeURIComponent(q)}`, {
      headers: authHeaders(),
    })
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    return Array.isArray(data) ? (data as MessageSuggestion[]) : []
  } catch {
    return []
  }
}

export async function fetchPluginNames(): Promise<string[]> {
  try {
    const res = await fetch(`${CORE_URL}/api/v1/admin/plugins`, {
      headers: authHeaders(),
    })
    if (!res.ok) return []
    const data = (await res.json()) as unknown
    if (!Array.isArray(data)) return []
    return (data as Array<{ name: string }>).map((p) => p.name)
  } catch {
    return []
  }
}

// ── Action executors ───────────────────────────────────────────────────────

export async function executeRotateKey(
  pluginName: string,
  addToast: CommandContext['addToast'],
): Promise<void> {
  try {
    const res = await fetch(`${CORE_URL}/api/v1/admin/plugins/${encodeURIComponent(pluginName)}/rotate-key`, {
      method: 'POST',
      headers: authHeaders(),
    })
    if (res.ok) {
      addToast('success', `API key do plugin "${pluginName}" rotacionada.`)
    } else {
      const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string }
      addToast('error', `Falha ao rotacionar key: ${body.error ?? res.statusText}`)
    }
  } catch {
    addToast('error', 'Erro de rede ao rotacionar key.')
  }
}

export async function executeSendTest(
  phone: string,
  addToast: CommandContext['addToast'],
): Promise<void> {
  if (!/^\d{10,15}$/.test(phone)) {
    addToast('error', 'Número inválido — use apenas dígitos (10–15).')
    return
  }
  try {
    const idempotencyKey = `palette-test-${Date.now()}`
    const res = await fetch(`${CORE_URL}/api/v1/plugins/oralsin/enqueue`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        messages: [
          {
            to: phone,
            body: '[Dispatch] Mensagem de teste via command palette.',
            idempotencyKey,
          },
        ],
      }),
    })
    if (res.ok) {
      addToast('success', `Mensagem de teste enfileirada para ${phone}.`)
    } else {
      const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string }
      addToast('warning', `Enqueue falhou (${res.status}): ${body.error ?? 'sem resposta'}. Verifique se o core está acessível.`)
    }
  } catch {
    addToast('warning', 'Core inacessível — mensagem de teste não enviada.')
  }
}
