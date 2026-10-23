/**
 * v1.3.4 Great-Lake shoreline refinement near the camera.
 *
 * The Terrarium DEM stores Lake Ontario as a flat surface, which gives a
 * ~7 m/px, 10–20 m-off shoreline without piers or canals. Around the player
 * this rasterises a 2.5 m mask:
 *  1. every cell is classed wet / dry from the DEM (5 m stride, with the same
 *     "near-level and mostly surrounded by lake" noise rule as clampSea);
 *  2. when OSM shoreline ways (lake multipolygon members, piers, breakwaters)
 *     are available they are drawn as barriers, the grid is flood-filled into
 *     regions, and each region takes the DEM majority vote — so the boundary
 *     follows OSM exactly while the DEM only decides which side is water;
 *  3. piers / breakwaters are stamped back in as land.
 * Without OSM (Overpass down) the mask is the DEM classification alone.
 * v1.3.5: with bundled water polygons the mask is their exact fill, and a
 * DEM-only mask is flagged osm=false so TileManager ignores it (1.3.3 shore).
 */

export interface ShoreLines {
  /** Water-boundary polylines (local metres). */
  barriers: Array<Array<{ x: number; z: number }>>;
  /** Closed pier / breakwater areas (land). */
  landAreas: Array<Array<{ x: number; z: number }>>;
  /** Pier / breakwater / groyne centrelines (land, stroked). */
  landLines: Array<Array<{ x: number; z: number }>>;
  /**
   * v1.3.5: closed water polygons (bundled OSM lake outline incl. islands).
   * When present the mask is their exact even-odd fill — no DEM vote.
   */
  waterPolys?: Array<Array<{ x: number; z: number }>>;
}

/** 0 = dry, 1 = wet, 2 = near lake level (wet if mostly surrounded by lake). */
export type ShoreClass = 0 | 1 | 2 | 3; // 3 = no DEM yet

export const SHORE_HALF_M = 800;
export const SHORE_CELL_M = 2.5;
const CLASS_STRIDE = 2; // class grid = 5 m
const NOISE_R_CELLS = 9; // ≈45 m (class cells)
const PIER_HALF_M = 3;

