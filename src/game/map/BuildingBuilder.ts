import * as THREE from 'three';

const SLICE_MS = 5;
function nextSlice(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
import type { OsmWay } from './OverpassClient';
import type { GeoOrigin } from './geo';
import type { RoadCenterline } from './RoadBuilder';
import { createBuildingMaterial, LAYER_INDEX, type BuildingMaterialHandle, type FacadeLayer } from '../visuals/BuildingMaterial';
import type { TextureLibrary } from '../visuals/TextureLibrary';


/** Soft min footprint area (m²) — allow denser small lots without noise. */
const MIN_FOOTPRINT_AREA = 5.5;
const MAX_FOOTPRINT_AREA = 55_000;
/**
 * v1.3.2 foundations: walls start this far below the LOWEST ground point under
 * the footprint, and the roof sits `height` above the HIGHEST, so buildings on
 * slopes never float (downhill) or lose storeys (uphill).
 */
const PLINTH_M = 1.5;

/** Stable 0–1 hash from OSM id (avoids Math.random flicker on tile reload). */
function hash01(id: number): number {
  const x = Math.sin(id * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function buildingHeight(tags: Record<string, string>, id: number): number {
  // Prefer explicit OSM height / levels when present
  const h = tags.height ? parseFloat(tags.height.replace(/m$/i, '').trim()) : NaN;
  if (!Number.isNaN(h) && h > 2 && h < 250) return h;
  const levels = tags['building:levels'] ? parseFloat(tags['building:levels']) : NaN;
  if (!Number.isNaN(levels) && levels > 0) {
    const levelH = tags['building:level_height']
      ? parseFloat(tags['building:level_height'])
      : 3.15;
    const lh = Number.isFinite(levelH) && levelH > 2 && levelH < 6 ? levelH : 3.15;
    return Math.min(levels * lh, 180);
  }
  const r = hash01(id);
  const t = tags.building;
  if (t === 'house' || t === 'detached' || t === 'semidetached_house') return 6 + r * 4;
  if (t === 'apartments' || t === 'residential') return 12 + r * 18;
  if (t === 'commercial' || t === 'retail' || t === 'office') return 10 + r * 25;
  if (t === 'industrial' || t === 'warehouse') return 8 + r * 10;
  if (t === 'skyscraper') return 60 + r * 40;
  return 8 + r * 14;
}

/** Signed area in XZ (positive = CCW when viewed from +Y). */
function signedAreaXZ(pts: Array<{ x: number; z: number }>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a * 0.5;
}

/** Drop duplicate closing vertex and near-duplicates that create zero-area edges. */
function cleanFootprint(raw: Array<{ x: number; z: number }>): Array<{ x: number; z: number }> {
  if (raw.length < 3) return [];
  const pts = raw.slice();
  // OSM closed ways often repeat first point at end
  if (pts.length >= 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 1e-4) pts.pop();
  }
  const cleaned: Array<{ x: number; z: number }> = [];
  for (const p of pts) {
    if (
      cleaned.length === 0 ||
      (cleaned[cleaned.length - 1].x - p.x) ** 2 + (cleaned[cleaned.length - 1].z - p.z) ** 2 >
        0.05
    ) {
      cleaned.push(p);
    }
  }
  if (cleaned.length >= 3) {
    const a = cleaned[0];
    const b = cleaned[cleaned.length - 1];
    if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 < 0.05) cleaned.pop();
  }
  return cleaned.length >= 3 ? cleaned : [];
}

type Pt = { x: number; z: number };

interface BuildingStyle {
  layer: FacadeLayer;
  tint: THREE.Color;
  roofTint: THREE.Color;
  floorH: number;
  bay: number;
  windows: boolean;
  pitched: boolean;
}

const HOUSE = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'cabin', 'farm', 'static_caravan']);
const RESIDENTIAL = new Set(['residential', 'apartments', 'dormitory', 'flats']);
const COMMERCIAL = new Set(['commercial', 'office', 'retail', 'hotel', 'supermarket', 'mall', 'skyscraper']);
const INDUSTRIAL = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'shed', 'garage', 'garages', 'hangar', 'storage_tank', 'barn', 'service', 'parking']);
const CIVIC = new Set(['school', 'university', 'college', 'hospital', 'church', 'cathedral', 'civic', 'public', 'government', 'train_station', 'transportation', 'kindergarten', 'fire_station']);

