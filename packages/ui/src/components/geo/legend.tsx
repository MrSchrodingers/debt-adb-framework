import { interpolateInferno, interpolateRdYlGn, interpolatePuOr } from 'd3-scale-chromatic'
import type { GeoPalette } from './geo.types.js'

export interface LegendProps {
  /** Highest count present — shown as right-side label. */
  max: number
  palette: GeoPalette
  /** Second-quartile-ish count for the midpoint label. Optional. */
  median?: number
}

export function Legend({ max, palette, median }: LegendProps) {
  const colorFn =
    palette === 'rate' ? interpolateRdYlGn :
    palette === 'diverging' ? interpolatePuOr :
    interpolateInferno
  const stops = Array.from({ length: 12 }, (_, i) => colorFn(i / 11))
  const gradient = `linear-gradient(90deg, ${stops.join(', ')})`
  return (
    <div
      className="flex items-center gap-3 p-3 bg-zinc-900/40 rounded-lg border border-zinc-800 flex-1 min-w-[260px]"
      aria-label={`Escala de cores: menor à esquerda (zero), maior à direita (${max})`}
    >
      <span className="text-[11px] text-zinc-500 font-medium uppercase tracking-wider">Escala</span>
      <div className="flex-1 relative">
        <div className="h-3 rounded-full" style={{ background: gradient }} role="presentation" />
        <div className="flex justify-between mt-1.5 text-[11px] text-zinc-400 font-mono">
          <span>0</span>
          {median !== undefined && median > 0 && <span>~{median.toLocaleString('pt-BR')}</span>}
          <span className="text-zinc-200 font-semibold">{max.toLocaleString('pt-BR')}</span>
        </div>
      </div>
      <span className="text-[10px] text-zinc-500 italic whitespace-nowrap" title="Cores normalizadas por ranking — DDDs com mais volume ficam à direita">rank</span>
    </div>
  )
}
