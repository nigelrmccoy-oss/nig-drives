/**
 * Real DEM via AWS Open Data Terrarium tiles (Mapzen/Joerd lineage).
 * URL: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 * Decode: (R * 256 + G + B / 256) - 32768  → meters
 * No API key. Streaming with map chunks.
 *
 * v1.1: bilinear sampling + cross-tile edge reads to reduce heightfield seams.
 */

const TILE_URL =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const ZOOM = 12;
const SIZE = 256;

interface DemTile {
  key: string;
  data: Uint8ClampedArray;
  loading?: Promise<void>;
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
  return r * 256 + g + b / 256 - 32768;
}

export class ElevationSampler {
  private tiles = new Map<string, DemTile>();
  private originElev: number | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  /** Relative height (meters) above spawn elevation. */
  sampleRelative(lat: number, lon: number): number {
    const abs = this.sampleAbsolute(lat, lon);
    if (abs === null) return 0;
    if (this.originElev === null) this.originElev = abs;
    return abs - this.originElev;
  }

  /**
   * Bilinear sample in meters. Returns null if the covering tile(s) are not loaded.
   * Reads across DEM tile boundaries so seams don't crack.
   */
  sampleAbsolute(lat: number, lon: number): number | null {
    const { x, y } = lonLatToTileFrac(lon, lat, ZOOM);
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
      // Kick loads for any missing tiles near this sample
      void this.ensureTile(tx0, ty0);
      if (px + 1 >= SIZE) void this.ensureTile(tx0 + 1, ty0);
      if (py + 1 >= SIZE) void this.ensureTile(tx0, ty0 + 1);
      if (px + 1 >= SIZE && py + 1 >= SIZE) void this.ensureTile(tx0 + 1, ty0 + 1);
      // Fallback to nearest loaded corner if partial
      const any = h00 ?? h10 ?? h01 ?? h11;
      return any;
    }

    const h0 = h00 * (1 - dx) + h10 * dx;
    const h1 = h01 * (1 - dx) + h11 * dx;
    return h0 * (1 - dy) + h1 * dy;
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
    // +1 border so bilinear edge samples have neighbors ready
    const jobs: Promise<void>[] = [];
    for (let ty = minTy - 1; ty <= maxTy + 1; ty++) {
      for (let tx = minTx - 1; tx <= maxTx + 1; tx++) {
        jobs.push(this.ensureTile(tx, ty));
      }
    }
    await Promise.all(jobs);
  }

  async ensureOrigin(lat: number, lon: number): Promise<number> {
    const { x, y } = lonLatToTileFrac(lon, lat, ZOOM);
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    await Promise.all([
      this.ensureTile(tx, ty),
      this.ensureTile(tx + 1, ty),
      this.ensureTile(tx, ty + 1),
      this.ensureTile(tx + 1, ty + 1),
      this.ensureTile(tx - 1, ty),
      this.ensureTile(tx, ty - 1),
    ]);
    const abs = this.sampleAbsolute(lat, lon);
    this.originElev = abs ?? 0;
    return this.originElev;
  }

  getOriginElevation(): number {
    return this.originElev ?? 0;
  }

  private ensureTile(tx: number, ty: number): Promise<void> {
    const key = `${ZOOM}/${tx}/${ty}`;
    let tile = this.tiles.get(key);
    if (tile?.data && tile.data.length > 0) return Promise.resolve();
    if (tile?.loading) return tile.loading;

    tile = { key, data: new Uint8ClampedArray(0) };
    this.tiles.set(key, tile);

    const url = TILE_URL.replace('{z}', String(ZOOM))
      .replace('{x}', String(tx))
      .replace('{y}', String(ty));

    tile.loading = (async () => {
      try {
        const res = await fetch(url);
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
        bitmap.close();
      } catch (err) {
        console.warn('Terrarium tile failed', key, err);
        this.tiles.delete(key);
      } finally {
        if (tile) tile.loading = undefined;
      }
    })();

    return tile.loading;
  }
}
