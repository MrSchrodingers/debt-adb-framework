import { useState } from 'react'
import { OralsinOverview } from './oralsin-overview'
import { OralsinMessages } from './oralsin-messages'
import { OralsinSenders } from './oralsin-senders'
import { OralsinCallbacks } from './oralsin-callbacks'

type SubTab = 'overview' | 'messages' | 'senders' | 'callbacks'

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: 'overview', label: 'Visao Geral' },
  { id: 'messages', label: 'Mensagens' },
  { id: 'senders', label: 'Senders' },
  { id: 'callbacks', label: 'Callbacks' },
]

export function PluginTabs() {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('overview')

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-zinc-100">Plugin Oralsin</h2>
        <span className="inline-flex items-center rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400">
          ativo
        </span>
      </div>

      {/* Sub-tab bar */}
      <div className="flex gap-1 rounded-lg bg-zinc-900 border border-zinc-800 p-1 w-fit">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSubTab(tab.id)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              activeSubTab === tab.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
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

