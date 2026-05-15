import { useEffect, useState } from 'react'
import { CORE_URL, authHeaders } from '../../config.js'
import { TenantProvider, useTenant } from '../adb-precheck/tenant-context.js'
import { TenantSelector } from '../adb-precheck/tenant-selector.js'
import { GeoTabs } from './geo-tabs.js'
import { EmptyState } from './empty-state.js'
import type { DddTopology, GeoViewsResponse } from './geo.types.js'

/**
 * Public wrapper. Provides the same TenantContext the ADB Pre-check tab
 * uses, so the Empresa selector here mirrors that tab byte-for-byte —
 * one source of truth in localStorage (`adb-precheck.tenant`).
 */
export function GeoPage() {
  return (
    <TenantProvider>
      <GeoPageInner />
    </TenantProvider>
  )
}

function GeoPageInner() {
  const { tenant } = useTenant()
  const [views, setViews] = useState<GeoViewsResponse | null>(null)
  const [topology, setTopology] = useState<DddTopology | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Refetch views when tenant changes. The /views endpoint itself
  // doesn't currently scope by tenant (filter specs are static per
  // view), but we still re-issue the call so future per-tenant view
  // catalogs keep working without further wiring. Aggregations are
  // re-fetched inside GeoViewPanel — they actually return tenant-
  // scoped data.
  useEffect(() => {
    const url = new URL(`${CORE_URL}/api/v1/geo/views`)
    if (tenant?.id) url.searchParams.set('tenant', tenant.id)
    setViews(null)
    setError(null)
    fetch(url.toString(), { headers: authHeaders() })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(setViews)
      .catch((e) => setError(e.message))
  }, [tenant?.id])

  useEffect(() => {
    fetch('/topology/br-ddds.geojson')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(setTopology)
      .catch((e) => setError(e.message))
  }, [])

  return (
    <div className="space-y-4">
      {/* Header: tenant selector mirrors the ADB Pre-check tab pattern.
          Sticks on the right so it doesn't compete with future page
          titles on the left. */}
      <div className="flex items-center justify-end gap-2">
        <TenantSelector />
      </div>

      {error && (
        <div className="rounded-lg border border-red-900/40 bg-red-950/40 p-4 text-sm text-red-300">
          Erro carregando geolocalização: {error}
        </div>
      )}
      {!error && (!views || !topology) && (
        <div className="text-xs text-zinc-500">Carregando geolocalização…</div>
      )}
      {!error && views && topology && views.views.length === 0 && <EmptyState />}
      {!error && views && topology && views.views.length > 0 && (
        <GeoTabs data={views} topology={topology} tenantId={tenant?.id ?? null} />
      )}
    </div>
  )
}