const PLASTER_TINTS = [0xf2ede4, 0xe8dcc8, 0xd9d4cc, 0xefe3c2, 0xe3d6d0, 0xcfd6d8];
const SIDING_TINTS = [0xf4f2ee, 0xe6dccb, 0xc9d3d8, 0xc8cfbd, 0xd9c9ae, 0xb8c2c8, 0xe9e6dc];
const FLAT_ROOF_TINTS = [0x9a9690, 0x8a8a88, 0xb0aca4, 0x77787a];
const PITCHED_ROOF_TINTS = [0x4a4c50, 0x5a5048, 0x3c3e42, 0x6a5a4c, 0x6e4a3c, 0x55585c];

const tmpColor = new THREE.Color();
function parseColour(v: string | undefined, fallback: number): THREE.Color {
  const c = new THREE.Color(fallback);
  if (!v) return c;
  try {
    tmpColor.set(0xff00ff);
    tmpColor.setStyle(v.trim().toLowerCase().replace(/_/g, ''));
    if (tmpColor.getHex() !== 0xff00ff) c.copy(tmpColor);
  } catch {
    /* unknown colour name */
  }
  return c;
}

function pick<T>(arr: readonly T[], r: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
}

/** Per-building look from OSM tags (building, building:material/colour, roof:colour, levels). */
function styleFor(tags: Record<string, string>, id: number, height: number, footprintArea: number): BuildingStyle {
  const r1 = hash01(id);
  const r2 = hash01(id * 7 + 3);
  const r3 = hash01(id * 13 + 5);
  const type = tags.building ?? 'yes';
  const material = (tags['building:material'] ?? tags['building:facade:material'] ?? '').toLowerCase();
  const levels = parseFloat(tags['building:levels'] ?? '');
  let layer: FacadeLayer;
  let floorH = 3.2;
  let bay = 3.2;
  let windows = true;
  const isHouse = HOUSE.has(type);
  if (material.includes('brick')) layer = r1 < 0.6 ? 'brick_red' : 'brick_light';
  else if (material.includes('glass') || material.includes('mirror')) layer = 'glass';
  else if (material.includes('concrete') || material.includes('cement')) layer = 'concrete';
  else if (material.includes('wood') || material.includes('timber') || material.includes('vinyl')) layer = 'siding';
  else if (material.includes('metal') || material.includes('steel') || material.includes('alumin')) layer = 'metal';
  else if (material.includes('plaster') || material.includes('stucco') || material.includes('render')) layer = 'plaster';
  else if (material.includes('stone') || material.includes('lime') || material.includes('sand')) layer = 'brick_light';
  else if (isHouse) layer = r1 < 0.42 ? 'siding' : r1 < 0.72 ? 'brick_red' : r1 < 0.86 ? 'brick_light' : 'plaster';
  else if (RESIDENTIAL.has(type)) layer = r1 < 0.35 ? 'brick_red' : r1 < 0.55 ? 'brick_light' : r1 < 0.8 ? 'concrete' : 'plaster';
  else if (COMMERCIAL.has(type)) layer = height > 30 ? (r1 < 0.6 ? 'glass' : 'concrete') : r1 < 0.4 ? 'concrete' : r1 < 0.7 ? 'brick_light' : 'plaster';
  else if (INDUSTRIAL.has(type)) layer = r1 < 0.6 ? 'metal' : 'concrete';
  else if (CIVIC.has(type)) layer = r1 < 0.45 ? 'brick_light' : r1 < 0.75 ? 'brick_red' : 'concrete';
  else if (height > 40) layer = r1 < 0.55 ? 'glass' : 'concrete';
  else if (height > 15) layer = r1 < 0.4 ? 'concrete' : r1 < 0.7 ? 'brick_red' : 'brick_light';
  else layer = r1 < 0.35 ? 'brick_red' : r1 < 0.6 ? 'plaster' : r1 < 0.8 ? 'siding' : 'brick_light';

  if (isHouse) {
    floorH = 2.9;
    bay = 3.6;
  } else if (COMMERCIAL.has(type) || layer === 'glass') {
    floorH = 3.8;
    bay = 2.8;
  } else if (INDUSTRIAL.has(type)) {
    floorH = 5.5;
    bay = 7;
    windows = r2 < 0.6;
  }
  if (Number.isFinite(levels) && levels > 0) floorH = THREE.MathUtils.clamp(height / levels, 2.6, 6);

  let tintHex = 0xffffff;
  if (layer === 'plaster') tintHex = pick(PLASTER_TINTS, r2);
  else if (layer === 'siding') tintHex = pick(SIDING_TINTS, r2);
  else tintHex = new THREE.Color().setScalar(0.88 + r2 * 0.16).getHex();
  const tint = parseColour(tags['building:colour'] ?? tags['building:color'], tintHex);
  if (tags['building:colour'] && (layer === 'brick_red' || layer === 'brick_light' || layer === 'glass')) {
    // photo brick already has colour: only lean towards the tagged one
    tint.lerp(new THREE.Color(1, 1, 1), 0.55);
  }
  const shape = (tags['roof:shape'] ?? '').toLowerCase();
  const pitched =
    (isHouse || (type === 'yes' && height < 10 && footprintArea < 220)) &&
    footprintArea < 320 &&
    shape !== 'flat' &&
    (Number.isNaN(levels) || levels <= 3);
  const roofTint = parseColour(
    tags['roof:colour'] ?? tags['roof:color'],
    pitched ? pick(PITCHED_ROOF_TINTS, r3) : pick(FLAT_ROOF_TINTS, r3),
  );
  return { layer, tint, roofTint, floorH, bay, windows, pitched };
}

