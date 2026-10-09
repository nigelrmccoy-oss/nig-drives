import type { RoadCenterline } from './RoadBuilder';

/**
 * Uniform-grid spatial hash over road centreline segments (v1.3.2).
 * Used by terrain corridor carving, car surface sampling (4 wheels per frame)
 * and nearest-road lookups, which used to scan every segment of every road.
 * Incremental: tiles add/remove their centrelines on load/unload.
 */
const CELL = 24;

export interface SegRef {
  line: RoadCenterline;
  i: number; // segment from points[i] to points[i+1]
}

export interface NearestSeg {
  line: RoadCenterline;
  i: number;
  t: number;
  distSq: number;
  /** Interpolated centreline (road surface) height. */
  y: number;
  x: number;
  z: number;
}

function cellKey(cx: number, cz: number): number {
  // cx, cz within ±2^20 cells (±25,000 km) → unique
  return (cx + 1048576) * 2097152 + (cz + 1048576);
}

export class RoadIndex {
  private cells = new Map<number, SegRef[]>();
  private lineCells = new Map<RoadCenterline, number[]>();
  /** Bumped on every add/remove so caches (e.g. terrain) can tell it changed. */
  version = 0;

  get lineCount(): number {
    return this.lineCells.size;
  }

  add(lines: RoadCenterline[]): void {
    for (const line of lines) {
      if (this.lineCells.has(line)) continue;
      const keys = new Set<number>();
      const pts = line.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (!Number.isFinite(a.x + a.z + b.x + b.z)) continue;
        const pad = (line.width ?? 6) * 0.5;
        const minX = Math.floor((Math.min(a.x, b.x) - pad) / CELL);
        const maxX = Math.floor((Math.max(a.x, b.x) + pad) / CELL);
        const minZ = Math.floor((Math.min(a.z, b.z) - pad) / CELL);
        const maxZ = Math.floor((Math.max(a.z, b.z) + pad) / CELL);
        if ((maxX - minX + 1) * (maxZ - minZ + 1) > 400) continue; // pathological span
        for (let cx = minX; cx <= maxX; cx++) {
          for (let cz = minZ; cz <= maxZ; cz++) {
            const k = cellKey(cx, cz);
            let list = this.cells.get(k);
            if (!list) {
              list = [];
              this.cells.set(k, list);
            }
            list.push({ line, i });
            keys.add(k);
          }
        }
      }
      this.lineCells.set(line, [...keys]);
    }
    this.version++;
  }

  remove(lines: RoadCenterline[]): void {
    for (const line of lines) {
      const keys = this.lineCells.get(line);
      if (!keys) continue;
      for (const k of keys) {
        const list = this.cells.get(k);
        if (!list) continue;
        const kept = list.filter((r) => r.line !== line);
        if (kept.length) this.cells.set(k, kept);
        else this.cells.delete(k);
      }
      this.lineCells.delete(line);
    }
    this.version++;
  }

  clear(): void {
    this.cells.clear();
    this.lineCells.clear();
    this.version++;
  }

  /**
   * Visit every segment whose cell lies within `radius` of (x, z). The callback
   * may see a segment more than once (it spans several cells).
   */
  forEachNear(x: number, z: number, radius: number, fn: (ref: SegRef) => void): void {
    const minX = Math.floor((x - radius) / CELL);
    const maxX = Math.floor((x + radius) / CELL);
    const minZ = Math.floor((z - radius) / CELL);
    const maxZ = Math.floor((z + radius) / CELL);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (!list) continue;
        for (const r of list) fn(r);
      }
    }
  }

  /**
   * Nearest segment within `radius`. `filter` can skip lines (e.g. tunnels).
   * `preferY`: when set, segments whose height is far from it are penalised so
   * a car on a bridge/in a tunnel keeps following its own deck.
   */
  nearest(
    x: number,
    z: number,
    radius: number,
    filter?: (line: RoadCenterline) => boolean,
    preferY?: number,
  ): NearestSeg | null {
    let best: NearestSeg | null = null;
    let bestScore = Infinity;
    const r2 = radius * radius;
    this.forEachNear(x, z, radius, (ref) => {
      if (filter && !filter(ref.line)) return;
      const pts = ref.line.points;
      const a = pts[ref.i];
      const b = pts[ref.i + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len = abx * abx + abz * abz;
      let t = len < 1e-8 ? 0 : ((x - a.x) * abx + (z - a.z) * abz) / len;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a.x + abx * t;
      const qz = a.z + abz * t;
      const d2 = (x - qx) ** 2 + (z - qz) ** 2;
      if (d2 > r2) return;
      const y = a.y + (b.y - a.y) * t;
      let score = d2;
      if (preferY !== undefined && Number.isFinite(preferY)) {
        const dy = Math.abs(y - preferY);
        if (dy > 2.5) score += (dy - 2.5) * (dy - 2.5) * 40 + 400;
      }
      if (score < bestScore) {
        bestScore = score;
        best = { line: ref.line, i: ref.i, t, distSq: d2, y, x: qx, z: qz };
      }
    });
    return best;
  }
}
