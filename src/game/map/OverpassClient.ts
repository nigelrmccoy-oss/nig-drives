export interface OsmNode {
  lat: number;
  lon: number;
}

export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  geometry: OsmNode[];
}

/** v1.3.3 water / landuse polygon (way or multipolygon relation). */
export interface OsmArea {
  /** 'w123' / 'r456' */
  key: string;
  tags: Record<string, string>;
  /** Raw member geometries; closed ways are complete rings, relation parts get joined later. */
  parts: OsmNode[][];
}

interface ParsedTile {
  ways: OsmWay[];
  buildings: OsmWay[];
  areas: OsmArea[];
  /** Water multipolygons touching the tile, small enough to fetch in full. */
  relationIds: number[];
}

export interface OverpassResult extends ParsedTile {
  source: string;
}

/** Relations spanning more than this (degrees) are skipped (Great Lakes use the DEM lake table). */
const MAX_RELATION_SPAN_DEG = 0.3;

export function isWaterTags(t: Record<string, string>): boolean {
  return (
    t.natural === 'water' ||
    t.waterway === 'riverbank' ||
    t.landuse === 'reservoir' ||
    t.landuse === 'basin'
  );
}

const HIGHWAY_FILTER =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|track|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

/** Per-attempt fetch timeout (ms). Keep short so offline fallback can kick in. */
export const OVERPASS_ATTEMPT_MS = 10_000;
/** Cap in-flight Overpass tile fetches across the client. */
const MAX_CONCURRENT = 3;
/** Soft cap on memory cache entries. */
const MAX_CACHE = 48;

function buildQuery(south: number, west: number, north: number, east: number): string {
  const pad = 0.0004;
  const s = south - pad;
  const w = west - pad;
  const n = north + pad;
  const e = east + pad;
  return `
[out:json][timeout:9];
(
  way["highway"~"^(${HIGHWAY_FILTER})$"](${s},${w},${n},${e});
  way["building"](${s},${w},${n},${e});
  way["natural"="water"](${s},${w},${n},${e});
  way["waterway"="riverbank"](${s},${w},${n},${e});
  way["landuse"~"^(reservoir|basin)$"](${s},${w},${n},${e});
  way["leisure"~"^(park|golf_course)$"](${s},${w},${n},${e});
  way["landuse"~"^(forest|meadow|farmland|recreation_ground|cemetery|village_green)$"](${s},${w},${n},${e});
  way["natural"~"^(wood|scrub)$"](${s},${w},${n},${e});
);
out geom;
relation["natural"="water"](${s},${w},${n},${e});
out tags bb;
`.trim();
}

function relationQuery(ids: number[]): string {
  return `[out:json][timeout:15];relation(id:${ids.join(',')});out geom;`;
}

/**
 * Endpoint preference for Cursor-box / flaky-TLS envs:
 * 1) Same-origin Vite proxies first (no CORS) — primary is healthy kumi.
 * 2) Direct healthy mirrors (kumi, mail.ru).
 * 3) overpass-api.de last-resort only (often TLS EOF here).
 */
const PROXY_ENDPOINTS = [
  '/api/overpass', // vite → kumi
  '/api/overpass-mailru', // vite → maps.mail.ru
];

const DIRECT_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const LAST_RESORT_ENDPOINTS = [
  '/api/overpass-de',
  'https://overpass-api.de/api/interpreter',
];

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}


/** Rough footprint size proxy from geometry span (for prefer-larger cap). */
function footprintScore(w: OsmWay): number {
  if (!w.geometry || w.geometry.length < 3) return 0;
  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;
  for (const n of w.geometry) {
    if (n.lat < minLat) minLat = n.lat;
    if (n.lat > maxLat) maxLat = n.lat;
    if (n.lon < minLon) minLon = n.lon;
    if (n.lon > maxLon) maxLon = n.lon;
  }
  return Math.max(0, maxLat - minLat) * Math.max(0, maxLon - minLon);
}

