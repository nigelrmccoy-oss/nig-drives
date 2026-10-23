import { cacheGet, cachePut } from './OverpassCache';

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

/**
 * v1.3.5 per-attempt fetch timeout (ms). Public mirrors answered in 13–35 s
 * in Oct 2026; 10 s turned every slow mirror into an offline grid.
 */
export const OVERPASS_ATTEMPT_MS = 30_000;
/** Server-side [timeout:] for tile queries (s): must outlast a slow queue. */
const SERVER_TIMEOUT_S = 25;
/** Start a second mirror if the first hasn't answered within this (ms). */
const HEDGE_MS = 9_000;
/** Give up on the network for one request after this (ms) → cache → offline grid. */
const REQUEST_BUDGET_MS = 75_000;
/** A cached response younger than this is used without asking a mirror. */
const CACHE_FRESH_MS = 24 * 3600_000;
/** Cap in-flight Overpass tile fetches across the client. */
const MAX_CONCURRENT = 3;
/** Soft cap on memory cache entries. */
const MAX_CACHE = 48;

/**
 * Identification. Mirrors reject anonymous clients (overpass-api.de → 406,
 * kumi / private.coffee → 429 "include a meaningful User-Agent"). Browsers
 * can't set User-Agent from fetch (they send their own), so direct requests
 * also carry `?client=` (accepted by the interpreter, verified from nigian);
 * the Vite proxies and Electron set a real User-Agent (vite.config.ts,
 * electron/main.cjs).
 */
export const OVERPASS_CLIENT_ID = 'nig-drives/1.3.10';

