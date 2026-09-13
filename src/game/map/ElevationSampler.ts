/**
 * Real DEM via AWS Open Data Terrarium tiles (Mapzen/Joerd lineage).
 * URL: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 * Decode: (R * 256 + G + B / 256) - 32768  → meters
 * No API key. Streaming with map chunks.
 *
 * v1.2c: fetch timeouts, NaN guards, tile cache cap, dispose.
 */

const TILE_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const ZOOM = 12;
const SIZE = 256;
/** Abort a single Terrarium PNG fetch after this many ms. */
const DEM_FETCH_MS = 8_000;
/** Soft cap on cached DEM tiles to limit memory. */
const MAX_DEM_TILES = 64;

interface DemTile {
  key: string;
  data: Uint8ClampedArray;
  loading?: Promise<void>;
  lastAccess: number;
}

function lonLatToTileFrac(
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

export class ElevationSampler {
  private tiles = new Map<string, DemTile>();
  private originElev: number | null = null;
  /** Last successfully sampled absolute elevation (m). Used when tiles time out. */
  private lastKnownAbs: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  /** Relative height (meters) above spawn elevation. Never blocks; flat/last-known on miss. */
  sampleRelative(lat: number, lon: number): number {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 0;
    const abs = this.sampleAbsolute(lat, lon);
    if (abs === null) {
      const fallback = this.lastKnownAbs ?? this.originElev ?? 0;
      if (this.originElev === null) this.originElev = fallback;
      const rel = fallback - this.originElev;
      return Number.isFinite(rel) ? rel : 0;
    }
    this.lastKnownAbs = abs;
    if (this.originElev === null) this.originElev = abs;
    const rel = abs - this.originElev;
    return Number.isFinite(rel) ? rel : 0;
  }

  /**
   * Bilinear sample in meters. Returns null if the covering tile(s) are not loaded.
   * Reads across DEM tile boundaries so seams don't crack.
   */
  sampleAbsolute(lat: number, lon: number): number | null {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const { x, y } = lonLatToTileFrac(lon, lat, ZOOM);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const tx0 = Math.floor(x);
    const ty0 = Math.floor(y);
    const fx = (x - tx0) * SIZE;
    const fy = (y - ty0) * SIZE;
    const px = Math.floor(fx);
    const py = Math.floor(fy);
    const dx = fx - px;
    const dy = fy - py;

    const h00 = this.pixelAbsolute(tx0, ty0, px, py);
    const h10 = this.pixelAbsolute(tx0, ty0, px + 1, py);
    const h01 = this.pixelAbsolute(tx0, ty0, px, py + 1);
    const h11 = this.pixelAbsolute(tx0, ty0, px + 1, py + 1);

    if (h00 === null || h10 === null || h01 === null || h11 === null) {
      void this.ensureTile(tx0, ty0);
      if (px + 1 >= SIZE) void this.ensureTile(tx0 + 1, ty0);
      if (py + 1 >= SIZE) void this.ensureTile(tx0, ty0 + 1);
      if (px + 1 >= SIZE && py + 1 >= SIZE) void this.ensureTile(tx0 + 1, ty0 + 1);
      const any = h00 ?? h10 ?? h01 ?? h11;
      return any;
    }

    const h0 = h00 * (1 - dx) + h10 * dx;
    const h1 = h01 * (1 - dx) + h11 * dx;
    const h = h0 * (1 - dy) + h1 * dy;
    return Number.isFinite(h) ? h : null;
  }

  /** Read one DEM pixel, wrapping into neighbor tiles when px/py leave [0, SIZE). */
  private pixelAbsolute(tx: number, ty: number, px: number, py: number): number | null {
    let ttx = tx;
    let tty = ty;
    let ppx = px;
    let ppy = py;
    while (ppx < 0) {
      ppx += SIZE;
      ttx -= 1;
    }
    while (ppx >= SIZE) {
      ppx -= SIZE;
      ttx += 1;
    }
    while (ppy < 0) {
      ppy += SIZE;
      tty -= 1;
    }
    while (ppy >= SIZE) {
      ppy -= SIZE;
      tty += 1;
    }

    const key = `${ZOOM}/${ttx}/${tty}`;
    const tile = this.tiles.get(key);
    if (!tile?.data || tile.data.length === 0) {
      void this.ensureTile(ttx, tty);
      return null;
    }
    tile.lastAccess = performance.now();
    const i = (ppy * SIZE + ppx) * 4;
    return decodeTerrarium(tile.data[i], tile.data[i + 1], tile.data[i + 2]);
  }

  async preloadArea(south: number, west: number, north: number, east: number): Promise<void> {
    const corners = [
      lonLatToTileFrac(west, south, ZOOM),
      lonLatToTileFrac(east, south, ZOOM),
      lonLatToTileFrac(west, north, ZOOM),
      lonLatToTileFrac(east, north, ZOOM),
    ];
    const minTx = Math.min(...corners.map((c) => Math.floor(c.x)));
    const maxTx = Math.max(...corners.map((c) => Math.floor(c.x)));
    const minTy = Math.min(...corners.map((c) => Math.floor(c.y)));
    const maxTy = Math.max(...corners.map((c) => Math.floor(c.y)));
    const jobs: Promise<void>[] = [];
    for (let ty = minTy - 1; ty <= maxTy + 1; ty++) {
      for (let tx = minTx - 1; tx <= maxTx + 1; tx++) {
        jobs.push(this.ensureTile(tx, ty));
      }
    }
    await Promise.race([
      Promise.all(jobs),
      new Promise<void>((r) => setTimeout(r, DEM_FETCH_MS + 500)),
    ]);
  }

  async ensureOrigin(lat: number, lon: number): Promise<number> {
    const { x, y } = lonLatToTileFrac(lon, lat, ZOOM);
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    await Promise.race([
      Promise.all([
        this.ensureTile(tx, ty),
        this.ensureTile(tx + 1, ty),
        this.ensureTile(tx, ty + 1),
        this.ensureTile(tx + 1, ty + 1),
        this.ensureTile(tx - 1, ty),
        this.ensureTile(tx, ty - 1),
      ]),
      new Promise<void>((r) => setTimeout(r, DEM_FETCH_MS + 500)),
    ]);
    const abs = this.sampleAbsolute(lat, lon);
    this.originElev = abs ?? this.lastKnownAbs ?? 0;
    if (abs !== null) this.lastKnownAbs = abs;
    return this.originElev;
  }

  getOriginElevation(): number {
    return this.originElev ?? 0;
  }

  private trimCache(): void {
    if (this.tiles.size <= MAX_DEM_TILES) return;
    const ranked = [...this.tiles.values()]
      .filter((t) => t.data.length > 0 && !t.loading)
      .sort((a, b) => a.lastAccess - b.lastAccess);
    while (this.tiles.size > MAX_DEM_TILES && ranked.length) {
      const old = ranked.shift()!;
      this.tiles.delete(old.key);
    }
  }

  private ensureTile(tx: number, ty: number): Promise<void> {
    const key = `${ZOOM}/${tx}/${ty}`;
    let tile = this.tiles.get(key);
    if (tile?.data && tile.data.length > 0) {
      tile.lastAccess = performance.now();
      return Promise.resolve();
    }
    if (tile?.loading) return tile.loading;

    tile = { key, data: new Uint8ClampedArray(0), lastAccess: performance.now() };
    this.tiles.set(key, tile);

    const url = TILE_URL.replace('{z}', String(ZOOM))
      .replace('{x}', String(tx))
      .replace('{y}', String(ty));

    tile.loading = (async () => {
      const ctrl = new AbortController();
      const abortTimer = setTimeout(() => ctrl.abort(), DEM_FETCH_MS);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`DEM ${res.status}`);
        const blob = await res.blob();
        const bitmap = await createImageBitmap(blob);
        if (!this.canvas) {
          this.canvas = document.createElement('canvas');
          this.canvas.width = SIZE;
          this.canvas.height = SIZE;
          this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        }
        const ctx = this.ctx!;
        ctx.clearRect(0, 0, SIZE, SIZE);
        ctx.drawImage(bitmap, 0, 0);
        const img = ctx.getImageData(0, 0, SIZE, SIZE);
        tile!.data = img.data;
        tile!.lastAccess = performance.now();
        bitmap.close();
        this.trimCache();
      } catch (err) {
        console.warn('Terrarium tile failed/timeout', key, err);
        this.tiles.delete(key);
      } finally {
        clearTimeout(abortTimer);
        if (tile) tile.loading = undefined;
      }
    })();

    return tile.loading;
  }

  /** Drop cached DEM tiles (call on TileManager dispose). */
  dispose(): void {
    this.tiles.clear();
    this.originElev = null;
    this.lastKnownAbs = null;
    this.canvas = null;
    this.ctx = null;
  }
}
