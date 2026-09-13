/**
 * Real DEM via AWS Open Data Terrarium tiles (Mapzen/Joerd lineage).
 * URL: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 * Decode: (R * 256 + G + B / 256) - 32768  → meters
 * No API key. Streaming with map chunks.
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

function lonLatToTilePixel(
  lon: number,
  lat: number,
  z: number,
): { tx: number; ty: number; px: number; py: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const x = ((lon + 180) / 360) * n;
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const px = Math.min(SIZE - 1, Math.max(0, Math.floor((x - tx) * SIZE)));
  const py = Math.min(SIZE - 1, Math.max(0, Math.floor((y - ty) * SIZE)));
  return { tx, ty, px, py };
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

  sampleAbsolute(lat: number, lon: number): number | null {
    const { tx, ty, px, py } = lonLatToTilePixel(lon, lat, ZOOM);
    const key = `${ZOOM}/${tx}/${ty}`;
    const tile = this.tiles.get(key);
    if (!tile?.data) {
      void this.ensureTile(tx, ty);
      return null;
    }
    const i = (py * SIZE + px) * 4;
    return decodeTerrarium(tile.data[i], tile.data[i + 1], tile.data[i + 2]);
  }

  async preloadArea(south: number, west: number, north: number, east: number): Promise<void> {
    const corners = [
      lonLatToTilePixel(west, south, ZOOM),
      lonLatToTilePixel(east, south, ZOOM),
      lonLatToTilePixel(west, north, ZOOM),
      lonLatToTilePixel(east, north, ZOOM),
    ];
    const minTx = Math.min(...corners.map((c) => c.tx));
    const maxTx = Math.max(...corners.map((c) => c.tx));
    const minTy = Math.min(...corners.map((c) => c.ty));
    const maxTy = Math.max(...corners.map((c) => c.ty));
    const jobs: Promise<void>[] = [];
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        jobs.push(this.ensureTile(tx, ty));
      }
    }
    await Promise.all(jobs);
  }

  async ensureOrigin(lat: number, lon: number): Promise<number> {
    const { tx, ty } = lonLatToTilePixel(lon, lat, ZOOM);
    await this.ensureTile(tx, ty);
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
    if (tile?.data) return Promise.resolve();
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