export class OverpassClient {
  private memoryCache = new Map<string, ParsedTile>();
  private relationCache = new Map<number, Promise<OsmArea | null>>();
  private generation = 0;
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private activeAborts = new Set<AbortController>();

  /** Bump generation + abort in-flight fetches (e.g. on TileManager.dispose). */
  cancelAll(): void {
    this.generation++;
    for (const ctrl of this.activeAborts) {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    }
    this.activeAborts.clear();
  }

  getGeneration(): number {
    return this.generation;
  }

  getCached(key: string): ParsedTile | undefined {
    return this.memoryCache.get(key);
  }

  setCached(key: string, data: ParsedTile): void {
    this.memoryCache.set(key, data);
    this.trimCache();
  }

  private trimCache(): void {
    while (this.memoryCache.size > MAX_CACHE) {
      const first = this.memoryCache.keys().next().value;
      if (first === undefined) break;
      this.memoryCache.delete(first);
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.inFlight < MAX_CONCURRENT) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * Fetch highways + buildings for a tile bbox.
   * Prefer Vite proxies → healthy directs; de is last-resort only.
   * Short timeouts so callers can fall back offline on true outages.
   * Pass expectGen to ignore results after cancelAll / dispose.
   */
  async fetchTile(
    key: string,
    south: number,
    west: number,
    north: number,
    east: number,
    expectGen?: number,
  ): Promise<OverpassResult> {
    const cached = this.memoryCache.get(key);
    if (cached) return { ...cached, source: 'memory' };

    if (expectGen !== undefined && expectGen !== this.generation) {
      throw new Error('Overpass request cancelled (stale generation)');
    }

    await this.acquireSlot();
    try {
      if (expectGen !== undefined && expectGen !== this.generation) {
        throw new Error('Overpass request cancelled (stale generation)');
      }

      const query = buildQuery(south, west, north, east);
      const res = await this.runWaves(query, (d) => parseTile(d), expectGen);
      this.memoryCache.set(key, res.parsed);
      this.trimCache();
      return { ...res.parsed, source: res.source };
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Same mirror order for every request: same-origin proxies race → direct
   * mirrors race → overpass-api.de last resort (one at a time).
   */
  private async runWaves<T>(
    query: string,
    parse: (data: OverpassJson) => T,
    expectGen?: number,
  ): Promise<{ parsed: T; source: string }> {
    const stale = () => expectGen !== undefined && expectGen !== this.generation;
    let lastError: unknown;
    // Wave 1: race same-origin proxies (kumi primary + mail.ru) — no CORS.
    try {
      const raced = await withTimeout(
        Promise.any(
          PROXY_ENDPOINTS.map((ep) => this.postQuery(ep, query, parse).then((parsed) => ({ parsed, source: ep }))),
        ),
        OVERPASS_ATTEMPT_MS,
        'Overpass proxy race',
      );
      if (stale()) throw new Error('Overpass request cancelled (stale generation)');
      return raced;
    } catch (err) {
      lastError = err;
    }
    // Wave 2: race healthy directs (skip dead de so TLS EOF cannot burn the slot).
    try {
      const raced = await withTimeout(
        Promise.any(
          DIRECT_ENDPOINTS.map((ep) => this.postQuery(ep, query, parse).then((parsed) => ({ parsed, source: ep }))),
        ),
        OVERPASS_ATTEMPT_MS,
        'Overpass direct race',
      );
      if (stale()) throw new Error('Overpass request cancelled (stale generation)');
      return raced;
    } catch (err) {
      lastError = err;
    }
    // Wave 3: last-resort de (optional; often broken on Cursor box).
    for (const endpoint of LAST_RESORT_ENDPOINTS) {
      if (stale()) throw new Error('Overpass request cancelled (stale generation)');
      try {
        const parsed = await withTimeout(
          this.postQuery(endpoint, query, parse),
          OVERPASS_ATTEMPT_MS,
          `Overpass ${endpoint}`,
        );
        return { parsed, source: endpoint };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * v1.3.3: full geometry for water multipolygons (lakes with islands, river
   * banks). Cached by id across tiles; failures resolve to null and are retried
   * on a later tile.
   */
  async fetchRelations(ids: number[], expectGen?: number): Promise<OsmArea[]> {
    const want = ids.filter((id) => !this.relationCache.has(id));
    if (want.length) {
      const batch = (async () => {
        await this.acquireSlot();
        try {
          const res = await this.runWaves(relationQuery(want), parseRelations, expectGen);
          return res.parsed;
        } finally {
          this.releaseSlot();
        }
      })();
      for (const id of want) {
        const p = batch.then(
          (m) => m.get(id) ?? null,
          () => {
            this.relationCache.delete(id);
            return null;
          },
        );
        this.relationCache.set(id, p);
      }
    }
    const out = await Promise.all(ids.map((id) => this.relationCache.get(id) ?? Promise.resolve(null)));
    return out.filter((a): a is OsmArea => !!a);
  }

  private async postQuery<T>(
    endpoint: string,
    query: string,
    parse: (data: OverpassJson) => T,
  ): Promise<T> {
    const ctrl = new AbortController();
    this.activeAborts.add(ctrl);
    const abortTimer = setTimeout(() => ctrl.abort(), OVERPASS_ATTEMPT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: ctrl.signal,
      });

      if (!res.ok) {
        throw new Error(`Overpass ${res.status} from ${endpoint}`);
      }

      return parse((await res.json()) as OverpassJson);
    } finally {
      clearTimeout(abortTimer);
      this.activeAborts.delete(ctrl);
    }
  }
}

interface OverpassJson {
  elements?: Array<{
    type: string;
    id: number;
    tags?: Record<string, string>;
    geometry?: Array<OsmNode | null>;
    bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
    members?: Array<{ type: string; role: string; geometry?: Array<OsmNode | null> }>;
  }>;
}

function cleanGeom(g: Array<OsmNode | null> | undefined): OsmNode[] {
  return (g ?? []).filter((n): n is OsmNode => !!n && Number.isFinite(n.lat) && Number.isFinite(n.lon));
}

function parseTile(data: OverpassJson): ParsedTile {
  const ways: OsmWay[] = [];
  const buildings: OsmWay[] = [];
  const areas: OsmArea[] = [];
  const relationIds: number[] = [];
  for (const el of data.elements ?? []) {
    const tags = el.tags ?? {};
    if (el.type === 'relation') {
      const b = el.bounds;
      if (b && Math.max(b.maxlat - b.minlat, b.maxlon - b.minlon) < MAX_RELATION_SPAN_DEG) {
        relationIds.push(el.id);
      }
      continue;
    }
    if (el.type !== 'way') continue;
    const geom = cleanGeom(el.geometry);
    if (geom.length < 2) continue;
    if (tags.highway) ways.push({ id: el.id, tags, geometry: geom });
    else if (tags.building) buildings.push({ id: el.id, tags, geometry: geom });
    else if (geom.length >= 4) areas.push({ key: `w${el.id}`, tags, parts: [geom] });
  }
  // Prefer larger footprints when capping (better street fill / FPS tradeoff)
  if (buildings.length > 520) {
    buildings.sort((a, b) => footprintScore(b) - footprintScore(a));
    buildings.length = 520;
  }
  return { ways, buildings, areas, relationIds };
}

function parseRelations(data: OverpassJson): Map<number, OsmArea> {
  const out = new Map<number, OsmArea>();
  for (const el of data.elements ?? []) {
    if (el.type !== 'relation') continue;
    const parts: OsmNode[][] = [];
    for (const m of el.members ?? []) {
      if (m.type !== 'way' || (m.role !== 'outer' && m.role !== 'inner' && m.role !== '')) continue;
      const g = cleanGeom(m.geometry);
      if (g.length >= 2) parts.push(g);
    }
    if (parts.length) out.set(el.id, { key: `r${el.id}`, tags: el.tags ?? {}, parts });
  }
  return out;
}
