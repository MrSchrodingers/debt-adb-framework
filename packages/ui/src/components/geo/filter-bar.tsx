import type { GeoFilterSpec, GeoFilterState, GeoWindow } from './geo.types.js'

export interface FilterBarProps {
  specs: GeoFilterSpec[]
  state: GeoFilterState
  onChange: (next: GeoFilterState) => void
}

export function FilterBar({ specs, state, onChange }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 p-3 bg-zinc-900/40 rounded-lg border border-zinc-800">
      {specs.map((spec) => {
        if (spec.type === 'window') {
          return (
            <div key={spec.id} className="flex items-center gap-1" role="group" aria-label="Janela temporal">
              {spec.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={`px-3 py-1 text-xs rounded-md transition-colors ${state.window === opt
                    ? 'bg-emerald-600 text-white'
                    : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
                  onClick={() => onChange({ ...state, window: opt as GeoWindow })}
                >
                  {opt}
                </button>
              ))}
            </div>
          )
        }
        // The global TenantSelector in GeoPage controls the tenant filter,
        // so we hide it from the per-view FilterBar to avoid two competing
        // controls. Every other enum filter renders as a plain select.
        if (spec.id === 'tenant') return null
        if (spec.type === 'enum') {
          return (
            <label key={spec.id} className="flex items-center gap-2 text-xs text-zinc-400">
              {spec.label && <span>{spec.label}:</span>}
              <select
                aria-label={spec.label ?? spec.id}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-100 text-xs"
                value={state.filters[spec.id] ?? spec.defaultValue}
                onChange={(e) => onChange({ ...state, filters: { ...state.filters, [spec.id]: e.target.value } })}
              >
                {spec.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          )
        }
        return (
          <label key={spec.id} className="flex items-center gap-2 text-xs text-zinc-400">
            <span>{spec.label}:</span>
            <select
              aria-label={spec.label}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-100 text-xs"
              value={state.filters[spec.id] ?? spec.defaultValue}
              onChange={(e) => onChange({ ...state, filters: { ...state.filters, [spec.id]: e.target.value } })}
            >
              {spec.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )
      })}
    </div>
  )
}