/** One merged mesh for all buildings in a tile (single shared material). */
class BuildingAccumulator {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  bld: number[] = [];
  win: number[] = [];
  idx: number[] = [];
  count = 0;

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: THREE.Color, b: number[], w: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
    this.bld.push(b[0], b[1], b[2], b[3]);
    this.win.push(w);
    return i;
  }

  /** Planar polygon (quad/tri) with a flat normal; flips winding so the normal faces `want`. */
  poly(pts: THREE.Vector3[], uvs: number[][], c: THREE.Color, b: number[], w: number, want?: THREE.Vector3): void {
    const e1 = new THREE.Vector3().subVectors(pts[1], pts[0]);
    const e2 = new THREE.Vector3().subVectors(pts[2], pts[0]);
    const n = new THREE.Vector3().crossVectors(e1, e2).normalize();
    let flip = false;
    if (want && n.dot(want) < 0) {
      n.negate();
      flip = true;
    }
    const ids = pts.map((p, k) => this.vert(p.x, p.y, p.z, n.x, n.y, n.z, uvs[k][0], uvs[k][1], c, b, w));
    for (let k = 1; k < ids.length - 1; k++) {
      if (flip) this.idx.push(ids[0], ids[k + 1], ids[k]);
      else this.idx.push(ids[0], ids[k], ids[k + 1]);
    }
  }

  wallQuad(p: Pt, q: Pt, yb: number, yt: number, u0: number, u1: number, base: number, c: THREE.Color, b: number[], w: number): void {
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dz / len;
    const nz = -dx / len;
    const a = this.vert(p.x, yb, p.z, nx, 0, nz, u0, yb - base, c, b, w);
    const bb = this.vert(q.x, yb, q.z, nx, 0, nz, u1, yb - base, c, b, w);
    const cc = this.vert(q.x, yt, q.z, nx, 0, nz, u1, yt - base, c, b, w);
    const d = this.vert(p.x, yt, p.z, nx, 0, nz, u0, yt - base, c, b, w);
    this.idx.push(a, cc, bb, a, d, cc);
  }

  flatRoof(ring: Pt[], y: number, c: THREE.Color, b: number[]): void {
    const contour = ring.map((p) => new THREE.Vector2(p.x, p.z));
    let tris: number[][];
    try {
      tris = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      return;
    }
    const base = this.pos.length / 3;
    for (const p of ring) this.vert(p.x, y, p.z, 0, 1, 0, p.x, p.z, c, b, 0);
    for (const t of tris) {
      const [i0, i1, i2] = t;
      const a = ring[i0];
      const bq = ring[i1];
      const cq = ring[i2];
      // y of (b−a)×(c−a) = e.z f.x − e.x f.z; must be > 0 to face up
      const ny = (bq.z - a.z) * (cq.x - a.x) - (bq.x - a.x) * (cq.z - a.z);
      if (ny >= 0) this.idx.push(base + i0, base + i1, base + i2);
      else this.idx.push(base + i0, base + i2, base + i1);
    }
  }

  build(material: THREE.Material): THREE.Mesh | null {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aBldg', new THREE.Float32BufferAttribute(this.bld, 4));
    g.setAttribute('aWin', new THREE.Float32BufferAttribute(this.win, 1));
    const vc = this.pos.length / 3;
    g.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}

