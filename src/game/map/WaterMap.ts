/**
 * v1.3.3 inland water + landuse raster (local metres).
 *
 * Every OSM area (lake / pond / reservoir / riverbank / park / wood / farmland)
 * is rasterised once into its own small Uint8 mask (even-odd scanline fill, so
 * multipolygon holes such as islands work). Terrain rings sample it per vertex:
 * water pulls the ground down to a flat lake level (or just under the DEM for
 * rivers) and tells the splat shader to draw water; landuse tints the ground.
 */

export type AreaClass = 'lake' | 'river' | 'park' | 'forest' | 'farm';

export interface AreaInput {
  key: string;
  cls: AreaClass;
  /** Closed rings in local metres (outer + inner, even-odd). */
  rings: Array<Array<{ x: number; z: number }>>;
}

export interface AreaSample {
  /** 0..1 water coverage (0.5 = shoreline). */
  water: number;
  /** Relative lake level, NaN for rivers / no water. */
  level: number;
  park: number;
  forest: number;
  farm: number;
}

interface Feature {
  key: string;
  cls: AreaClass;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  cell: number;
  w: number;
  h: number;
  mask: Uint8Array;
  rings: Array<Array<{ x: number; z: number }>>;
  level: number;
  levelProvisional: boolean;
  buckets: number[];
}

const BUCKET = 256;
const MAX_CELLS = 1400; // per side
const MAX_BYTES = 40 * 1024 * 1024;

function bucketKey(ix: number, iz: number): number {
  return (ix + 32768) * 65536 + (iz + 32768);
}

export class WaterMap {
  private features = new Map<string, Feature>();
  private buckets = new Map<number, Feature[]>();
  private bytes = 0;
  /** Bumped whenever water/landuse changes (rings re-sample). */
  version = 0;
  /** Bumped only when water features change (cheaper landuse-only changes don't force far rings). */
  waterVersion = 0;

  get size(): number {
    return this.features.size;
  }

  has(key: string): boolean {
    return this.features.has(key);
  }

  add(a: AreaInput, levelFor: (rings: AreaInput['rings']) => { level: number; provisional: boolean }): boolean {
    if (this.features.has(a.key)) return false;
    const rings = a.rings.filter((r) => r.length >= 3);
    if (!rings.length) return false;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const r of rings)
      for (const p of r) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
    const span = Math.max(maxX - minX, maxZ - minZ);
    if (span < 3 || span > 40_000) return false;
    const water = a.cls === 'lake' || a.cls === 'river';
    const cell = Math.max(water ? 3 : 6, span / MAX_CELLS);
    // one empty cell of margin all round so bilinear edges fade to 0
    minX -= cell;
    minZ -= cell;
    const w = Math.ceil((maxX - minX) / cell) + 2;
    const h = Math.ceil((maxZ - minZ) / cell) + 2;
    const mask = new Uint8Array(w * h);
    rasterize(rings, minX, minZ, cell, w, h, mask);
    const lv = a.cls === 'lake' ? levelFor(rings) : { level: Number.NaN, provisional: false };
    const f: Feature = {
      key: a.key,
      cls: a.cls,
      minX,
      minZ,
      maxX: minX + w * cell,
      maxZ: minZ + h * cell,
      cell,
      w,
      h,
      mask,
      rings,
      level: lv.level,
      levelProvisional: lv.provisional,
      buckets: [],
    };
    const bx0 = Math.floor(f.minX / BUCKET), bx1 = Math.floor(f.maxX / BUCKET);
    const bz0 = Math.floor(f.minZ / BUCKET), bz1 = Math.floor(f.maxZ / BUCKET);
    for (let bz = bz0; bz <= bz1; bz++)
      for (let bx = bx0; bx <= bx1; bx++) {
        const k = bucketKey(bx, bz);
        let list = this.buckets.get(k);
        if (!list) this.buckets.set(k, (list = []));
        list.push(f);
        f.buckets.push(k);
      }
    this.features.set(a.key, f);
    this.bytes += mask.byteLength;
    this.version++;
    if (water) this.waterVersion++;
    return true;
  }

  /** Re-estimate lake levels that were computed before their DEM arrived. */
  refreshLevels(levelFor: (rings: AreaInput['rings']) => { level: number; provisional: boolean }): void {
    let changed = false;
    for (const f of this.features.values()) {
      if (f.cls !== 'lake' || !f.levelProvisional) continue;
      const lv = levelFor(f.rings);
      if (Math.abs(lv.level - f.level) > 0.05 || lv.provisional !== f.levelProvisional) changed = true;
      f.level = lv.level;
      f.levelProvisional = lv.provisional;
    }
    if (changed) {
      this.version++;
      this.waterVersion++;
    }
  }

  get hasProvisional(): boolean {
    for (const f of this.features.values()) if (f.levelProvisional) return true;
    return false;
  }

  /** Drop features far from the player once the memory budget is exceeded. */
  evict(px: number, pz: number, keepRadius = 6000): void {
    if (this.bytes <= MAX_BYTES) return;
    const ranked = [...this.features.values()]
      .map((f) => ({
        f,
        d: Math.max(0, Math.max(f.minX - px, px - f.maxX, f.minZ - pz, pz - f.maxZ)),
      }))
      .sort((a, b) => b.d - a.d);
    for (const { f, d } of ranked) {
      if (this.bytes <= MAX_BYTES * 0.75 || d < keepRadius) break;
      this.remove(f);
    }
  }

  private remove(f: Feature): void {
    for (const k of f.buckets) {
      const list = this.buckets.get(k);
      if (!list) continue;
      const i = list.indexOf(f);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.buckets.delete(k);
    }
    this.features.delete(f.key);
    this.bytes -= f.mask.byteLength;
    this.version++;
    if (f.cls === 'lake' || f.cls === 'river') this.waterVersion++;
  }

  clear(): void {
    this.features.clear();
    this.buckets.clear();
    this.bytes = 0;
    this.version++;
    this.waterVersion++;
  }

  /** Writes into `out` (reused) — called for every terrain vertex. */
  sample(x: number, z: number, out: AreaSample): AreaSample {
    out.water = 0;
    out.level = Number.NaN;
    out.park = 0;
    out.forest = 0;
    out.farm = 0;
    const list = this.buckets.get(bucketKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)));
    if (!list) return out;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (x < f.minX || x >= f.maxX || z < f.minZ || z >= f.maxZ) continue;
      const fx = (x - f.minX) / f.cell - 0.5;
      const fz = (z - f.minZ) / f.cell - 0.5;
      const ix = Math.max(0, Math.min(f.w - 2, Math.floor(fx)));
      const iz = Math.max(0, Math.min(f.h - 2, Math.floor(fz)));
      const tx = Math.max(0, Math.min(1, fx - ix));
      const tz = Math.max(0, Math.min(1, fz - iz));
      const m = f.mask;
      const k = iz * f.w + ix;
      const v =
        ((m[k] * (1 - tx) + m[k + 1] * tx) * (1 - tz) + (m[k + f.w] * (1 - tx) + m[k + f.w + 1] * tx) * tz) /
        255;
      if (v <= 0) continue;
      switch (f.cls) {
        case 'lake':
        case 'river':
          if (v > out.water) {
            out.water = v;
            out.level = f.cls === 'lake' ? f.level : Number.NaN;
          }
          break;
        case 'park':
          out.park = Math.max(out.park, v);
          break;
        case 'forest':
          out.forest = Math.max(out.forest, v);
          break;
        case 'farm':
          out.farm = Math.max(out.farm, v);
          break;
      }
    }
    return out;
  }
}

