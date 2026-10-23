/**
 * v1.3.5: bundled western Lake Ontario shoreline (Toronto → Hamilton /
 * Burlington) plus a few KW inland lakes, so the coast is right even when
 * every Overpass mirror is down. Data: © OpenStreetMap contributors, ODbL 1.0
 * (see CREDITS.md); regenerate with scripts/build-shore-data.py.
 *
 * The JSON is a separate lazily-imported chunk (~105 KB), so it costs nothing
 * away from the lake and works from file:// in Electron.
 */
import type { OsmArea, OsmNode } from './OverpassClient';
import type { ShoreLines } from './ShoreMask';

interface RawShore {
  v: number;
  attribution: string;
  osmBase: string;
  cover: { s: number; w: number; n: number; e: number };
  water: number[][];
  landAreas: number[][];
  landLines: number[][];
  inland: Array<{ key: string; tags: Record<string, string>; parts: number[][] }>;
}

export interface BundledShore {
  osmBase: string;
  cover: { s: number; w: number; n: number; e: number };
  water: OsmNode[][];
  landAreas: OsmNode[][];
  landLines: OsmNode[][];
  inland: OsmArea[];
}

function decode(e: number[]): OsmNode[] {
  const out: OsmNode[] = [];
  let lat = e[0];
  let lon = e[1];
  out.push({ lat: lat / 1e6, lon: lon / 1e6 });
  for (let i = 2; i + 1 < e.length; i += 2) {
    lat += e[i];
    lon += e[i + 1];
    out.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return out;
}

let loading: Promise<BundledShore | null> | null = null;

/** Load (once) and decode the bundled shore data; null if the chunk fails. */
export function loadBundledShore(): Promise<BundledShore | null> {
  if (!loading) {
    loading = import('./data/shore-west-ontario.json')
      .then((m) => {
        const raw = ((m as { default?: unknown }).default ?? m) as RawShore;
        return {
          osmBase: raw.osmBase,
          cover: raw.cover,
          water: raw.water.map(decode),
          landAreas: raw.landAreas.map(decode),
          landLines: raw.landLines.map(decode),
          inland: raw.inland.map((a) => ({ key: a.key, tags: a.tags, parts: a.parts.map(decode) })),
        };
      })
      .catch(() => null);
  }
  return loading;
}

/** Is the lat/lon box fully inside the bundled coverage? */
export function bundledCovers(b: BundledShore, s: number, w: number, n: number, e: number): boolean {
  const c = b.cover;
  return s >= c.s && n <= c.n && w >= c.w && e <= c.e;
}

/** Shore lines for the mask in local metres (water polygons → exact even-odd fill). */
export function bundledShoreLines(b: BundledShore, toLocal: (lat: number, lon: number) => { x: number; z: number }): ShoreLines {
  const loc = (g: OsmNode[]) => g.map((p) => toLocal(p.lat, p.lon));
  return {
    barriers: [],
    waterPolys: b.water.map(loc),
    landAreas: b.landAreas.map(loc),
    landLines: b.landLines.map(loc),
  };
}

/** Bundled inland lakes whose first vertex is within `km` of (lat, lon). */
export function bundledInlandNear(b: BundledShore, lat: number, lon: number, km: number): OsmArea[] {
  const kLat = 111.32;
  const kLon = 111.32 * Math.cos((lat * Math.PI) / 180);
  return b.inland.filter((a) => {
    const p = a.parts[0]?.[0];
    return !!p && Math.hypot((p.lat - lat) * kLat, (p.lon - lon) * kLon) < km;
  });
}
