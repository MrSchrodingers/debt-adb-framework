import type { GeoAggregation } from './geo.types.js'

export interface FallbackTableProps {
  aggregation: GeoAggregation
}

export function FallbackTable({ aggregation }: FallbackTableProps) {
  const sorted = Object.entries(aggregation.buckets).sort(([, a], [, b]) => b - a)
  return (
    <table className="w-full text-xs mt-4 border border-zinc-800 rounded-lg overflow-hidden">
      <thead>
        <tr className="border-b border-zinc-800 bg-zinc-900/40">
          <th className="text-left p-2 text-zinc-400 font-medium">DDD</th>
          <th className="text-right p-2 text-zinc-400 font-medium">Registros</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(([ddd, count]) => (
          <tr key={ddd} className="border-b border-zinc-900">
            <td className="p-2 text-zinc-200 font-mono">{ddd}</td>
            <td className="p-2 text-zinc-200 font-mono text-right">{count}</td>
          </tr>
        ))}
        {sorted.length === 0 && (
          <tr><td colSpan={2} className="p-4 text-center text-zinc-500">Sem registros</td></tr>
        )}
      </tbody>
    </table>
  )
}
