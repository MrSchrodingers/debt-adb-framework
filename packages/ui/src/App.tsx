import { CORE_URL } from './config'

export function App() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <h1 className="text-2xl font-bold">Dispatch</h1>
      <p className="text-zinc-400 mt-2">ADB WhatsApp Orchestrator</p>
      <p className="text-zinc-500 text-sm mt-4">Core: {CORE_URL}</p>
    </div>
  )
}
