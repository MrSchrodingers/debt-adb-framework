import { DeckGL } from '@deck.gl/react'
import { GeoJsonLayer } from '@deck.gl/layers'
import { interpolateViridis, interpolateRdYlGn, interpolatePuOr } from 'd3-scale-chromatic'
import { useMemo } from 'react'
import type { DddTopology, GeoPalette } from './geo.types.js'

export interface BrazilMapDDDProps {
  topology: DddTopology
  buckets: Record<string, number>
  palette: GeoPalette
  onDddClick: (ddd: string) => void
  max?: number
}

const INITIAL_VIEW_STATE = {
  longitude: -53, latitude: -14, zoom: 3.4,
  minZoom: 2, maxZoom: 8, pitch: 0, bearing: 0,
}

export function BrazilMapDDD(props: BrazilMapDDDProps) {
  const { topology, buckets, palette, onDddClick } = props
  const max = props.max ?? Math.max(1, ...Object.values(buckets))
  const colorFn = paletteToColorFn(palette)

  const layer = useMemo(() => new GeoJsonLayer({
    id: 'br-ddd-choropleth',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: topology as any,
    pickable: true,
    stroked: true,
    filled: true,
    lineWidthMinPixels: 0.5,
    getLineColor: [255, 255, 255, 80] as [number, number, number, number],
    getFillColor: (f: object) => {
      const feat = f as { properties: { description: number } }
      const ddd = String(Math.trunc(Number(feat.properties.description)))
      const count = buckets[ddd] ?? 0
      const t = count === 0 ? 0 : count / max
      const [r, g, b] = parseRgb(colorFn(t))
      return count === 0
        ? [40, 40, 40, 60] as [number, number, number, number]
        : [r, g, b, 220] as [number, number, number, number]
    },
    updateTriggers: { getFillColor: [buckets, max, palette] },
    onClick: (info) => {
      const f = info.object as { properties: { description: number } } | undefined
      if (!f) return
      onDddClick(String(Math.trunc(Number(f.properties.description))))
    },
  }), [topology, buckets, max, palette, onDddClick, colorFn])

  return (
    <div className="relative h-[520px] w-full rounded-lg border border-zinc-800 overflow-hidden bg-zinc-950">
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={[layer]}
        getTooltip={({ object }) => {
          const f = object as { properties: { description: number } } | undefined
          if (!f) return null
          const ddd = String(Math.trunc(Number(f.properties.description)))
          const count = buckets[ddd] ?? 0
          return {
            html: `<div style="padding:6px 8px;"><b>DDD ${ddd}</b><br/>${count} ${count === 1 ? 'registro' : 'registros'}</div>`,
            style: { background: 'rgba(20,20,20,0.95)', color: '#fff', border: '1px solid #444', borderRadius: '4px' },
          }
        }}
      />
    </div>
  )
}

function paletteToColorFn(p: GeoPalette): (t: number) => string {
  if (p === 'rate') return interpolateRdYlGn
  if (p === 'diverging') return interpolatePuOr
  return interpolateViridis
}

function parseRgb(input: string): [number, number, number] {
  const m = input.match(/rgb\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*\)/)
  if (!m) return [0, 0, 0]
  return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)]
}
