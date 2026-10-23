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
  /** v1.3.6: a server-side timeout returned only part of the tile (kept, upgraded later). */
  partial?: boolean;
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
 * v1.3.6 per-attempt fetch timeout (ms). QA 1.3.5 measured maps.mail.ru at a
 * 22 s median (15–34 s) and overpass-api.de at 27 s (19–42 s): the old 30 s
 * attempt / 9 s hedge aborted good answers and re-queued them (retry storm).
 */
export const OVERPASS_ATTEMPT_MS = 55_000;
/** Server-side [timeout:] for tile queries (s): must outlast a slow queue. */
const SERVER_TIMEOUT_S = 45;
/** Hedge a second mirror only after this (ms), and only if few requests are out. */
const HEDGE_MS = 35_000;
/** Cap on attempts in flight across all requests before a hedge may start. */
const HEDGE_MAX_GLOBAL = 3;
/** Default network budget for one request (ms) → cache → offline grid. */
const REQUEST_BUDGET_MS = 150_000;
/** A cached response younger than this is used without asking a mirror. */
const CACHE_FRESH_MS = 24 * 3600_000;
/** Cap in-flight Overpass requests across the client (v1.3.6: 3 → 2). */
const MAX_CONCURRENT = 2;
/** Soft cap on memory cache entries. */
const MAX_CACHE = 96;
/** IndexedDB key prefix (v1.3.6 entries carry a `partial` flag). */
const CACHE_PREFIX = 'v136:';

/**
 * Identification. Mirrors reject anonymous clients (overpass-api.de → 406,
 * kumi / private.coffee → 429 "include a meaningful User-Agent"). Browsers
 * can't set User-Agent from fetch (they send their own), so direct requests
 * also carry `?client=` (accepted by the interpreter, verified from nigian);
 * the Vite proxies and Electron set a real User-Agent (vite.config.ts,
 * electron/main.cjs).
 */
export const OVERPASS_CLIENT_ID = 'nig-drives/1.3.11';

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
 * v1.3.6 mirror tiers (QA 1.3.5, 2026-10-23): overpass-api.de and
 * maps.mail.ru answer (22–27 s medians); kumi had 0 successes and
 * private.coffee 1, so they are last-resort only (tier 1) with a 10 min
 * cooldown after a failure. Primary mirrors cool down per mirror,
 * exponentially (15 s, 30 s, 60 s … 5 min). Same-origin Vite proxies
 * (dev / preview: no CORS, real User-Agent) are used when the page is served
 * over http(s); a 404 / HTML answer disables them for the session.
 */
interface Mirror {
  name: string;
  direct: string;
  proxy: string;
  /** 0 = primary, 1 = last resort. */
  tier: 0 | 1;
  /** performance.now() until which this mirror is not asked. */
  coolUntil: number;
  /** consecutive failures (drives the cooldown). */
  fails: number;
  /** attempts currently out on this mirror (all requests). */
  busy: number;
  /** smoothed answer time (ms), 0 = unknown. */
  emaMs: number;
}

const mirror = (name: string, direct: string, proxy: string, tier: 0 | 1): Mirror => ({
  name,
  direct,
  proxy,
  tier,
  coolUntil: 0,
  fails: 0,
  busy: 0,
  emaMs: 0,
});

