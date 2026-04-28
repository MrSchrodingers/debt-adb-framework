import { useState } from 'react'
import { Package, LayoutDashboard, MessageSquare, Users, Webhook } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { OralsinOverview } from './oralsin-overview'
import { OralsinMessages } from './oralsin-messages'
import { OralsinSenders } from './oralsin-senders'
import { OralsinCallbacks } from './oralsin-callbacks'
import { PluginHeader, SubTabBar } from './plugin-ui'

type SubTab = 'overview' | 'messages' | 'senders' | 'callbacks'

export function OralsinTab() {
  const { t } = useTranslation()
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('overview')

  const SUB_TABS = [
    { id: 'overview' as const, label: t('oralsinTabs.overview'), icon: LayoutDashboard },
    { id: 'messages' as const, label: t('oralsinTabs.messages'), icon: MessageSquare },
    { id: 'senders' as const, label: t('oralsinTabs.senders'), icon: Users },
    { id: 'callbacks' as const, label: t('oralsinTabs.callbacks'), icon: Webhook },
  ]

  return (
    <div className="space-y-4">
      <PluginHeader
        icon={Package}
        title="Oralsin"
        subtitle={t('oralsinTabs.subtitle')}
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