function buildQuery(south: number, west: number, north: number, east: number): string {
  const pad = 0.0004;
  const s = south - pad;
  const w = west - pad;
  const n = north + pad;
  const e = east + pad;
  return `
[out:json][timeout:${SERVER_TIMEOUT_S}];
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
  return `[out:json][timeout:${SERVER_TIMEOUT_S}];relation(id:${ids.join(',')});out geom;`;
}

/**
 * v1.3.5 mirror order (Code Critic probe 2026-10-21 23:40 ET + nigian probes
 * 2026-10-22): overpass-api.de answered in 13–15 s, maps.mail.ru in ~19 s
 * (one timeout), kumi and private.coffee timed out. Same-origin Vite proxies
 * (dev / preview: no CORS, real User-Agent) are tried first when the page is
 * served over http(s); a 404 / HTML answer disables them for the session.
 * Mirrors that fail are pushed down the order for a minute.
 */
interface Mirror {
  name: string;
  direct: string;
  proxy: string;
  /** performance.now() until which this mirror is de-prioritised. */
  coolUntil: number;
}

const MIRRORS: Mirror[] = [
  { name: 'overpass-api.de', direct: 'https://overpass-api.de/api/interpreter', proxy: '/api/overpass-de', coolUntil: 0 },
  { name: 'maps.mail.ru', direct: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', proxy: '/api/overpass-mailru', coolUntil: 0 },
  { name: 'kumi', direct: 'https://overpass.kumi.systems/api/interpreter', proxy: '/api/overpass-kumi', coolUntil: 0 },
  { name: 'private.coffee', direct: 'https://overpass.private.coffee/api/interpreter', proxy: '/api/overpass-coffee', coolUntil: 0 },
];

let proxiesUsable = typeof location !== 'undefined' && /^https?:$/.test(location.protocol);

/** HTTP statuses worth a retry (with backoff) on the next mirror. */
const RETRY_STATUS = new Set([429, 502, 503, 504]);

class OverpassHttpError extends Error {
  readonly status: number;
  constructor(status: number, endpoint: string) {
    super(`Overpass ${status} from ${endpoint}`);
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function orderedMirrors(): Mirror[] {
  const now = performance.now();
  return MIRRORS.map((m, i) => ({ m, i }))
    .sort((a, b) => Number(a.m.coolUntil > now) - Number(b.m.coolUntil > now) || a.i - b.i)
    .map((e) => e.m);
}

/** Request stats for QA (`__nig.game.tiles.overpassStats()`). */
export const overpassStats = {
  ok: 0,
  cacheFresh: 0,
  cacheStale: 0,
  failed: 0,
  retries: 0,
  lastSource: '',
  lastMs: 0,
  bySource: {} as Record<string, number>,
};

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
      const res = await this.runWaves(query, (d) => parseTile(d), expectGen, `tile:${key}`);
      this.memoryCache.set(key, res.parsed);
      this.trimCache();
      return { ...res.parsed, source: res.source };
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * v1.3.5: cache (fresh) → mirrors in health order, each attempt ≤ 30 s, a
   * hedged second mirror after HEDGE_MS, backoff + next mirror on
   * 429/502/503/504/timeouts → cache (any age) → throw (caller: offline grid).
   */
  private async runWaves<T>(
    query: string,
    parse: (data: OverpassJson) => T,
    expectGen?: number,
    cacheKey?: string,
  ): Promise<{ parsed: T; source: string }> {
    const stale = () => expectGen !== undefined && expectGen !== this.generation;
    const ck = cacheKey ? `v135:${cacheKey}` : null;
    const cached = ck ? await cacheGet<T>(ck) : null;
    const count = (src: string) => {
      overpassStats.lastSource = src;
      overpassStats.bySource[src] = (overpassStats.bySource[src] ?? 0) + 1;
    };
    if (cached && cached.ageMs < CACHE_FRESH_MS) {
      overpassStats.cacheFresh++;
      count('cache');
      return { parsed: cached.data, source: 'cache' };
    }
    const t0 = performance.now();
    let lastError: unknown = new Error('Overpass: no mirror tried');
    try {
      const res = await this.raceMirrors(query, parse, stale, t0);
      overpassStats.ok++;
      overpassStats.lastMs = Math.round(performance.now() - t0);
      count(res.source);
      if (ck) void cachePut(ck, res.parsed);
      return res;
    } catch (err) {
      lastError = err;
    }
    if (stale()) throw new Error('Overpass request cancelled (stale generation)');
    if (cached) {
      overpassStats.cacheStale++;
      count('cache-stale');
      return { parsed: cached.data, source: 'cache-stale' };
    }
    overpassStats.failed++;
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Walk the mirrors; at most two attempts in flight (the second starts after
   * HEDGE_MS, or once the first fails). Retryable failures back off
   * (1.5 s, 3 s, 6 s… ± jitter) before the next attempt.
   */
  private raceMirrors<T>(
    query: string,
    parse: (data: OverpassJson) => T,
    stale: () => boolean,
    t0: number,
  ): Promise<{ parsed: T; source: string }> {
    return new Promise((resolve, reject) => {
      // healthy-first order, then a second pass if the budget allows
      const queue = [...orderedMirrors(), ...orderedMirrors()];
      let inFlight = 0;
      let done = false;
      let failures = 0;
      let lastErr: unknown = new Error('Overpass: all mirrors failed');
      let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        if (hedgeTimer) clearTimeout(hedgeTimer);
        fn();
      };
      const launch = (): void => {
        if (done) return;
        if (stale()) {
          finish(() => reject(new Error('Overpass request cancelled (stale generation)')));
          return;
        }
        const elapsed = performance.now() - t0;
        const m = elapsed < REQUEST_BUDGET_MS - 5_000 ? queue.shift() : undefined;
        if (!m) {
          if (inFlight === 0) finish(() => reject(lastErr));
          return;
        }
        inFlight++;
        const timeout = Math.min(OVERPASS_ATTEMPT_MS, REQUEST_BUDGET_MS - elapsed);
        const viaProxy = proxiesUsable;
        const ep = viaProxy ? m.proxy : `${m.direct}?client=${encodeURIComponent(OVERPASS_CLIENT_ID)}`;
        this.postQuery(ep, query, parse, timeout).then(
          (parsed) => {
            inFlight--;
            m.coolUntil = 0;
            finish(() => resolve({ parsed, source: viaProxy ? `${m.name} (proxy)` : m.name }));
          },
          async (err: unknown) => {
            inFlight--;
            if (done) return;
            lastErr = err;
            failures++;
            const status = err instanceof OverpassHttpError ? err.status : 0;
            if (viaProxy && (status === 404 || status === 405 || err instanceof SyntaxError)) {
              // No same-origin proxy (static hosting): go direct from now on
              proxiesUsable = false;
              queue.unshift(m);
              launch();
              return;
            }
            m.coolUntil = performance.now() + 60_000;
            if (status === 0 || RETRY_STATUS.has(status)) {
              overpassStats.retries++;
              const back = Math.min(8_000, 1_500 * 2 ** Math.min(3, failures - 1)) * (0.75 + Math.random() * 0.5);
              await sleep(back);
            }
            if (done) return;
            if (inFlight < 2) launch();
            if (inFlight === 0) finish(() => reject(lastErr));
          },
        );
        if (inFlight === 1) {
          if (hedgeTimer) clearTimeout(hedgeTimer);
          hedgeTimer = setTimeout(() => {
            hedgeTimer = null;
            if (!done && inFlight < 2) launch();
          }, HEDGE_MS);
        }
      };
      launch();
    });
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
          const res = await this.runWaves(relationQuery(want), parseRelations, expectGen, `rel:${want.join(',')}`);
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

  /**
   * v1.3.4: water-boundary ways (members of water multipolygons such as Lake
   * Ontario, closed water ways, coastline) plus piers / breakwaters in a bbox,
   * for the near-camera Great-Lake shoreline mask. Same mirror order as tiles.
   */
  async fetchShore(
    south: number,
    west: number,
    north: number,
    east: number,
    expectGen?: number,
  ): Promise<ShoreWays> {
    const bb = `${south},${west},${north},${east}`;
    const query = `[out:json][timeout:20];
rel["natural"="water"](${bb})->.r;
(way(r.r)(${bb});way["natural"="water"](${bb});way["natural"="coastline"](${bb}););
out geom;
way["man_made"~"^(pier|breakwater|groyne)$"](${bb});
out geom;`;
    await this.acquireSlot();
    try {
      const res = await this.runWaves(query, parseShore, expectGen, `shore:${bb}`);
      return res.parsed;
    } finally {
      this.releaseSlot();
    }
  }

  private async postQuery<T>(
    endpoint: string,
    query: string,
    parse: (data: OverpassJson) => T,
    timeoutMs = OVERPASS_ATTEMPT_MS,
  ): Promise<T> {
    const ctrl = new AbortController();
    this.activeAborts.add(ctrl);
    const abortTimer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        // CORS-safelisted header only: no preflight on the public mirrors
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `data=${encodeURIComponent(query)}`,
        signal: ctrl.signal,
      });

      if (!res.ok) throw new OverpassHttpError(res.status, endpoint);
      const json = (await res.json()) as OverpassJson & { remark?: string };
      // A server-side timeout is a 200 with a remark and no / partial elements
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) {
        throw new OverpassHttpError(504, endpoint);
      }
      return parse(json);
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

export interface ShoreWays {
  barriers: OsmNode[][];
  landAreas: OsmNode[][];
  landLines: OsmNode[][];
}

function parseShore(data: OverpassJson): ShoreWays {
  const out: ShoreWays = { barriers: [], landAreas: [], landLines: [] };
  const seen = new Set<number>();
  for (const el of data.elements ?? []) {
    if (el.type !== 'way' || seen.has(el.id)) continue;
    seen.add(el.id);
    const g = cleanGeom(el.geometry);
    if (g.length < 2) continue;
    const t = el.tags ?? {};
    const closed =
      g.length >= 4 && Math.abs(g[0].lat - g[g.length - 1].lat) < 1e-7 && Math.abs(g[0].lon - g[g.length - 1].lon) < 1e-7;
    if (t.man_made === 'pier' || t.man_made === 'breakwater' || t.man_made === 'groyne') {
      if (closed && t.area !== 'no') out.landAreas.push(g);
      else out.landLines.push(g);
      continue;
    }
    out.barriers.push(g);
  }
  return out;
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
