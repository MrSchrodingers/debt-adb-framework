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
    // Pass the features array directly — more reliable across deck.gl versions
    // than passing the whole FeatureCollection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: topology.features as any,
    pickable: true,
    stroked: true,
    filled: true,
    lineWidthMinPixels: 1,
    getLineColor: [120, 120, 130, 200] as [number, number, number, number],
    getFillColor: (f: object) => {
      const feat = f as { properties?: { description?: number | string } }
      const rawDdd = feat?.properties?.description
      if (rawDdd === undefined || rawDdd === null) return [80, 80, 90, 120]
      const ddd = String(Math.trunc(Number(rawDdd)))
      const count = buckets[ddd] ?? 0
      if (max <= 0 || count === 0) return [60, 60, 70, 140] as [number, number, number, number]
      const t = Math.min(1, count / max)
      const [r, g, b] = parseRgb(colorFn(t))
      return [r, g, b, 230] as [number, number, number, number]
    },
    updateTriggers: { getFillColor: [buckets, max, palette] },
    onClick: (info) => {
      const f = info.object as { properties?: { description?: number | string } } | undefined
      const rawDdd = f?.properties?.description
      if (rawDdd === undefined || rawDdd === null) return
      onDddClick(String(Math.trunc(Number(rawDdd))))
    },
  }), [topology, buckets, max, palette, onDddClick, colorFn])

  return (
    <div className="relative h-[520px] w-full rounded-lg border border-zinc-800 overflow-hidden bg-zinc-950">
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={[layer]}
        getTooltip={({ object }) => {
          const f = object as { properties?: { description?: number | string } } | undefined
          const rawDdd = f?.properties?.description
          if (rawDdd === undefined || rawDdd === null) return null
          const ddd = String(Math.trunc(Number(rawDdd)))
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
