# Credits & data attribution

## OpenStreetMap

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

- Roads, buildings, water and land use are fetched live from OSM through the
  public Overpass API mirrors (overpass-api.de, maps.mail.ru, overpass.kumi.systems,
  overpass.private.coffee) and cached locally in the browser.
- **Bundled data** — `src/game/map/data/shore-west-ontario.json` is a derived
  database extracted from OSM (the Lake Ontario multipolygon outline between Toronto and
  Hamilton / Burlington, piers / breakwaters / groynes along it, Silver Lake,
  Laurel Creek Reservoir and Columbia Lake). It is simplified (Douglas–Peucker,
  ~1 m) and delta-encoded. It is © OpenStreetMap contributors and licensed under
  the ODbL 1.0; the OSM data timestamp is stored in its `osmBase` field.
  Regenerate it with `scripts/build-shore-data.py`.

## Elevation

Terrain tiles: [Mapzen / AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
(Terrarium encoding). Sources include SRTM, GMTED, NED, ETOPO1 and others — see
the [attribution list](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
