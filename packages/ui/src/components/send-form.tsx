import { useState } from 'react'
import { Send, Phone, User } from 'lucide-react'

interface SendFormProps {
  onSend: (to: string, body: string, contactName?: string) => Promise<void>
  disabled?: boolean
}

export function SendForm({ onSend, disabled }: SendFormProps) {
  const [to, setTo] = useState('5543991938235')
  const [contactName, setContactName] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return
    setSending(true)
    setError(null)
    setSuccess(false)
    try {
      await onSend(to, body, contactName.trim() || undefined)
      setBody('')
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao enviar')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 p-4">
      <h3 className="text-sm font-medium text-zinc-300 mb-3">Enviar Mensagem</h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex gap-3">
          <div className="relative w-44">
            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-600" />
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Numero"
              className="w-full rounded-lg bg-zinc-800/80 pl-9 pr-3 py-2.5 text-sm text-zinc-100 border border-zinc-700/60 font-mono focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-colors"
              disabled={disabled || sending}
            />
          </div>
          <div className="relative w-40">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-600" />
            <input
              type="text"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Nome do contato"
              className="w-full rounded-lg bg-zinc-800/80 pl-9 pr-3 py-2.5 text-sm text-zinc-100 border border-zinc-700/60 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-colors"
              disabled={disabled || sending}
            />
          </div>
          <input
            type="text"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Digite a mensagem..."
            className="flex-1 rounded-lg bg-zinc-800/80 px-4 py-2.5 text-sm text-zinc-100 border border-zinc-700/60 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-colors"
            disabled={disabled || sending}
          />
          <button
            type="submit"
            disabled={disabled || sending || !body.trim()}
            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            <Send className="h-3.5 w-3.5" />
            <span>{sending ? 'Enviando...' : 'Enviar'}</span>
          </button>
        </div>

        {error && (
          <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>
        )}
        {success && (
          <p className="text-xs text-emerald-400 bg-emerald-500/10 rounded-lg px-3 py-2">
            Mensagem enfileirada com sucesso
          </p>
        )}
        {disabled && (
          <p className="text-xs text-amber-400 bg-amber-500/10 rounded-lg px-3 py-2">
            Nenhum dispositivo online disponivel
          </p>
        )}
      </form>
    </div>
  )
}
