export interface OsmNode {
  lat: number;
  lon: number;
}

export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  geometry: OsmNode[];
}

export interface OverpassResult {
  ways: OsmWay[];
  buildings: OsmWay[];
  source: string;
}

const HIGHWAY_FILTER =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|track|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';

/** Per-attempt fetch timeout (ms). Keep short so offline fallback can kick in. */
export const OVERPASS_ATTEMPT_MS = 10_000;
/** Max endpoint attempts per tile (sequential after a short parallel race). */
const MAX_ATTEMPTS = 2;
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
);
out geom;
`.trim();
}

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  '/api/overpass',
  '/api/overpass-kumi',
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
  private memoryCache = new Map<string, { ways: OsmWay[]; buildings: OsmWay[] }>();
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

  getCached(key: string): { ways: OsmWay[]; buildings: OsmWay[] } | undefined {
    return this.memoryCache.get(key);
  }

  setCached(key: string, data: { ways: OsmWay[]; buildings: OsmWay[] }): void {
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
   * Short timeouts + limited retries so callers can fall back offline quickly.
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
      let lastError: unknown;

      try {
        const raced = await withTimeout(
          Promise.any(
            ENDPOINTS.slice(0, 2).map((ep) =>
              this.postQuery(ep, query).then((parsed) => ({ parsed, source: ep })),
            ),
          ),
          OVERPASS_ATTEMPT_MS,
          'Overpass race',
        );
        if (expectGen !== undefined && expectGen !== this.generation) {
          throw new Error('Overpass request cancelled (stale generation)');
        }
        this.memoryCache.set(key, raced.parsed);
        this.trimCache();
        return { ...raced.parsed, source: raced.source };
      } catch (err) {
        lastError = err;
      }

      for (const endpoint of ENDPOINTS.slice(2, 2 + MAX_ATTEMPTS)) {
        if (expectGen !== undefined && expectGen !== this.generation) {
          throw new Error('Overpass request cancelled (stale generation)');
        }
        try {
          const parsed = await withTimeout(
            this.postQuery(endpoint, query),
            OVERPASS_ATTEMPT_MS,
            `Overpass ${endpoint}`,
          );
          this.memoryCache.set(key, parsed);
          this.trimCache();
          return { ...parsed, source: endpoint };
        } catch (err) {
          lastError = err;
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    } finally {
      this.releaseSlot();
    }
  }

  private async postQuery(
    endpoint: string,
    query: string,
  ): Promise<{ ways: OsmWay[]; buildings: OsmWay[] }> {
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

      const data = (await res.json()) as {
        elements?: Array<{
          type: string;
          id: number;
          tags?: Record<string, string>;
          geometry?: OsmNode[];
        }>;
      };

      const ways: OsmWay[] = [];
      const buildings: OsmWay[] = [];
      for (const el of data.elements ?? []) {
        if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
        const tags = el.tags ?? {};
        const item: OsmWay = { id: el.id, tags, geometry: el.geometry };
        if (tags.highway) ways.push(item);
        else if (tags.building) buildings.push(item);
      }
      // Prefer larger footprints when capping (better street fill / FPS tradeoff)
      if (buildings.length > 520) {
        buildings.sort((a, b) => footprintScore(b) - footprintScore(a));
        buildings.length = 520;
      }
      return { ways, buildings };
    } finally {
      clearTimeout(abortTimer);
      this.activeAborts.delete(ctrl);
    }
  }
}