function yieldSlice(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export class ShoreMask {
  centerX = 0;
  centerZ = 0;
  readonly n = Math.round((SHORE_HALF_M * 2) / SHORE_CELL_M);
  private mask: Uint8Array | null = null;
  /** Bumped every time a new mask is published. */
  version = 0;
  /** Whether the published mask used OSM barriers. */
  osm = false;
  building = false;

  get ready(): boolean {
    return !!this.mask;
  }

  clear(): void {
    this.mask = null;
    this.version++;
  }

  /** 0..1 water (bilinear), NaN outside the window / before the first build. */
  sample(x: number, z: number): number {
    const m = this.mask;
    if (!m) return Number.NaN;
    const n = this.n;
    const fx = (x - (this.centerX - SHORE_HALF_M)) / SHORE_CELL_M - 0.5;
    const fz = (z - (this.centerZ - SHORE_HALF_M)) / SHORE_CELL_M - 0.5;
    if (fx < 0 || fz < 0 || fx >= n - 1 || fz >= n - 1) return Number.NaN;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const k = iz * n + ix;
    return (
      ((m[k] * (1 - tx) + m[k + 1] * tx) * (1 - tz) + (m[k + n] * (1 - tx) + m[k + n + 1] * tx) * tz) / 255
    );
  }

  /**
   * Build a new mask centred on (cx, cz). `classify` reads the DEM; returns
   * false (keeps the old mask) if too much of the window has no DEM yet.
   */
  async build(
    cx: number,
    cz: number,
    classify: (x: number, z: number) => ShoreClass,
    lines: ShoreLines | null,
    cancelled: () => boolean,
  ): Promise<boolean> {
    const n = this.n;
    const cn = n / CLASS_STRIDE;
    const x0 = cx - SHORE_HALF_M;
    const z0 = cz - SHORE_HALF_M;
    const cc = SHORE_CELL_M * CLASS_STRIDE;
    if (lines?.waterPolys?.length) {
      const out = await fillPolys(n, x0, z0, lines.waterPolys, cancelled);
      if (!out) return false;
      for (const ring of lines.landAreas) fillRing(out, n, x0, z0, ring);
      for (const line of lines.landLines) strokeLine(out, n, x0, z0, line, PIER_HALF_M);
      if (cancelled()) return false;
      this.mask = out;
      this.centerX = cx;
      this.centerZ = cz;
      this.osm = true;
      this.version++;
      return true;
    }
    // 1. DEM classes at 5 m
    const cls = new Uint8Array(cn * cn);
    let missing = 0;
    let t0 = performance.now();
    for (let j = 0; j < cn; j++) {
      if (performance.now() - t0 > 6) {
        await yieldSlice();
        if (cancelled()) return false;
        t0 = performance.now();
      }
      const z = z0 + (j + 0.5) * cc;
      for (let i = 0; i < cn; i++) {
        const c = classify(x0 + (i + 0.5) * cc, z);
        cls[j * cn + i] = c;
        if (c === 3) missing++;
      }
    }
    if (missing > cn * cn * 0.25) return false;
    // Noise rule: near-level cells become wet when ≥ 60 % of a ~90 m box is wet
    const integ = new Uint32Array((cn + 1) * (cn + 1));
    for (let j = 0; j < cn; j++) {
      let row = 0;
      for (let i = 0; i < cn; i++) {
        row += cls[j * cn + i] === 1 ? 1 : 0;
        integ[(j + 1) * (cn + 1) + i + 1] = integ[j * (cn + 1) + i + 1] + row;
      }
    }
    const wet = new Uint8Array(cn * cn);
    const R = NOISE_R_CELLS;
    for (let j = 0; j < cn; j++)
      for (let i = 0; i < cn; i++) {
        const c = cls[j * cn + i];
        if (c === 1) wet[j * cn + i] = 1;
        else if (c === 2) {
          const a0 = Math.max(0, i - R), a1 = Math.min(cn, i + R + 1);
          const b0 = Math.max(0, j - R), b1 = Math.min(cn, j + R + 1);
          const sum = integ[b1 * (cn + 1) + a1] - integ[b0 * (cn + 1) + a1] - integ[b1 * (cn + 1) + a0] + integ[b0 * (cn + 1) + a0];
          if (sum >= (a1 - a0) * (b1 - b0) * 0.6) wet[j * cn + i] = 1;
        }
      }
    await yieldSlice();
    if (cancelled()) return false;

    const out = new Uint8Array(n * n);
    const demWet = (i: number, j: number) => wet[(j >> 1) * cn + (i >> 1)];
    const hasLines = !!lines && lines.barriers.length > 0;
    if (!hasLines) {
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out[j * n + i] = demWet(i, j) ? 255 : 0;
    } else {
      // 2. barriers → regions → DEM majority vote
      const BAR = 0xffffffff;
      const label = new Uint32Array(n * n);
      const mark = (i: number, j: number) => {
        if (i >= 0 && j >= 0 && i < n && j < n) label[j * n + i] = BAR;
      };
      for (const line of lines!.barriers) {
        for (let k = 1; k < line.length; k++) {
          const a = line[k - 1];
          const b = line[k];
          const ax = (a.x - x0) / SHORE_CELL_M, az = (a.z - z0) / SHORE_CELL_M;
          const bx = (b.x - x0) / SHORE_CELL_M, bz = (b.z - z0) / SHORE_CELL_M;
          if ((ax < -1 && bx < -1) || (az < -1 && bz < -1) || (ax > n && bx > n) || (az > n && bz > n)) continue;
          const steps = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(bz - az)) * 2) + 1;
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const i = Math.floor(ax + (bx - ax) * t);
            const j = Math.floor(az + (bz - az) * t);
            // 2×2 stamp: 4-connected flood fill can't leak through diagonals
            mark(i, j);
            mark(i + 1, j);
            mark(i, j + 1);
          }
        }
      }
      await yieldSlice();
      if (cancelled()) return false;
      const wetCount: number[] = [0];
      const total: number[] = [0];
      const stack = new Int32Array(n * n);
      let next = 1;
      t0 = performance.now();
      for (let start = 0; start < n * n; start++) {
        if (label[start] !== 0) continue;
        const id = next++;
        let w = 0;
        let tot = 0;
        let sp = 0;
        stack[sp++] = start;
        label[start] = id;
        while (sp > 0) {
          const k = stack[--sp];
          const i = k % n;
          const j = (k - i) / n;
          // vote on the 5 m class grid only (one sample per class cell)
          if ((i & 1) === 0 && (j & 1) === 0) {
            tot++;
            w += demWet(i, j);
          }
          if (i > 0 && label[k - 1] === 0) { label[k - 1] = id; stack[sp++] = k - 1; }
          if (i < n - 1 && label[k + 1] === 0) { label[k + 1] = id; stack[sp++] = k + 1; }
          if (j > 0 && label[k - n] === 0) { label[k - n] = id; stack[sp++] = k - n; }
          if (j < n - 1 && label[k + n] === 0) { label[k + n] = id; stack[sp++] = k + n; }
        }
        wetCount.push(w);
        total.push(tot);
        if (performance.now() - t0 > 8) {
          await yieldSlice();
          if (cancelled()) return false;
          t0 = performance.now();
        }
      }
      // Region verdict: majority, except big ambiguous regions (a gap in the
      // OSM outline merged lake and land) fall back to the per-cell DEM.
      const verdict = new Uint8Array(next); // 0 dry, 1 wet, 2 per-cell
      const bigRegion = (n * n) / 4 / 6;
      for (let id = 1; id < next; id++) {
        const tot = total[id];
        const f = tot > 0 ? wetCount[id] / tot : -1;
        if (f < 0) verdict[id] = 2;
        else if (tot > bigRegion && f > 0.15 && f < 0.85) verdict[id] = 2;
        else verdict[id] = f >= 0.5 ? 1 : 0;
      }
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const k = j * n + i;
          const l = label[k];
          if (l === BAR) out[k] = 128;
          else {
            const v = verdict[l];
            out[k] = v === 2 ? (demWet(i, j) ? 255 : 0) : v ? 255 : 0;
          }
        }
      // Barrier cells between two dry (or two wet) regions take that side
      for (let j = 1; j < n - 1; j++)
        for (let i = 1; i < n - 1; i++) {
          const k = j * n + i;
          if (out[k] !== 128) continue;
          let wv = 0, dv = 0;
          for (const o of [k - 1, k + 1, k - n, k + n]) {
            if (out[o] === 255) wv++;
            else if (out[o] === 0) dv++;
          }
          if (wv && !dv) out[k] = 255;
          else if (dv && !wv) out[k] = 0;
        }
      // 3. piers / breakwaters are land
      for (const ring of lines!.landAreas) fillRing(out, n, x0, z0, ring);
      for (const line of lines!.landLines) strokeLine(out, n, x0, z0, line, PIER_HALF_M);
    }
    if (cancelled()) return false;
    this.mask = out;
    this.centerX = cx;
    this.centerZ = cz;
    this.osm = hasLines;
    this.version++;
    return true;
  }
}

