import { useEffect, useState } from 'react'
import { CORE_URL, authHeaders } from '../../config.js'
import { GeoTabs } from './geo-tabs.js'
import { EmptyState } from './empty-state.js'
import type { DddTopology, GeoViewsResponse } from './geo.types.js'

export function GeoPage() {
  const [views, setViews] = useState<GeoViewsResponse | null>(null)
  const [topology, setTopology] = useState<DddTopology | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${CORE_URL}/api/v1/geo/views`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(setViews)
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    fetch('/topology/br-ddds.geojson')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(setTopology)
      .catch((e) => setError(e.message))
  }, [])

  if (error) {
    return (
      <div className="rounded-lg border border-red-900/40 bg-red-950/40 p-4 text-sm text-red-300">
        Erro carregando geolocalização: {error}
      </div>
    )
  }
  if (!views || !topology) {
    return <div className="text-xs text-zinc-500">Carregando geolocalização…</div>
  }
  if (views.views.length === 0) {
    return <EmptyState />
  }
  return <GeoTabs data={views} topology={topology} />
}
