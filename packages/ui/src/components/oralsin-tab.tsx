import { useState } from 'react'
import { Package, LayoutDashboard, MessageSquare, Users, Webhook } from 'lucide-react'
import { OralsinOverview } from './oralsin-overview'
import { OralsinMessages } from './oralsin-messages'
import { OralsinSenders } from './oralsin-senders'
import { OralsinCallbacks } from './oralsin-callbacks'
import { PluginHeader, SubTabBar } from './plugin-ui'

type SubTab = 'overview' | 'messages' | 'senders' | 'callbacks'

const SUB_TABS = [
  { id: 'overview' as const, label: 'Visao Geral', icon: LayoutDashboard },
  { id: 'messages' as const, label: 'Mensagens', icon: MessageSquare },
  { id: 'senders' as const, label: 'Senders', icon: Users },
  { id: 'callbacks' as const, label: 'Callbacks', icon: Webhook },
]

export function OralsinTab() {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('overview')

  return (
    <div className="space-y-4">
      <PluginHeader
        icon={Package}
        title="Oralsin"
        subtitle="NotificationBilling · envios outbound via Dispatch"
        status="active"
        accent="emerald"
        version="1.0.0"
      />

      <SubTabBar tabs={SUB_TABS} active={activeSubTab} onChange={setActiveSubTab} accent="emerald" />

      {activeSubTab === 'overview' ? (
        <OralsinOverview />
      ) : activeSubTab === 'messages' ? (
        <OralsinMessages />
      ) : activeSubTab === 'senders' ? (
        <OralsinSenders />
      ) : (
        <OralsinCallbacks />
      )}
    </div>
  )
}
