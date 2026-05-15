import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type TenantId = 'adb' | 'sicoob' | 'oralsin'

export interface TenantSummary {
  id: TenantId
  label: string
  mode: 'prov' | 'raw'
  defaultPipelineId?: number
  defaultStageId?: number
  writeback?: { invalidate: boolean; localize: boolean; pipedriveNote: boolean; pipedriveActivity: boolean }
  pipedriveEnabled?: boolean
}

interface Ctx {
  tenant: TenantSummary | null
  setTenant: (t: TenantSummary | null) => void
  tenants: TenantSummary[]
  setTenants: (l: TenantSummary[]) => void
}

const TenantCtx = createContext<Ctx | null>(null)
const LS_KEY = 'adb-precheck.tenant'

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenant, setTenantState] = useState<TenantSummary | null>(null)
  const [tenants, setTenants] = useState<TenantSummary[]>([])

  useEffect(() => {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(LS_KEY) : null
    if (raw) {
      try {
        const t = JSON.parse(raw) as TenantSummary
        setTenantState(t)
      } catch {
        // corrupt LS — ignore
      }
    }
  }, [])

  const setTenant = useCallback((t: TenantSummary | null) => {
    setTenantState(t)
    if (typeof window !== 'undefined') {
      if (t) localStorage.setItem(LS_KEY, JSON.stringify(t))
      else localStorage.removeItem(LS_KEY)
    }
  }, [])

  return <TenantCtx.Provider value={{ tenant, setTenant, tenants, setTenants }}>{children}</TenantCtx.Provider>
}

export function useTenant(): Ctx {
  const c = useContext(TenantCtx)
  if (!c) throw new Error('useTenant must be used inside TenantProvider')
  return c
}
