import { useState } from 'react'

interface SendFormProps {
  onSend: (to: string, body: string) => Promise<void>
  disabled?: boolean
}

export function SendForm({ onSend, disabled }: SendFormProps) {
  const [to, setTo] = useState('5543991938235')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return
    setSending(true)
    try {
      await onSend(to, body)
      setBody('')
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="Phone number"
        className="rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-100 border border-zinc-700 w-40 font-mono"
        disabled={disabled || sending}
      />
      <input
        type="text"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Message body"
        className="flex-1 rounded bg-zinc-800 px-3 py-2 text-sm text-zinc-100 border border-zinc-700"
        disabled={disabled || sending}
      />
      <button
        type="submit"
        disabled={disabled || sending || !body.trim()}
        className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {sending ? 'Sending...' : 'Send'}
      </button>
    </form>
  )
}
