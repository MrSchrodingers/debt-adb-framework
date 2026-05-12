import { useState } from 'react'
import type { DddTopology, GeoViewsResponse } from './geo.types.js'
import { GeoViewPanel } from './geo-view-panel.js'

export interface GeoTabsProps {
  data: GeoViewsResponse
  topology: DddTopology
}

export function GeoTabs({ data, topology }: GeoTabsProps) {
  const firstGroup = data.groups[0]?.name ?? ''
  const firstView = data.groups[0]?.viewIds[0] ?? ''
  const [groupName, setGroupName] = useState(firstGroup)
  const [viewId, setViewId] = useState(firstView)

  const group = data.groups.find(g => g.name === groupName) ?? data.groups[0]
  const view = data.views.find(v => v.id === viewId) ?? data.views[0]
  if (!group || !view) return null

  return (
    <div className="space-y-4">
      {data.groups.length > 1 && (
        <nav className="flex gap-1 border-b border-zinc-800" role="tablist" aria-label="Grupos de plugin">
          {data.groups.map((g) => (
            <button
              key={g.name}
              role="tab"
              aria-selected={g.name === groupName}
              className={`px-4 py-2 text-xs font-medium transition-colors ${g.name === groupName
                ? 'border-b-2 border-emerald-500 text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-300'}`}
              onClick={() => { setGroupName(g.name); setViewId(g.viewIds[0] ?? '') }}
            >
              {labelize(g.name)}
            </button>
          ))}
        </nav>
      )}

      {group.viewIds.length > 1 && (
        <nav className="flex flex-wrap gap-2" role="tablist" aria-label="Visões">
          {group.viewIds.map((id) => {
            const v = data.views.find(view => view.id === id)
            return (
              <button
                key={id}
                role="tab"
                aria-selected={id === viewId}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${id === viewId
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                onClick={() => setViewId(id)}
              >
                {v?.label ?? id}
              </button>
            )
          })}
        </nav>
      )}

      <GeoViewPanel view={view} topology={topology} />
    </div>
  )
}

function labelize(name: string): string {
  return name.split(/[-_.]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
