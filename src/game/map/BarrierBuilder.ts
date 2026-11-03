/**
 * v1.5.0a: road-side barriers (guard rails, jersey barriers, cable barriers,
 * walls) from OSM `barrier=*` ways. Drawn as small extruded boxes and exposed
 * as thin solid footprints so the existing push-out collision stops the car.
 * Property fences, hedges and gates are deliberately not drawn or solid.
 */
import * as THREE from 'three';
import type { OsmWay } from './OverpassClient';
import type { GeoOrigin } from './geo';
import type { Footprint } from './BuildingBuilder';
import { parseLengthM } from './RoadSpec';

export const BARRIER_KINDS = 'guard_rail|jersey_barrier|cable_barrier|wall|retaining_wall|concrete';

interface Look {
  h: number;
  t: number;
  color: number;
}
const LOOK: Record<string, Look> = {
  guard_rail: { h: 0.78, t: 0.32, color: 0xa7adb3 },
  cable_barrier: { h: 0.95, t: 0.2, color: 0x8c9096 },
  jersey_barrier: { h: 0.82, t: 0.55, color: 0xb9b6ae },
  concrete: { h: 0.82, t: 0.55, color: 0xb9b6ae },
  wall: { h: 1.6, t: 0.3, color: 0x9a948c },
  retaining_wall: { h: 1.4, t: 0.35, color: 0x8e8981 },
};

const MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.25, side: THREE.DoubleSide });

/** Per-tile cap (perf / pathological data guard). */
const MAX_SEGMENTS = 1500;

export function buildBarriers(
  ways: OsmWay[],
  origin: GeoOrigin,
  /** Base height for a barrier post at local (x, z). */
  baseY: (x: number, z: number) => number,
): THREE.Group | null {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const fps: Footprint[] = [];
  const c = new THREE.Color();
  let segs = 0;
  for (const w of ways) {
    const kind = w.tags.barrier;
    const look = kind ? LOOK[kind] : undefined;
    if (!look) continue;
    let h = look.h;
    const ht = parseLengthM(w.tags.height);
    if (Number.isFinite(ht) && ht >= 0.4 && ht <= 8) h = ht;
    const t = look.t;
    c.setHex(look.color);
    const p: Array<{ x: number; z: number; y: number }> = [];
    for (const n of w.geometry) {
      const l = origin.toLocal(n.lat, n.lon);
      if (!Number.isFinite(l.x) || !Number.isFinite(l.z)) continue;
      p.push({ x: l.x, z: l.z, y: baseY(l.x, l.z) });
    }
    for (let i = 0; i < p.length - 1 && segs < MAX_SEGMENTS; i++) {
      const a = p[i];
      const b = p[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.3 || len > 400) continue;
      segs++;
      const nx = (-dz / len) * (t / 2);
      const nz = (dx / len) * (t / 2);
      const base = pos.length / 3;
      // 4 bottom + 4 top corners: a−n, a+n, b+n, b−n
      const corners = [
        [a.x - nx, a.y, a.z - nz],
        [a.x + nx, a.y, a.z + nz],
        [b.x + nx, b.y, b.z + nz],
        [b.x - nx, b.y, b.z - nz],
      ];
      for (const q of corners) {
        pos.push(q[0], q[1] - 0.1, q[2]);
        col.push(c.r * 0.8, c.g * 0.8, c.b * 0.8);
      }
      for (const q of corners) {
        pos.push(q[0], q[1] + h, q[2]);
        col.push(c.r, c.g, c.b);
      }
      // top, +n side, −n side
      idx.push(base + 4, base + 5, base + 6, base + 4, base + 6, base + 7);
      idx.push(base + 1, base + 5, base + 2, base + 5, base + 6, base + 2);
      idx.push(base + 0, base + 3, base + 4, base + 4, base + 3, base + 7);
      const pts = [
        { x: corners[0][0], z: corners[0][2] },
        { x: corners[1][0], z: corners[1][2] },
        { x: corners[2][0], z: corners[2][2] },
        { x: corners[3][0], z: corners[3][2] },
      ];
      const xs = pts.map((q) => q.x);
      const zs = pts.map((q) => q.z);
      fps.push({
        pts,
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minZ: Math.min(...zs),
        maxZ: Math.max(...zs),
        always: true,
        y: (a.y + b.y) / 2,
      });
    }
  }
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, MAT);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.name = 'barriers';
  const g = new THREE.Group();
  g.name = 'barriers';
  g.add(mesh);
  g.userData.footprints = fps;
  return g;
}
