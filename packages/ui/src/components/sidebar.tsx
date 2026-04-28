import { Smartphone, Send, Users, Radio, BarChart3, FileText, X, AlertTriangle, Puzzle, BookUser, LogOut, ShieldOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/auth-context'
import { BrandMark } from './brand-mark'
import { PreferencesMenu } from './preferences-menu'

type TabId = 'devices' | 'queue' | 'senders' | 'sessions' | 'metricas' | 'auditoria' | 'plugins' | 'contatos' | 'admin'

interface SidebarProps {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  connected: boolean
  deviceCount: number
  mobileOpen: boolean
  onMobileClose: () => void
  alertCount: number
}

const NAV_ITEMS: { id: TabId; labelKey: string; icon: typeof Smartphone }[] = [
  { id: 'devices',   labelKey: 'nav.devices',  icon: Smartphone },
  { id: 'queue',     labelKey: 'nav.queue',    icon: Send },
  { id: 'senders',   labelKey: 'nav.senders',  icon: Users },
  { id: 'sessions',  labelKey: 'nav.sessions', icon: Radio },
  { id: 'metricas',  labelKey: 'nav.metrics',  icon: BarChart3 },
  { id: 'auditoria', labelKey: 'nav.audit',    icon: FileText },
  { id: 'contatos',  labelKey: 'nav.contacts', icon: BookUser },
  { id: 'plugins',   labelKey: 'nav.plugins',  icon: Puzzle },
  { id: 'admin',     labelKey: 'nav.admin',    icon: ShieldOff },
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
  const { t } = useTranslation()

  return (
    <>
      {/* Header — DEBT brand mark */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-white/5 bg-gradient-to-b from-brand-900/30 to-transparent">
        <div className="flex items-center gap-3">
          <BrandMark size={26} withWordmark={true} />
          <span
            title={connected ? 'Conectado' : 'Desconectado'}
            className={`h-2 w-2 rounded-full transition-colors ${
              connected ? 'bg-brand-400 shadow-[0_0_10px_rgba(60,194,92,0.7)]' : 'bg-red-500'
            }`}
          />
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
              <span>{t(item.labelKey)}</span>
            </button>
          )
        })}
      </nav>

      {/* Alert badge */}
      {alertCount > 0 && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2">
          <AlertTriangle className="h-4 w-4 text-red-400" />
          <span className="text-xs font-medium text-red-400">
            {alertCount} {alertCount !== 1 ? t('alerts.alertPlural') : t('alerts.alert')}
          </span>
        </div>
      )}

      {/* Footer — device count + logout + preferences */}
      <SidebarFooter deviceCount={deviceCount} />
    </>
  )
}

function SidebarFooter({ deviceCount }: { deviceCount: number }) {
  const { mode, username, logout } = useAuth()
  const { t } = useTranslation()
  return (
    <div className="border-t border-white/5 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-white/40">
          {deviceCount} device{deviceCount !== 1 ? 's' : ''}
        </span>
        {username && (
          <span className="font-mono text-[0.65rem] text-brand-300/70 truncate max-w-[80px]">
            {username}
          </span>
        )}
        <PreferencesMenu />
      </div>
      {mode === 'closed' && (
        <button
          onClick={logout}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs font-medium text-white/60 transition hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-200"
        >
          <LogOut className="h-3.5 w-3.5" />
          {t('nav.logout')}
        </button>
      )}
    </div>
  )
}