export class BuildingBuilder {
  private handle: BuildingMaterialHandle;
  private unsub: (() => void) | null = null;

  constructor(textures: TextureLibrary | null = null) {
    this.handle = createBuildingMaterial();
    if (textures) this.unsub = textures.onReady(() => this.handle.setFacades(textures.getBuildingFacades()));
  }

  get material(): THREE.MeshStandardMaterial {
    return this.handle.material;
  }

  setNightGlow(night: number): void {
    this.handle.setNight(night);
  }

  /**
   * Walls + roofs for one footprint (local metres, any winding). Ground under
   * the footprint → plinth from the lowest point, eaves `height` above the highest.
   */
  private addBuilding(
    acc: BuildingAccumulator,
    local: Pt[],
    tags: Record<string, string>,
    id: number,
    groundAt: ((x: number, z: number) => number) | null,
  ): boolean {
    const pts = cleanFootprint(local);
    if (pts.length < 3) return false;
    let area = signedAreaXZ(pts);
    const ring = area < 0 ? pts.slice().reverse() : pts;
    area = Math.abs(area);
    if (area < MIN_FOOTPRINT_AREA || area > MAX_FOOTPRINT_AREA) return false;
    let cx = 0;
    let cz = 0;
    for (const p of ring) {
      cx += p.x;
      cz += p.z;
    }
    cx /= ring.length;
    cz /= ring.length;

    let minY = Infinity;
    let maxY = -Infinity;
    if (groundAt) {
      for (const p of [...ring, { x: cx, z: cz }]) {
        const y = groundAt(p.x, p.z);
        if (Number.isFinite(y)) {
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) minY = maxY = 0;
    if (maxY - minY > 25) maxY = minY + 25;

    const height = buildingHeight(tags, id);
    const st = styleFor(tags, id, height, area);
    const yb = minY - PLINTH_M;
    const yt = maxY + height;
    const seed = hash01(id * 3 + 1) * 0.999;
    const layer = LAYER_INDEX[st.layer];
    const wallB = [layer, st.floorH, Math.floor(st.bay) + seed, st.windows ? 0 : 3];
    const winTop = yt - minY - 0.7;

    let u = 0;
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k];
      const q = ring[(k + 1) % ring.length];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      acc.wallQuad(p, q, yb, yt, u, u + len, minY, st.tint, wallB, winTop);
      u += len;
    }

    if (!(st.pitched && this.addGable(acc, ring, area, cx, cz, yt, minY, st, wallB))) {
      acc.flatRoof(ring, yt, st.roofTint, [LAYER_INDEX.roof_flat, st.floorH, seed, 1]);
    }
    acc.count++;
    return true;
  }