/** Even-odd scanline fill at cell centres. */
function rasterize(
  rings: Array<Array<{ x: number; z: number }>>,
  minX: number,
  minZ: number,
  cell: number,
  w: number,
  h: number,
  mask: Uint8Array,
): void {
  const xs: number[] = [];
  for (let j = 0; j < h; j++) {
    const zc = minZ + (j + 0.5) * cell;
    xs.length = 0;
    for (const r of rings) {
      for (let i = 0, n = r.length; i < n; i++) {
        const a = r[i];
        const b = r[(i + 1) % n];
        if ((a.z <= zc && b.z > zc) || (b.z <= zc && a.z > zc)) {
          xs.push(a.x + ((zc - a.z) / (b.z - a.z)) * (b.x - a.x));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const row = j * w;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let i0 = Math.ceil((xs[k] - minX) / cell - 0.5);
      let i1 = Math.floor((xs[k + 1] - minX) / cell - 0.5);
      if (i0 < 0) i0 = 0;
      if (i1 > w - 1) i1 = w - 1;
      for (let i = i0; i <= i1; i++) mask[row + i] = 255;
    }
  }
}

/**
 * Join multipolygon member ways into closed rings (end-to-end, either
 * direction). Open chains whose ends are within `closeTol` metres are closed;
 * anything else is dropped.
 */
export function assembleRings(
  parts: Array<Array<{ x: number; z: number }>>,
  closeTol = 200,
): Array<Array<{ x: number; z: number }>> {
  const rings: Array<Array<{ x: number; z: number }>> = [];
  const open: Array<Array<{ x: number; z: number }>> = [];
  const same = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    Math.abs(a.x - b.x) < 0.05 && Math.abs(a.z - b.z) < 0.05;
  for (const p of parts) {
    if (p.length < 2) continue;
    if (p.length >= 4 && same(p[0], p[p.length - 1])) rings.push(p.slice(0, -1));
    else open.push(p.slice());
  }
  while (open.length) {
    let chain = open.pop()!;
    let grew = true;
    while (grew && !same(chain[0], chain[chain.length - 1])) {
      grew = false;
      const end = chain[chain.length - 1];
      for (let i = 0; i < open.length; i++) {
        const o = open[i];
        if (same(o[0], end)) chain = chain.concat(o.slice(1));
        else if (same(o[o.length - 1], end)) chain = chain.concat(o.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    const a = chain[0];
    const b = chain[chain.length - 1];
    if (same(a, b)) chain.pop();
    else if (Math.hypot(a.x - b.x, a.z - b.z) > closeTol) continue;
    if (chain.length >= 3) rings.push(chain);
  }
  return rings;
}
