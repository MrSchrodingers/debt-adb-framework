import { Smartphone, Send, Radio, BarChart3, FileText, X, AlertTriangle, Puzzle } from 'lucide-react'

type TabId = 'devices' | 'queue' | 'sessions' | 'metricas' | 'auditoria' | 'plugins'

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
  { id: 'plugins', label: 'Plugins', icon: Puzzle },
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

      {/* Desktop sidebar — always visible, in flow */}
      <aside className="hidden lg:flex lg:flex-col lg:w-56 lg:flex-shrink-0 bg-zinc-900/95 border-r border-zinc-800 h-screen sticky top-0">
        <SidebarContent
          activeTab={activeTab}
          onTabChange={onTabChange}
          connected={connected}
          deviceCount={deviceCount}
          alertCount={alertCount}
          onMobileClose={onMobileClose}
          showClose={false}
        />
      </aside>

      {/* Mobile sidebar — fixed overlay, slides in */}
      <aside
        className={`lg:hidden fixed z-50 top-0 left-0 h-full w-56 bg-zinc-900/95 border-r border-zinc-800 transition-transform duration-200 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <SidebarContent
          activeTab={activeTab}
          onTabChange={onTabChange}
          connected={connected}
          deviceCount={deviceCount}
          alertCount={alertCount}
          onMobileClose={onMobileClose}
          showClose={true}
        />
      </aside>
    </>
  )
}

function SidebarContent({
  activeTab,
  onTabChange,
  connected,
  deviceCount,
  alertCount,
  onMobileClose,
  showClose,
}: {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  connected: boolean
  deviceCount: number
  alertCount: number
  onMobileClose: () => void
  showClose: boolean
}) {
  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-zinc-100">Dispatch</h1>
          <div className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
        </div>
        {showClose && (
          <button
            onClick={onMobileClose}
            className="rounded p-1 text-zinc-500 hover:text-zinc-300 min-h-[44px] min-w-[44px] flex items-center justify-center"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2 space-y-1">
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
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
          <AlertTriangle className="h-4 w-4 text-red-400" />
          <span className="text-xs font-medium text-red-400">{alertCount} alerta{alertCount !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Footer */}
      <div className="p-4 border-t border-zinc-800">
        <span className="text-xs text-zinc-600">
          {deviceCount} device{deviceCount !== 1 ? 's' : ''}
        </span>
      </div>
    </>
  )
}