/** Even-odd scanline fill of closed rings (cell centres), sliced across frames. */
async function fillPolys(
  n: number,
  x0: number,
  z0: number,
  rings: Array<Array<{ x: number; z: number }>>,
  cancelled: () => boolean,
): Promise<Uint8Array | null> {
  const zMin = z0;
  const zMax = z0 + n * SHORE_CELL_M;
  // edges that cross the window's z range (any x: they still flip parity)
  const ex0: number[] = [], ez0: number[] = [], ex1: number[] = [], ez1: number[] = [];
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      if ((a.z < zMin && b.z < zMin) || (a.z > zMax && b.z > zMax) || a.z === b.z) continue;
      ex0.push(a.x); ez0.push(a.z); ex1.push(b.x); ez1.push(b.z);
    }
  }
  const out = new Uint8Array(n * n);
  const xs: number[] = [];
  let t0 = performance.now();
  for (let j = 0; j < n; j++) {
    if (performance.now() - t0 > 6) {
      await yieldSlice();
      if (cancelled()) return null;
      t0 = performance.now();
    }
    const zc = z0 + (j + 0.5) * SHORE_CELL_M;
    xs.length = 0;
    for (let k = 0; k < ex0.length; k++) {
      const az = ez0[k], bz = ez1[k];
      if ((az <= zc && bz > zc) || (bz <= zc && az > zc)) xs.push(ex0[k] + ((zc - az) / (bz - az)) * (ex1[k] - ex0[k]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / SHORE_CELL_M - 0.5));
      const i1 = Math.min(n - 1, Math.floor((xs[k + 1] - x0) / SHORE_CELL_M - 0.5));
      for (let i = i0; i <= i1; i++) out[j * n + i] = 255;
    }
  }
  return out;
}

function fillRing(out: Uint8Array, n: number, x0: number, z0: number, ring: Array<{ x: number; z: number }>): void {
  if (ring.length < 3) return;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) {
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const j0 = Math.max(0, Math.floor((minZ - z0) / SHORE_CELL_M));
  const j1 = Math.min(n - 1, Math.ceil((maxZ - z0) / SHORE_CELL_M));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const zc = z0 + (j + 0.5) * SHORE_CELL_M;
    xs.length = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if ((a.z <= zc && b.z > zc) || (b.z <= zc && a.z > zc)) xs.push(a.x + ((zc - a.z) / (b.z - a.z)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / SHORE_CELL_M - 0.5));
      const i1 = Math.min(n - 1, Math.floor((xs[k + 1] - x0) / SHORE_CELL_M - 0.5));
      for (let i = i0; i <= i1; i++) out[j * n + i] = 0;
    }
  }
}

function strokeLine(
  out: Uint8Array,
  n: number,
  x0: number,
  z0: number,
  line: Array<{ x: number; z: number }>,
  half: number,
): void {
  const r = Math.ceil(half / SHORE_CELL_M);
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1];
    const b = line[k];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.ceil(len / (SHORE_CELL_M * 0.5)) + 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const ci = Math.floor((a.x + (b.x - a.x) * t - x0) / SHORE_CELL_M);
      const cj = Math.floor((a.z + (b.z - a.z) * t - z0) / SHORE_CELL_M);
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          if ((di * di + dj * dj) * SHORE_CELL_M * SHORE_CELL_M <= half * half + 1) out[j * n + i] = 0;
        }
    }
  }
}