const MIRRORS: Mirror[] = [
  mirror('maps.mail.ru', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', '/api/overpass-mailru', 0),
  mirror('overpass-api.de', 'https://overpass-api.de/api/interpreter', '/api/overpass-de', 0),
  mirror('kumi', 'https://overpass.kumi.systems/api/interpreter', '/api/overpass-kumi', 1),
  mirror('private.coffee', 'https://overpass.private.coffee/api/interpreter', '/api/overpass-coffee', 1),
];

/** Attempts in flight across every request (hedges only start below HEDGE_MAX_GLOBAL). */
let attemptsOut = 0;

function coolMirror(m: Mirror): void {
  m.fails++;
  const ms = m.tier === 1 ? 600_000 : Math.min(300_000, 15_000 * 2 ** Math.min(5, m.fails - 1));
  m.coolUntil = performance.now() + ms;
}

/**
 * Best mirror to ask now (not cooling, not already used by this request):
 * primaries by fewest attempts out, then fastest; last-resort mirrors only
 * when every primary is cooling. When nothing is available, `waitMs` is the
 * time until the first mirror leaves its cooldown.
 */
function pickMirror(exclude: Set<Mirror>): { mirror: Mirror | null; waitMs: number } {
  const now = performance.now();
  const free = MIRRORS.filter((m) => !exclude.has(m) && m.coolUntil <= now);
  const prim = free.filter((m) => m.tier === 0);
  const allPrimCooling = MIRRORS.every((m) => m.tier !== 0 || m.coolUntil > now);
  const pool = prim.length ? prim : allPrimCooling ? free : [];
  if (pool.length) {
    pool.sort((a, b) => a.busy - b.busy || (a.emaMs || 25_000) - (b.emaMs || 25_000));
    return { mirror: pool[0], waitMs: 0 };
  }
  let wait = Infinity;
  for (const m of MIRRORS) if (!exclude.has(m) && m.tier === 0) wait = Math.min(wait, m.coolUntil - now);
  return { mirror: null, waitMs: Number.isFinite(wait) ? Math.max(0, wait) : 15_000 };
}

let proxiesUsable = typeof location !== 'undefined' && /^https?:$/.test(location.protocol);

/** IndexedDB envelope (v1.3.6). */
interface CacheBox<T> {
  d: T;
  partial: boolean;
}

/** HTTP statuses counted as retryable (the mirror cools down, the next one is asked). */
const RETRY_STATUS = new Set([429, 502, 503, 504]);

class OverpassHttpError extends Error {
  readonly status: number;
  constructor(status: number, endpoint: string) {
    super(`Overpass ${status} from ${endpoint}`);
    this.status = status;
  }
}

/** Request stats for QA (`__nig.game.tiles.overpassStats()`). */
export const overpassStats = {
  ok: 0,
  cacheFresh: 0,
  cacheStale: 0,
  failed: 0,
  retries: 0,
  /** v1.3.6: tiles answered from memory / IndexedDB (fresh or stale). */
  cacheHits: 0,
  memoryHits: 0,
  partial: 0,
  hedges: 0,
  aborted: 0,
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

  private async acquireSlot(priority = false): Promise<void> {
    if (this.inFlight < MAX_CONCURRENT) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => {
      const w = () => {
        this.inFlight++;
        resolve();
      };
      if (priority) this.waiters.unshift(w);
      else this.waiters.push(w);
    });
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * v1.3.6: cached tile only (memory, then IndexedDB at any age), never the
   * network — the spawn tile builds from this when it can, else starts on
   * the offline grid and upgrades in the background.
   */
  async peekTile(key: string): Promise<OverpassResult | null> {
    const mem = this.memoryCache.get(key);
    if (mem) {
      overpassStats.memoryHits++;
      overpassStats.cacheHits++;
      return { ...mem, source: 'memory' };
    }
    const c = await cacheGet<CacheBox<ParsedTile>>(`${CACHE_PREFIX}tile:${key}`);
    if (!c || !c.data || !c.data.d) return null;
    overpassStats.cacheHits++;
    if (c.ageMs < CACHE_FRESH_MS) overpassStats.cacheFresh++;
    else overpassStats.cacheStale++;
    if (!c.data.partial) this.setCached(key, c.data.d);
    return { ...c.data.d, source: c.ageMs < CACHE_FRESH_MS ? 'cache' : 'cache-stale', partial: c.data.partial };
  }

  /**
   * Fetch highways + buildings + areas for a tile bbox: memory → IndexedDB
   * (fresh) → mirrors (tiered, per-mirror cooldown) → stale / partial cache →
   * throw. `priority` jumps the slot queue (the tile under the car).
   */
  async fetchTile(
    key: string,
    south: number,
    west: number,
    north: number,
    east: number,
    expectGen?: number,
    budgetMs = REQUEST_BUDGET_MS,
    priority = false,
  ): Promise<OverpassResult> {
    const cached = this.memoryCache.get(key);
    if (cached) {
      overpassStats.memoryHits++;
      overpassStats.cacheHits++;
      return { ...cached, source: 'memory' };
    }

    if (expectGen !== undefined && expectGen !== this.generation) {
      throw new Error('Overpass request cancelled (stale generation)');
    }

    await this.acquireSlot(priority);
    try {
      if (expectGen !== undefined && expectGen !== this.generation) {
        throw new Error('Overpass request cancelled (stale generation)');
      }

      const query = buildQuery(south, west, north, east);
      const res = await this.runWaves(query, (d) => parseTile(d), expectGen, `tile:${key}`, budgetMs);
      if (!res.partial) {
        this.memoryCache.set(key, res.parsed);
        this.trimCache();
      }
      return { ...res.parsed, source: res.source, partial: res.partial };
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * v1.3.6: cache (fresh, complete) → mirrors → cache (any age, complete) →
   * partial (fresh from a server timeout, or cached) → throw. Every complete
   * answer is written to IndexedDB; a partial one only when nothing better is
   * cached.
   */
  private async runWaves<T>(
    query: string,
    parse: (data: OverpassJson) => T,
    expectGen?: number,
    cacheKey?: string,
    budgetMs = REQUEST_BUDGET_MS,
  ): Promise<{ parsed: T; source: string; partial?: boolean }> {
    const stale = () => expectGen !== undefined && expectGen !== this.generation;
    const ck = cacheKey ? `${CACHE_PREFIX}${cacheKey}` : null;
    const got = ck ? await cacheGet<CacheBox<T>>(ck) : null;
    const cached = got && got.data && got.data.d !== undefined ? { ageMs: got.ageMs, d: got.data.d, partial: !!got.data.partial } : null;
    const count = (src: string) => {
      overpassStats.lastSource = src;
      overpassStats.bySource[src] = (overpassStats.bySource[src] ?? 0) + 1;
    };
    if (cached && !cached.partial && cached.ageMs < CACHE_FRESH_MS) {
      overpassStats.cacheFresh++;
      overpassStats.cacheHits++;
      count('cache');
      return { parsed: cached.d, source: 'cache' };
    }
    const t0 = performance.now();
    let lastError: unknown = new Error('Overpass: no mirror tried');
    let partial: { parsed: T; source: string } | null = null;
    try {
      const res = await this.raceMirrors(query, parse, stale, t0, budgetMs);
      if (!res.partial) {
        overpassStats.ok++;
        overpassStats.lastMs = Math.round(performance.now() - t0);
        count(res.source);
        if (ck) void cachePut(ck, { d: res.parsed, partial: false });
        return { parsed: res.parsed, source: res.source };
      }
      partial = { parsed: res.parsed, source: res.source };
    } catch (err) {
      lastError = err;
    }
    if (stale()) throw new Error('Overpass request cancelled (stale generation)');
    if (cached && !cached.partial) {
      overpassStats.cacheStale++;
      overpassStats.cacheHits++;
      count('cache-stale');
      return { parsed: cached.d, source: 'cache-stale' };
    }
    if (partial) {
      overpassStats.partial++;
      count(`${partial.source} partial`);
      if (ck) void cachePut(ck, { d: partial.parsed, partial: true });
      return { parsed: partial.parsed, source: `${partial.source} partial`, partial: true };
    }
    if (cached) {
      overpassStats.partial++;
      overpassStats.cacheHits++;
      count('cache-partial');
      return { parsed: cached.d, source: 'cache-partial', partial: true };
    }
    overpassStats.failed++;
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * v1.3.6: one attempt at a time on the best mirror (attempt ≤ 55 s); a
   * hedge on a second primary only after HEDGE_MS and while fewer than
   * HEDGE_MAX_GLOBAL attempts are out client-wide. A failed mirror cools down
   * (per mirror, exponential); when every mirror is cooling the request waits
   * for the first one instead of hammering. A server-side timeout that still
   * returned elements is kept as a partial fallback while other mirrors try.
   */
  private raceMirrors<T>(
    query: string,
    parse: (data: OverpassJson) => T,
    stale: () => boolean,
    t0: number,
    budgetMs: number,
  ): Promise<{ parsed: T; source: string; partial?: boolean }> {
    return new Promise((resolve, reject) => {
      const out = new Map<Mirror, AbortController>();
      let done = false;
      let lastErr: unknown = new Error('Overpass: all mirrors failed');
      let best: { parsed: T; source: string } | null = null;
      let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
      let waitTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        if (hedgeTimer) clearTimeout(hedgeTimer);
        if (waitTimer) clearTimeout(waitTimer);
        // the losing attempt is no longer needed: free the mirror
        for (const c of out.values()) {
          overpassStats.aborted++;
          try {
            c.abort();
          } catch {
            /* ignore */
          }
        }
        out.clear();
        fn();
      };
      const giveUp = () => finish(() => (best ? resolve({ ...best, partial: true }) : reject(lastErr)));
      const launch = (hedge = false): void => {
        if (done) return;
        if (stale()) {
          finish(() => reject(new Error('Overpass request cancelled (stale generation)')));
          return;
        }
        const left = budgetMs - (performance.now() - t0);
        if (left < 8_000) {
          if (out.size === 0) giveUp();
          return;
        }
        const pick = pickMirror(new Set(out.keys()));
        const m = pick.mirror;
        if (!m) {
          if (out.size === 0) {
            if (pick.waitMs > left - 8_000) {
              giveUp();
              return;
            }
            if (waitTimer) clearTimeout(waitTimer);
            waitTimer = setTimeout(() => {
              waitTimer = null;
              launch();
            }, pick.waitMs + 50);
          }
          return;
        }
        if (hedge) overpassStats.hedges++;
        const timeout = Math.min(OVERPASS_ATTEMPT_MS, left);
        const viaProxy = proxiesUsable;
        const ep = viaProxy ? m.proxy : `${m.direct}?client=${encodeURIComponent(OVERPASS_CLIENT_ID)}`;
        const ctrl = new AbortController();
        out.set(m, ctrl);
        m.busy++;
        attemptsOut++;
        const tA = performance.now();
        const settle = () => {
          m.busy = Math.max(0, m.busy - 1);
          attemptsOut = Math.max(0, attemptsOut - 1);
          out.delete(m);
        };
        this.postQuery(ep, query, parse, timeout, ctrl).then(
          (r) => {
            settle();
            const src = viaProxy ? `${m.name} (proxy)` : m.name;
            if (done) return;
            if (!r.partial) {
              m.fails = 0;
              m.coolUntil = 0;
              const ms = performance.now() - tA;
              m.emaMs = m.emaMs ? m.emaMs * 0.6 + ms * 0.4 : ms;
              finish(() => resolve({ parsed: r.parsed, source: src }));
              return;
            }
            // server timed out mid-query: keep what came back, try elsewhere
            best = { parsed: r.parsed, source: src };
            coolMirror(m);
            if (out.size === 0) launch();
          },
          (err: unknown) => {
            settle();
            if (done) return;
            lastErr = err;
            const status = err instanceof OverpassHttpError ? err.status : 0;
            if (viaProxy && (status === 404 || status === 405 || err instanceof SyntaxError)) {
              // No same-origin proxy (static hosting): go direct from now on
              proxiesUsable = false;
              if (out.size === 0) launch();
              return;
            }
            coolMirror(m);
            if (status === 0 || RETRY_STATUS.has(status)) overpassStats.retries++;
            if (out.size === 0) launch();
          },
        );
        if (out.size === 1) {
          if (hedgeTimer) clearTimeout(hedgeTimer);
          hedgeTimer = setTimeout(() => {
            hedgeTimer = null;
            if (!done && out.size === 1 && attemptsOut < HEDGE_MAX_GLOBAL) launch(true);
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
    ctrl = new AbortController(),
  ): Promise<{ parsed: T; partial: boolean }> {
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
        if (!json.elements || json.elements.length === 0) throw new OverpassHttpError(504, endpoint);
        return { parsed: parse(json), partial: true };
      }
      return { parsed: parse(json), partial: false };
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
