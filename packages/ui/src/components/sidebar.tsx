import { Smartphone, MessageSquare, Radio, AlertTriangle } from 'lucide-react'

type Tab = 'devices' | 'queue' | 'sessions'

interface SidebarProps {
  activeTab: Tab
  onTabChange: (tab: Tab) => void
  alertCount: number
}

const tabs = [
  { id: 'devices' as const, label: 'Dispositivos', icon: Smartphone },
  { id: 'queue' as const, label: 'Fila', icon: MessageSquare },
  { id: 'sessions' as const, label: 'Sessoes', icon: Radio },
]

export function Sidebar({ activeTab, onTabChange, alertCount }: SidebarProps) {
  return (
    <aside className="w-16 lg:w-52 flex-shrink-0 bg-zinc-900/50 border-r border-zinc-800/60 flex flex-col py-4">
      <div className="px-4 mb-6 hidden lg:block">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-emerald-600 flex items-center justify-center">
            <Smartphone className="h-4 w-4 text-white" />
          </div>
          <span className="text-sm font-semibold text-zinc-200">Dispatch</span>
        </div>
      </div>
      <div className="lg:hidden flex justify-center mb-4">
        <div className="h-8 w-8 rounded-lg bg-emerald-600 flex items-center justify-center">
          <Smartphone className="h-4 w-4 text-white" />
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-2">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
              activeTab === id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
            }`}
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            <span className="hidden lg:inline truncate">{label}</span>
          </button>
        ))}
      </nav>

      {alertCount > 0 && (
        <div className="px-2 mt-auto">
          <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 border border-red-500/20">
            <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0" />
            <span className="hidden lg:inline text-xs text-red-400 font-medium">
              {alertCount} alerta{alertCount > 1 ? 's' : ''}
            </span>
            <span className="lg:hidden text-xs text-red-400 font-bold">{alertCount}</span>
          </div>
        </div>
      )}
    </aside>
  )
}
