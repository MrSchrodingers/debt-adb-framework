import { interpolateViridis, interpolateRdYlGn, interpolatePuOr } from 'd3-scale-chromatic'
import type { GeoPalette } from './geo.types.js'

export interface LegendProps {
  max: number
  palette: GeoPalette
}

export function Legend({ max, palette }: LegendProps) {
  const colorFn =
    palette === 'rate' ? interpolateRdYlGn :
    palette === 'diverging' ? interpolatePuOr :
    interpolateViridis
  const stops = Array.from({ length: 12 }, (_, i) => colorFn(i / 11))
  const gradient = `linear-gradient(90deg, ${stops.join(', ')})`
  return (
    <div
      className="flex items-center gap-2 p-3 bg-zinc-900/40 rounded-lg border border-zinc-800 flex-1"
      aria-label={`Escala de cores de 0 a ${max}`}
    >
      <span className="text-xs text-zinc-500 font-mono w-8 text-right">0</span>
      <div className="h-4 flex-1 rounded" style={{ background: gradient }} role="presentation" />
      <span className="text-xs text-zinc-500 font-mono w-16">{max}</span>
    </div>
  )
}
