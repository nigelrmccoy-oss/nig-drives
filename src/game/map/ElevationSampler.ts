import { cachedDem } from './OverpassCache';
/**
 * Real DEM via AWS Open Data Terrarium tiles (Mapzen/Joerd lineage).
 * URL: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 * Decode: (R * 256 + G + B / 256) - 32768  → meters
 * No API key. Streaming with map chunks.
 *
 * v1.2c: fetch timeouts, NaN guards, tile cache cap, dispose.
 * v1.3.2: pixel-centre bilinear sampling (was offset by half a DEM pixel),
 *         strict 4-tap sampling (null until every tap is loaded — no more
 *         "last known height" plateaus), Float32 height cache with numeric
 *         keys, configurable zoom, and a tile-loaded listener so roads and
 *         buildings can be re-heighted when late tiles arrive.
 * v1.5.0a: optional high-res layer (`hires`): baked Canada HRDEM 1 m LiDAR DTM
 *         tiles (z16, ~1.7 m/px, Terrarium-encoded, scripts/bake-dem.py) on top
 *         of the Terrarium tiles. Where a baked tile or pixel does not exist
 *         (outside the baked areas, lakes, no LiDAR, no files at all) the
 *         sample falls back to Terrarium, so a missing pack changes nothing.
 */

const TILE_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const SIZE = 256;
/** Abort a single Terrarium PNG fetch after this many ms. */
const DEM_FETCH_MS = 8_000;
/** Don't hammer S3 for a tile that just failed. */
const RETRY_AFTER_MS = 6_000;

interface DemTile {
  key: number;
  tx: number;
  ty: number;
  heights: Float32Array | null;
  loading?: Promise<void>;
  lastAccess: number;
  failedAt?: number;
}

export function lonLatToTileFrac(
  lon: number,
  lat: number,
  z: number,
): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

function decodeTerrarium(r: number, g: number, b: number): number {
  const h = r * 256 + g + b / 256 - 32768;
  return Number.isFinite(h) ? h : 0;
}

export type DemTileListener = (zoom: number, tx: number, ty: number) => void;

export interface HiResOptions {
  zoom: number;
  maxTiles: number;
  /** Tile URL template, {z}/{x}/{y}. Default `<BASE_URL>dem/{z}/{x}/{y}.png`. */
  urlTemplate?: string;
  /** Coverage index written by scripts/bake-dem.py. Default `<BASE_URL>dem/index.json`. */
  indexUrl?: string;
}

/** y -> sorted [x0, x1] runs of baked tiles. */
type DemCoverage = Map<number, Array<[number, number]>>;

/** "No data here" (as opposed to null = "not loaded yet"). */
const NODATA = Number.NaN;

