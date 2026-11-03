/**
 * v1.5.0a: shoulder / kerb / sidewalk strips along a road polyline.
 * A strip runs from lateral offset d0 to d1 on one side with the height
 * rising from dy0 to dy1 (above the road surface). Junction gaps interrupt it
 * so cross streets are not blocked by kerbs; TileManager uses the same gaps
 * for the physics height, so drawn and driven surfaces agree.
 */
import * as THREE from 'three';

export interface RoadGap {
  x: number;
  z: number;
  r2: number;
}

export function inGap(gaps: RoadGap[] | undefined, x: number, z: number): boolean {
  if (!gaps) return false;
  for (const g of gaps) {
    const dx = x - g.x;
    const dz = z - g.z;
    if (dx * dx + dz * dz < g.r2) return true;
  }
  return false;
}

const MAX_STEP = 3;

export function buildStrip(
  points: THREE.Vector3[],
  side: 0 | 1,
  d0: number,
  d1: number,
  dy0: number,
  dy1: number,
  yBase: number,
  gaps: RoadGap[] | undefined,
): THREE.BufferGeometry | null {
  if (points.length < 2 || d1 - d0 < 0.04) return null;
  // densify so junction gaps are cut to ~3 m and curves follow the road
  const dense: THREE.Vector3[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / MAX_STEP));
    for (let k = 0; k < n; k++) dense.push(a.clone().lerp(b, k / n));
  }
  dense.push(points[points.length - 1].clone());
  const sign = side === 0 ? 1 : -1;
  const N = dense.length;
  const nx: number[] = [];
  const nz: number[] = [];
  const sc: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = dense[Math.max(0, i - 1)];
    const b = dense[i];
    const c = dense[Math.min(N - 1, i + 1)];
    let ix = b.x - a.x;
    let iz = b.z - a.z;
    let ox = c.x - b.x;
    let oz = c.z - b.z;
    let il = Math.hypot(ix, iz);
    let ol = Math.hypot(ox, oz);
    if (il < 1e-6) {
      ix = ox;
      iz = oz;
      il = ol;
    }
    if (ol < 1e-6) {
      ox = ix;
      oz = iz;
      ol = il;
    }
    if (il < 1e-6) {
      nx.push(0);
      nz.push(1);
      sc.push(1);
      continue;
    }
    ix /= il;
    iz /= il;
    ox /= ol;
    oz /= ol;
    let mx = -(iz + oz);
    let mz = ix + ox;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) {
      mx = -oz;
      mz = ox;
    } else {
      mx /= ml;
      mz /= ml;
    }
    const cos = Math.max(0.5, mx * -oz + mz * ox);
    nx.push(mx);
    nz.push(mz);
    sc.push(1 / cos);
  }

  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let dist = 0;
  let runStart = -1;
  const flush = (end: number): void => {
    // run vertices are [runStart, end)
    if (runStart >= 0 && end - runStart >= 2) {
      const base = pos.length / 3 - (end - runStart) * 2;
      for (let k = 0; k < end - runStart - 1; k++) {
        const a = base + k * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    } else if (runStart >= 0) {
      const drop = (end - runStart) * 2;
      pos.length -= drop * 3;
      uv.length -= drop * 2;
    }
    runStart = -1;
  };
  for (let i = 0; i < N; i++) {
    const p = dense[i];
    if (i > 0) dist += Math.hypot(p.x - dense[i - 1].x, p.z - dense[i - 1].z);
    if (inGap(gaps, p.x, p.z)) {
      flush(i);
      continue;
    }
    if (runStart < 0) runStart = i;
    const s = sc[i] * sign;
    const y = (Number.isFinite(p.y) ? p.y : 0) + yBase;
    const ix = p.x + nx[i] * d0 * s;
    const iz = p.z + nz[i] * d0 * s;
    const ox = p.x + nx[i] * d1 * s;
    const oz = p.z + nz[i] * d1 * s;
    // vertex pair order: a = +normal side, b = −normal side
    if (side === 0) {
      pos.push(ox, y + dy1, oz, ix, y + dy0, iz);
      uv.push(d1, dist, d0, dist);
    } else {
      pos.push(ix, y + dy0, iz, ox, y + dy1, oz);
      uv.push(d0, dist, d1, dist);
    }
  }
  flush(N);
  if (idx.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