  /** Simple gable roof over the footprint's oriented box (small, roughly rectangular houses). */
  private addGable(
    acc: BuildingAccumulator,
    ring: Pt[],
    area: number,
    cx: number,
    cz: number,
    yt: number,
    minY: number,
    st: BuildingStyle,
    wallB: number[],
  ): boolean {
    // Axis = longest edge direction
    let best = 0;
    let ax = 1;
    let az = 0;
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k];
      const q = ring[(k + 1) % ring.length];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      if (len > best) {
        best = len;
        ax = (q.x - p.x) / len;
        az = (q.z - p.z) / len;
      }
    }
    const bx = -az;
    const bz = ax;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of ring) {
      const a = (p.x - cx) * ax + (p.z - cz) * az;
      const b = (p.x - cx) * bx + (p.z - cz) * bz;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a);
      b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const boxArea = (a1 - a0) * (b1 - b0);
    if (boxArea <= 0 || area / boxArea < 0.78) return false;
    // ridge runs along the longer side
    if (b1 - b0 > a1 - a0) {
      return false; // longest edge wasn't the long side (odd shapes) — keep it flat
    }
    const o = 0.35;
    const half = (b1 - b0) / 2;
    const bm = (b0 + b1) / 2;
    const rise = Math.min(4.5, half * 0.62);
    const P = (a: number, b: number, y: number) => new THREE.Vector3(cx + ax * a + bx * b, y, cz + az * a + bz * b);
    const roofB = [LAYER_INDEX.roof_pitched, st.floorH, 0, 2];
    const up = new THREE.Vector3(0, 1, 0);
    const slope = Math.hypot(half + o, rise);
    const yE = yt - o * (rise / half);
    // two roof planes
    acc.poly(
      [P(a0 - o, b0 - o, yE), P(a1 + o, b0 - o, yE), P(a1 + o, bm, yt + rise), P(a0 - o, bm, yt + rise)],
      [[a0 - o, 0], [a1 + o, 0], [a1 + o, slope], [a0 - o, slope]],
      st.roofTint, roofB, 0, up,
    );
    acc.poly(
      [P(a1 + o, b1 + o, yE), P(a0 - o, b1 + o, yE), P(a0 - o, bm, yt + rise), P(a1 + o, bm, yt + rise)],
      [[a1 + o, 0], [a0 - o, 0], [a0 - o, slope], [a1 + o, slope]],
      st.roofTint, roofB, 0, up,
    );
    // gable ends (plain wall)
    const gB = [wallB[0], wallB[1], wallB[2], 3];
    for (const [a, sgn] of [[a0, -1], [a1, 1]] as const) {
      const out = new THREE.Vector3(ax * sgn, 0, az * sgn);
      acc.poly(
        [P(a, b0, yt), P(a, b1, yt), P(a, bm, yt + rise)],
        [[b0, yt - minY], [b1, yt - minY], [bm, yt + rise - minY]],
        st.tint, gB, 0, out,
      );
    }
    return true;
  }

  /**
   * v1.3.3: built in ~5 ms slices and merged into ONE mesh per tile with the
   * shared building material (per-vertex style data instead of per-material).
   */
  async buildAsync(
    buildings: OsmWay[],
    origin: GeoOrigin,
    heightAt?: (lat: number, lon: number) => number,
    isCancelled: () => boolean = () => false,
  ): Promise<THREE.Group> {
    const group = new THREE.Group();
    group.name = 'buildings';
    const acc = new BuildingAccumulator();
    const groundAt = heightAt
      ? (x: number, z: number) => {
          const ll = origin.toLatLon(x, z);
          return heightAt(ll.lat, ll.lon);
        }
      : null;
    let t0 = performance.now();
    for (const b of buildings) {
      if (performance.now() - t0 > SLICE_MS) {
        await nextSlice();
        t0 = performance.now();
        if (isCancelled()) return group;
      }
      if (b.geometry.length < 3) continue;
      const local = b.geometry.map((n) => origin.toLocal(n.lat, n.lon));
      this.addBuilding(acc, local, b.tags, b.id, groundAt);
    }
    const mesh = acc.build(this.handle.material);
    if (mesh) group.add(mesh);
    group.userData.count = acc.count;
    return group;
  }

  /**
   * Procedural block-fill buildings along road sides when OSM density is sparse
   * or when using offline fallback grids. Capped count for FPS.
   */
  buildFillers(
    centerlines: RoadCenterline[],
    origin: GeoOrigin,
    heightAt: ((lat: number, lon: number) => number) | undefined,
    opts: { maxCount: number; seed?: number } = { maxCount: 140 },
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = 'buildings-fill';
    group.userData.count = 0;
    const acc = new BuildingAccumulator();
    const maxCount = Math.max(0, Math.min(220, opts.maxCount));
    if (maxCount === 0 || centerlines.length === 0) return group;
    const groundAt = heightAt
      ? (x: number, z: number) => {
          const ll = origin.toLatLon(x, z);
          return heightAt(ll.lat, ll.lon);
        }
      : null;

    const placed: Array<{ x: number; z: number }> = [];
    const minSep2 = 16 * 16;
    let seed = opts.seed ?? 42;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    let added = 0;
    for (const line of centerlines) {
      if (added >= maxCount) break;
      const hwy = line.highway;
      if (hwy === 'service' || hwy === 'track' || hwy === 'motorway_link') continue;
      if (line.structure && line.structure !== 'ground') continue;
      const half = Math.max(2.5, (line.width ?? 6) * 0.5);
      const pts = line.points;
      if (pts.length < 2) continue;

      let along = 0;
      let nextAt = 14 + rnd() * 10;
      for (let i = 1; i < pts.length && added < maxCount; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        if (!Number.isFinite(seg) || seg < 1) continue;
        const prev = along;
        along += seg;
        const dx = (b.x - a.x) / seg;
        const dz = (b.z - a.z) / seg;
        const nx = -dz;
        const nz = dx;
        while (nextAt <= along && added < maxCount) {
          const t = (nextAt - prev) / seg;
          const cx = a.x + (b.x - a.x) * t;
          const cz = a.z + (b.z - a.z) * t;
          const side = rnd() < 0.5 ? -1 : 1;
          const setback = half + 7 + rnd() * 9;
          const bx = cx + nx * side * setback;
          const bz = cz + nz * side * setback;
          if (
            placed.some((p) => (p.x - bx) ** 2 + (p.z - bz) ** 2 < minSep2) ||
            !Number.isFinite(bx) ||
            !Number.isFinite(bz)
          ) {
            nextAt += 18 + rnd() * 12;
            continue;
          }
          const w = 8 + rnd() * 14;
          const d = 7 + rnd() * 12;
          const main = hwy === 'primary' || hwy === 'secondary';
          const h = main ? 10 + rnd() * 22 : 6 + rnd() * 12;
          // footprint aligned with the road (along = (dx,dz), across = (nx,nz))
          const hw = w / 2;
          const hd = d / 2;
          const corner = (sa: number, sb: number): Pt => ({
            x: bx + dx * sa * hw + nx * sb * hd,
            z: bz + dz * sa * hw + nz * sb * hd,
          });
          const fp = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
          const fid = 7_000_000_000 + Math.floor(rnd() * 1e9);
          const tags = {
            building: main ? (rnd() < 0.6 ? 'commercial' : 'apartments') : rnd() < 0.55 ? 'house' : 'residential',
            height: h.toFixed(1),
          };
          if (this.addBuilding(acc, fp, tags, fid, groundAt)) {
            placed.push({ x: bx, z: bz });
            added++;
          }
          nextAt += 20 + rnd() * 14;
        }
      }
    }
    const mesh = acc.build(this.handle.material);
    if (mesh) group.add(mesh);
    group.userData.count = added;
    return group;
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    this.handle.material.dispose();
  }
}