function baseUrl(): string {
  return (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
}

export class ElevationSampler {
  readonly zoom: number;
  private readonly maxTiles: number;
  private tiles = new Map<number, DemTile>();
  private originElev: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private listeners = new Set<DemTileListener>();
  private disposed = false;
  /** v1.5.0a: baked high-res layer (only on the near sampler). */
  private hr: ElevationSampler | null = null;
  /** v1.5.0a: set on a baked layer itself: its URL template (R=G=B=0 pixels are no-data). */
  private readonly bakedUrl: string | null;
  private coverage: DemCoverage | null = null;
  private coverageKnown = true;
  private coverageReady: Promise<void> = Promise.resolve();
  /** Samples answered from the baked layer / from Terrarium (QA: demInfo()). */
  private hrHits = 0;
  private baseHits = 0;

  constructor(zoom = 12, maxTiles = 64, hires?: HiResOptions, bakedUrl?: string) {
    this.zoom = zoom;
    this.maxTiles = maxTiles;
    this.bakedUrl = bakedUrl ?? null;
    if (hires) {
      const layer = new ElevationSampler(
        hires.zoom,
        hires.maxTiles,
        undefined,
        hires.urlTemplate ?? `${baseUrl()}dem/{z}/{x}/{y}.png`,
      );
      layer.coverageKnown = false;
      layer.coverageReady = layer.loadCoverage(hires.indexUrl ?? `${baseUrl()}dem/index.json`);
      layer.onTileLoaded((z, x, y) => {
        for (const fn of this.listeners) fn(z, x, y);
      });
      this.hr = layer;
    }
  }

  /** Fetch the baked-tile index. Any failure (no pack, file://) = no baked coverage. */
  private async loadCoverage(url: string): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`index ${res.status}`);
      const j = (await res.json()) as { zoom?: number; rows?: Record<string, Array<[number, number]>> };
      if (j.zoom !== this.zoom || !j.rows) throw new Error('index zoom mismatch');
      const cov: DemCoverage = new Map();
      for (const [y, runs] of Object.entries(j.rows)) cov.set(Number(y), runs);
      this.coverage = cov;
    } catch {
      this.coverage = new Map();
    } finally {
      clearTimeout(timer);
      this.coverageKnown = true;
      if (!this.disposed) for (const fn of this.listeners) fn(this.zoom, -1, -1);
    }
  }

  private hasBaked(tx: number, ty: number): boolean {
    const runs = this.coverage?.get(ty);
    if (!runs) return false;
    for (const [a, b] of runs) {
      if (tx >= a && tx <= b) return true;
      if (tx < a) return false;
    }
    return false;
  }

  /** True when a baked tile pack was found (QA / debug HUD). */
  hasHiRes(): boolean {
    return !!this.hr && (this.hr.coverage?.size ?? 0) > 0;
  }

  /** Which source answered how many samples (QA). */
  demInfo(): { hiRes: boolean; zoomHiRes: number | null; hrSamples: number; baseSamples: number; hrTiles: number; baseTiles: number } {
    return {
      hiRes: this.hasHiRes(),
      zoomHiRes: this.hr ? this.hr.zoom : null,
      hrSamples: this.hrHits,
      baseSamples: this.baseHits,
      hrTiles: this.hr?.loadedTileCount() ?? 0,
      baseTiles: this.loadedTileCount(),
    };
  }

  private key(tx: number, ty: number): number {
    // tx, ty < 2^zoom (≤ 2^16 for any zoom we use) → unique, exact in a double
    return tx * 131072 + ty;
  }

  onTileLoaded(fn: DemTileListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Use another sampler's origin so relative heights agree across zooms. */
  setOriginElevation(abs: number): void {
    this.originElev = abs;
  }

  /** Relative height (m) above spawn elevation, or null if any tap is missing. */
  sampleRelative(lat: number, lon: number): number | null {
    const abs = this.sampleAbsolute(lat, lon);
    if (abs === null || this.originElev === null) return null;
    const rel = abs - this.originElev;
    return Number.isFinite(rel) ? rel : null;
  }

  /**
   * Bilinear sample in meters between DEM pixel CENTRES. Returns null unless all
   * four taps are loaded (and queues the missing tiles). Reads across DEM tile
   * boundaries so seams don't crack.
   */
  sampleAbsolute(lat: number, lon: number): number | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (this.hr) {
      const hi = this.hr.sampleAbsolute(lat, lon);
      if (hi === null) return null; // baked tile still loading: same "not yet" as a Terrarium tile
      if (!Number.isNaN(hi)) {
        this.hrHits++;
        return hi;
      }
      this.baseHits++;
    }
    const { x, y } = lonLatToTileFrac(lon, lat, this.zoom);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Global pixel coordinates; pixel (i, j) covers [i, i+1) so its centre is i + 0.5
    const gx = x * SIZE - 0.5;
    const gy = y * SIZE - 0.5;
    const px = Math.floor(gx);
    const py = Math.floor(gy);
    const dx = gx - px;
    const dy = gy - py;

    const h00 = this.pixel(px, py);
    const h10 = this.pixel(px + 1, py);
    const h01 = this.pixel(px, py + 1);
    const h11 = this.pixel(px + 1, py + 1);
    if (h00 === null || h10 === null || h01 === null || h11 === null) return null;
    if (h00 !== h00 || h10 !== h10 || h01 !== h01 || h11 !== h11) return NODATA;

    const h0 = h00 * (1 - dx) + h10 * dx;
    const h1 = h01 * (1 - dx) + h11 * dx;
    const h = h0 * (1 - dy) + h1 * dy;
    return Number.isFinite(h) ? h : null;
  }

  /** Read one DEM pixel by global pixel coordinate; null (and queue) if not loaded. */
  private pixel(gpx: number, gpy: number): number | null {
    const tx = Math.floor(gpx / SIZE);
    const ty = Math.floor(gpy / SIZE);
    if (this.bakedUrl !== null) {
      if (!this.coverageKnown) return null;
      if (!this.hasBaked(tx, ty)) return NODATA;
    }
    const tile = this.tiles.get(this.key(tx, ty));
    if (!tile || !tile.heights) {
      void this.ensureTile(tx, ty);
      // a baked tile that failed to load is "no data" (Terrarium answers) until a retry lands
      if (this.bakedUrl !== null && tile?.failedAt !== undefined && !tile.loading) return NODATA;
      return null;
    }
    tile.lastAccess = performance.now();
    const lx = gpx - tx * SIZE;
    const ly = gpy - ty * SIZE;
    return tile.heights[ly * SIZE + lx];
  }

  private tileRange(
    south: number,
    west: number,
    north: number,
    east: number,
    pad: number,
  ): { minTx: number; maxTx: number; minTy: number; maxTy: number } {
    const a = lonLatToTileFrac(west, north, this.zoom);
    const b = lonLatToTileFrac(east, south, this.zoom);
    // Pad by half a pixel so centre-sampling at the bbox edge has its neighbours
    const e = 1 / SIZE;
    return {
      minTx: Math.floor(Math.min(a.x, b.x) - e) - pad,
      maxTx: Math.floor(Math.max(a.x, b.x) + e) + pad,
      minTy: Math.floor(Math.min(a.y, b.y) - e) - pad,
      maxTy: Math.floor(Math.max(a.y, b.y) + e) + pad,
    };
  }

  /** True when every DEM tile covering the bbox is loaded. */
  isAreaLoaded(south: number, west: number, north: number, east: number): boolean {
    if (this.hr && !this.hr.isAreaLoaded(south, west, north, east)) return false;
    const r = this.tileRange(south, west, north, east, 0);
    for (let ty = r.minTy; ty <= r.maxTy; ty++) {
      for (let tx = r.minTx; tx <= r.maxTx; tx++) {
        if (this.bakedUrl !== null) {
          if (!this.coverageKnown) return false;
          const t = this.tiles.get(this.key(tx, ty));
          // not baked, or baked but failed: nothing to wait for
          if (!this.hasBaked(tx, ty) || (t?.failedAt !== undefined && !t.loading && !t.heights)) continue;
          if (!t?.heights) return false;
          continue;
        }
        if (!this.tiles.get(this.key(tx, ty))?.heights) return false;
      }
    }
    return true;
  }

  /** Fetch every tile covering the bbox. Resolves when all settle or after `budgetMs`. */
  async preloadArea(
    south: number,
    west: number,
    north: number,
    east: number,
    budgetMs = DEM_FETCH_MS + 500,
  ): Promise<boolean> {
    const r = this.tileRange(south, west, north, east, 0);
    const jobs: Promise<void>[] = [];
    if (this.hr) jobs.push(this.hr.preloadArea(south, west, north, east, budgetMs).then(() => undefined));
    if (this.bakedUrl !== null) {
      await this.coverageReady;
      if (this.disposed) return true;
    }
    for (let ty = r.minTy; ty <= r.maxTy; ty++) {
      for (let tx = r.minTx; tx <= r.maxTx; tx++) {
        if (this.bakedUrl !== null && !this.hasBaked(tx, ty)) continue;
        jobs.push(this.ensureTile(tx, ty, true));
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(jobs),
      new Promise<void>((res) => {
        timer = setTimeout(res, budgetMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return this.isAreaLoaded(south, west, north, east);
  }

  async ensureOrigin(lat: number, lon: number): Promise<number> {
    const d = 0.004;
    await this.preloadArea(lat - d, lon - d, lat + d, lon + d);
    const abs = this.sampleAbsolute(lat, lon);
    this.originElev = abs ?? 0;
    return this.originElev;
  }

  hasOrigin(): boolean {
    return this.originElev !== null;
  }

  getOriginElevation(): number {
    return this.originElev ?? 0;
  }

  loadedTileCount(): number {
    return this.countTiles();
  }

  private countTiles(): number {
    let n = 0;
    for (const t of this.tiles.values()) if (t.heights) n++;
    return n;
  }

  private trimCache(): void {
    if (this.tiles.size <= this.maxTiles) return;
    const ranked = [...this.tiles.values()]
      .filter((t) => t.heights && !t.loading)
      .sort((a, b) => a.lastAccess - b.lastAccess);
    while (this.tiles.size > this.maxTiles && ranked.length) {
      const old = ranked.shift()!;
      this.tiles.delete(old.key);
    }
  }

  private ensureTile(tx: number, ty: number, force = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const n = 2 ** this.zoom;
    if (ty < 0 || ty >= n) return Promise.resolve();
    const wtx = ((tx % n) + n) % n;
    if (wtx !== tx) return Promise.resolve();
    const key = this.key(tx, ty);
    let tile = this.tiles.get(key);
    if (tile?.heights) {
      tile.lastAccess = performance.now();
      return Promise.resolve();
    }
    if (tile?.loading) return tile.loading;
    if (
      tile?.failedAt !== undefined &&
      !force &&
      performance.now() - tile.failedAt < RETRY_AFTER_MS
    ) {
      return Promise.resolve();
    }

    tile = { key, tx, ty, heights: null, lastAccess: performance.now() };
    this.tiles.set(key, tile);
    const t = tile;

    const url = (this.bakedUrl ?? TILE_URL).replace('{z}', String(this.zoom))
      .replace('{x}', String(tx))
      .replace('{y}', String(ty));

    t.loading = (async () => {
      const ctrl = new AbortController();
      const abortTimer = setTimeout(() => ctrl.abort(), DEM_FETCH_MS);
      try {
        const blob = await cachedDem(url, ctrl.signal);
        const bitmap = await createImageBitmap(blob);
        if (this.disposed) {
          bitmap.close();
          return;
        }
        if (!this.canvas) {
          this.canvas = document.createElement('canvas');
          this.canvas.width = SIZE;
          this.canvas.height = SIZE;
          this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        }
        const ctx = this.ctx!;
        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
        const heights = new Float32Array(SIZE * SIZE);
        if (this.bakedUrl !== null) {
          // baked layer: R=G=B=0 marks "no LiDAR DTM here" (water, gaps)
          for (let i = 0, j = 0; i < heights.length; i++, j += 4) {
            heights[i] =
              data[j] === 0 && data[j + 1] === 0 && data[j + 2] === 0
                ? NODATA
                : decodeTerrarium(data[j], data[j + 1], data[j + 2]);
          }
        } else {
          for (let i = 0, j = 0; i < heights.length; i++, j += 4) {
            heights[i] = decodeTerrarium(data[j], data[j + 1], data[j + 2]);
          }
        }
        t.heights = heights;
        t.failedAt = undefined;
        t.lastAccess = performance.now();
        this.trimCache();
        for (const fn of this.listeners) fn(this.zoom, tx, ty);
      } catch (err) {
        if (this.bakedUrl === null) console.warn('Terrarium tile failed/timeout', this.zoom, tx, ty, err);
        t.failedAt = performance.now();
      } finally {
        clearTimeout(abortTimer);
        t.loading = undefined;
      }
    })();

    return t.loading;
  }

  /** Lon/lat bounds of a DEM tile (for re-height bookkeeping). */
  tileLonLatBounds(tx: number, ty: number): { south: number; west: number; north: number; east: number } {
    const n = 2 ** this.zoom;
    const lon = (x: number) => (x / n) * 360 - 180;
    const lat = (y: number) => {
      const m = Math.PI - (2 * Math.PI * y) / n;
      return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(m) - Math.exp(-m)));
    };
    return { west: lon(tx), east: lon(tx + 1), north: lat(ty), south: lat(ty + 1) };
  }

  /** Drop cached DEM tiles (call on TileManager dispose). */
  dispose(): void {
    this.disposed = true;
    this.hr?.dispose();
    this.hr = null;
    this.tiles.clear();
    this.listeners.clear();
    this.originElev = null;
    this.canvas = null;
    this.ctx = null;
  }
}
