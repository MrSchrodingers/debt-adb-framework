import { useEffect, type ChangeEvent } from 'react'
import { Building2 } from 'lucide-react'
import { CORE_URL, authHeaders } from '../../config'
import { useTenant, type TenantSummary } from './tenant-context'

const TENANT_COLORS: Record<string, string> = {
  adb: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  sicoob: 'text-violet-300 bg-violet-500/10 border-violet-500/30',
  oralsin: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
}

export function TenantSelector() {
  const { tenant, setTenant, tenants, setTenants } = useTenant()

  useEffect(() => {
    void fetch(`${CORE_URL}/api/v1/plugins/adb-precheck/tenants`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : { tenants: [] }))
      .then((j: { tenants: TenantSummary[] }) => setTenants(j.tenants ?? []))
      .catch(() => setTenants([]))
  }, [setTenants])

  const onChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value
    if (id === 'global') setTenant(null)
    else {
      const t = tenants.find((x) => x.id === id) ?? null
      setTenant(t)
    }
  }

  const colorClass = tenant
    ? TENANT_COLORS[tenant.id] ?? 'text-zinc-300 bg-zinc-800 border-zinc-700'
    : 'text-zinc-300 bg-zinc-800 border-zinc-700'

  return (
    <div className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${colorClass}`}>
      <Building2 className="h-3.5 w-3.5" />
      <span className="opacity-70">Empresa:</span>
      <select
        value={tenant?.id ?? 'global'}
        onChange={onChange}
        className="bg-transparent outline-none border-none text-current"
      >
        <option value="global">Global (todos)</option>
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>
    </div>
  )
}
