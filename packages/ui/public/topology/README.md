# BR DDD GeoJSON

Source: https://gist.github.com/guilhermeprokisch/080c2cb1bd28e8aca54d114e453c91a4

67 active Brazilian DDD area codes (ANATEL allocation). Each feature has
`properties.description` as a numeric DDD code — cast with `Number()` on read.

## License caveat

The gist does not declare a license. Internal use is acceptable; if this
product ships externally, either:

1. Ask the author for an explicit MIT/CC0 grant, or
2. Replace with a fallback derived from IBGE municipality polygons
   (`tbrugz/geodata-br`) + `kelvins/municipios-brasileiros` (MIT) dissolved by DDD.
   Estimated effort ~2-3h via mapshaper:
   ```
   mapshaper municipios.geojson -each 'ddd=lookup[CD_MUN]' -dissolve ddd -o brazil-ddd.geojson
   ```

See `docs/superpowers/specs/2026-05-14-geolocation-plugin-contract-design.md` §11
for the risk register entry.
