import { Smartphone, Send, Radio, BarChart3, FileText, X, AlertTriangle } from 'lucide-react'

type TabId = 'devices' | 'queue' | 'sessions' | 'metricas' | 'auditoria'

interface SidebarProps {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  connected: boolean
  deviceCount: number
  mobileOpen: boolean
  onMobileClose: () => void
  alertCount: number
}

const NAV_ITEMS: { id: TabId; label: string; icon: typeof Smartphone }[] = [
  { id: 'devices', label: 'Dispositivos', icon: Smartphone },
  { id: 'queue', label: 'Fila', icon: Send },
  { id: 'sessions', label: 'Sessoes', icon: Radio },
  { id: 'metricas', label: 'Metricas', icon: BarChart3 },
  { id: 'auditoria', label: 'Auditoria', icon: FileText },
]

export function Sidebar({
  activeTab,
  onTabChange,
  connected,
  deviceCount,
  mobileOpen,
  onMobileClose,
  alertCount,
}: SidebarProps) {
  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={onMobileClose}
        />
      )}

      {/* Sidebar panel */}
      <aside
        className={`
          fixed z-50 top-0 left-0 h-full bg-zinc-900/95 border-r border-zinc-800
          transition-transform duration-200
          lg:static lg:translate-x-0 lg:z-auto
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
          w-56
        `}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-zinc-100">Dispatch</h1>
            <div className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
          </div>
          <button
            onClick={onMobileClose}
            className="lg:hidden rounded p-1 text-zinc-500 hover:text-zinc-300 min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="p-2 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const isActive = activeTab === item.id
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition min-h-[44px] ${
                  isActive
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        {/* Alert badge */}
        {alertCount > 0 && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-red-400" />
            <span className="text-xs font-medium text-red-400">{alertCount} alerta{alertCount !== 1 ? 's' : ''}</span>
          </div>
        )}

        {/* Footer info */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-zinc-800">
          <span className="text-xs text-zinc-600">
            {deviceCount} device{deviceCount !== 1 ? 's' : ''}
          </span>
        </div>
      </aside>
    </>
  )
}
