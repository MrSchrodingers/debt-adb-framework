import { useState, useRef, useEffect } from 'react'
import { Terminal, Send, Trash2 } from 'lucide-react'
import { CORE_URL } from '../config'

interface ShellTerminalProps {
  serial: string
  profileId?: number | null
}

interface HistoryEntry {
  command: string
  output: string
  error?: boolean
  timestamp: string
}

export function ShellTerminal({ serial, profileId }: ShellTerminalProps) {
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [running, setRunning] = useState(false)
  const [cmdHistory, setCmdHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const outputRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const executeCommand = async () => {
    const cmd = command.trim()
    if (!cmd) return

    setRunning(true)
    setCmdHistory((prev) => [cmd, ...prev])
    setHistoryIndex(-1)
    setCommand('')

    try {
      const res = await fetch(`${CORE_URL}/api/v1/devices/${serial}/shell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      })
      const data = await res.json()
      setHistory((prev) => [
        ...prev,
        {
          command: cmd,
          output: res.ok ? data.output : data.error,
          error: !res.ok,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        },
      ])
    } catch (err) {
      setHistory((prev) => [
        ...prev,
        {
          command: cmd,
          output: err instanceof Error ? err.message : 'Connection error',
          error: true,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        },
      ])
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [history])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      executeCommand()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (historyIndex < cmdHistory.length - 1) {
        const newIndex = historyIndex + 1
        setHistoryIndex(newIndex)
        setCommand(cmdHistory[newIndex])
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1
        setHistoryIndex(newIndex)
        setCommand(cmdHistory[newIndex])
      } else {
        setHistoryIndex(-1)
        setCommand('')
      }
    }
  }

  const userFlag = profileId != null ? ` --user ${profileId}` : ''
  const shortcuts = [
    { label: 'getprop ro.build.version.release', cmd: 'getprop ro.build.version.release' },
    { label: 'dumpsys battery', cmd: 'dumpsys battery' },
    { label: 'ps -A | grep whatsapp', cmd: 'ps -A | grep whatsapp' },
    { label: 'df -h /data', cmd: 'df -h /data' },
    ...(profileId != null ? [
      { label: `WA logs (P${profileId})`, cmd: `logcat -d -s WhatsApp | grep u${profileId}_ | tail -20` },
      { label: `pm list (P${profileId})`, cmd: `pm list packages${userFlag} | grep whatsapp` },
      { label: `am start WA (P${profileId})`, cmd: `am start${userFlag} -n com.whatsapp/com.whatsapp.Main` },
    ] : [
      { label: 'logcat WA', cmd: 'logcat -d -s WhatsApp | tail -20' },
      { label: 'ip addr', cmd: 'ip addr show wlan0' },
    ]),
  ]

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/60 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800/40 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-emerald-400" />
          <h3 className="text-sm font-medium text-zinc-300">Terminal ADB</h3>
          {profileId != null && (
            <span className="rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/30 px-2 py-0.5 text-xs font-medium">
              P{profileId}
            </span>
          )}
          <span className="text-xs text-zinc-600 font-mono">{serial.slice(0, 12)}</span>
        </div>
        <button
          onClick={() => setHistory([])}
          className="flex items-center gap-1 rounded-lg bg-zinc-800 border border-zinc-700/40 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300"
        >
          <Trash2 className="h-3 w-3" />
          Limpar
        </button>
      </div>

      {/* Quick commands */}
      <div className="px-4 py-2 border-b border-zinc-800/30 flex gap-1.5 flex-wrap">
        {shortcuts.map((s) => (
          <button
            key={s.cmd}
            onClick={() => { setCommand(s.cmd); inputRef.current?.focus() }}
            className="rounded bg-zinc-800/80 px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 transition-colors border border-zinc-700/30"
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Output */}
      <div ref={outputRef} className="h-64 overflow-y-auto p-4 font-mono text-xs space-y-3 bg-zinc-950/50">
        {history.length === 0 && (
          <p className="text-zinc-600">Digite um comando ou use os atalhos acima...</p>
        )}
        {history.map((entry, i) => (
          <div key={i}>
            <div className="flex items-center gap-2 text-zinc-500">
              <span className="text-zinc-600">{entry.timestamp}</span>
              <span className="text-emerald-400">$</span>
              <span className="text-zinc-300">{entry.command}</span>
            </div>
            <pre className={`mt-1 whitespace-pre-wrap break-all ${entry.error ? 'text-red-400' : 'text-zinc-400'}`}>
              {entry.output || '(no output)'}
            </pre>
          </div>
        ))}
        {running && (
          <div className="flex items-center gap-2 text-zinc-600">
            <span className="animate-pulse">Executando...</span>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-zinc-800/40 flex gap-2">
        <span className="text-emerald-400 font-mono text-sm py-1.5">$</span>
        <input
          ref={inputRef}
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="adb shell command..."
          disabled={running}
          className="flex-1 bg-transparent text-sm text-zinc-200 font-mono focus:outline-none placeholder:text-zinc-700 disabled:opacity-50"
        />
        <button
          onClick={executeCommand}
          disabled={running || !command.trim()}
          className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs text-white disabled:opacity-40 transition-colors"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
