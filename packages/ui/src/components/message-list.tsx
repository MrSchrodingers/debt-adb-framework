import { CheckCircle, Clock, Loader, AlertCircle, Lock } from 'lucide-react'
import type { Message } from '../types'

const statusConfig: Record<string, { icon: typeof Clock; color: string; bg: string }> = {
  queued: { icon: Clock, color: 'text-zinc-400', bg: 'bg-zinc-800' },
  locked: { icon: Lock, color: 'text-blue-400', bg: 'bg-blue-500/10' },
  sending: { icon: Loader, color: 'text-amber-400', bg: 'bg-amber-500/10' },
  sent: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  failed: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-500/10' },
}

export function MessageList({ messages }: { messages: Message[] }) {
  if (messages.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <p className="text-sm text-zinc-500">Nenhuma mensagem na fila</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800/40 flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-300">Fila de Mensagens</h3>
        <span className="text-xs text-zinc-600">{messages.length} mensagen{messages.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="divide-y divide-zinc-800/40">
        {messages.map((msg) => {
          const cfg = statusConfig[msg.status] ?? statusConfig.queued
          const StatusIcon = cfg.icon

          return (
            <div
              key={msg.id}
              className="px-4 py-3 flex items-center gap-4 hover:bg-zinc-800/30 transition-colors"
            >
              <div className={`rounded-lg p-1.5 ${cfg.bg}`}>
                <StatusIcon className={`h-3.5 w-3.5 ${cfg.color} ${msg.status === 'sending' ? 'animate-spin' : ''}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-xs font-mono text-zinc-400">{msg.to}</span>
                  {msg.priority <= 2 && (
                    <span className="text-xs bg-amber-500/10 text-amber-400 rounded px-1.5 py-0.5">alta</span>
                  )}
                </div>
                <p className="text-sm text-zinc-300 truncate">{msg.body}</p>
              </div>
              <div className="text-right flex-shrink-0">
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cfg.bg} ${cfg.color}`}>
                  {msg.status}
                </span>
                <p className="text-xs text-zinc-600 mt-0.5">
                  {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
