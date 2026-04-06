import { useEffect, useState } from 'react'
import type { Message } from '../types'
import { formatRelativeTime } from '../utils/time'

const statusStyles: Record<string, string> = {
  queued: 'text-zinc-400 bg-zinc-800',
  locked: 'text-blue-400 bg-blue-950',
  sending: 'text-yellow-400 bg-yellow-950',
  sent: 'text-emerald-400 bg-emerald-950',
  failed: 'text-red-400 bg-red-950',
}

export function MessageList({ messages }: { messages: Message[] }) {
  // Tick counter to force re-render every 30s for relative timestamps
  const [, setTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(interval)
  }, [])

  if (messages.length === 0) {
    return <p className="text-zinc-500 text-sm">No messages in queue.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-zinc-500">
            <th className="pb-2 pr-4">To</th>
            <th className="pb-2 pr-4">Body</th>
            <th className="pb-2 pr-4">Status</th>
            <th className="pb-2 pr-4">Priority</th>
            <th className="pb-2">Created</th>
          </tr>
        </thead>
        <tbody>
          {messages.map((msg) => (
            <tr key={msg.id} className="border-b border-zinc-800/50">
              <td className="py-2 pr-4 font-mono text-xs">{msg.to}</td>
              <td className="py-2 pr-4 max-w-xs truncate">{msg.body}</td>
              <td className="py-2 pr-4">
                <span
                  className={`rounded px-2 py-0.5 text-xs ${statusStyles[msg.status] ?? ''}`}
                >
                  {msg.status}
                </span>
              </td>
              <td className="py-2 pr-4 text-zinc-500">{msg.priority}</td>
              <td className="py-2 text-xs text-zinc-500" title={new Date(msg.createdAt).toLocaleString()}>
                {formatRelativeTime(msg.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
