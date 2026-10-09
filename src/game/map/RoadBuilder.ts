import * as THREE from 'three';
import type { OsmWay } from './OverpassClient';
import {
  defaultAsphaltProfile,
  resolveSurfaceProfile,
  weatherRoughness,
  weatherTintColor,
  type SurfaceKind,
  type SurfaceProfile,
} from './RoadSurface';
import type { WeatherPreset } from '../weather/Environment';
import { profileWays, type ProfileEnv, type ProfiledWay, type RoadStructure } from './RoadProfile';
import { makeEdgeLineTexture, makeLaneTexture, makeRoadMaps, type SurfaceMaps } from '../visuals/Textures';

/** Lift asphalt slightly above DEM / terrain to avoid Z-fighting and sinking. */
export const ROAD_Y_BIAS = 0.2;

/** Max miter length as a multiple of half-width (clamps exploding sharp corners). */
const MAX_MITER_FACTOR = 1.22;

/** Skip ways with more than this many cleaned vertices (perf / freeze guard). */
const MAX_WAY_VERTS = 400;

/** Yield to event loop every N ways when building large tiles. */
const YIELD_EVERY = 24;

export interface RoadCenterPoint {
  x: number;
  y: number;
  z: number;
}

export interface RoadCenterline {
  points: RoadCenterPoint[];
  surface: SurfaceProfile;
  highway: string;
  /** OSM name / ref for signs & minimap. */
  name?: string;
  ref?: string;
  /** Total paved width (m) used for scale-aware sampling. */
  width: number;
  /** v1.3.2: OSM bridge / tunnel runs are level-interpolated and not carved into terrain. */
  structure: RoadStructure;
  layer: number;
}

/**
 * Total carriageway widths (meters). Aimed at ~3.0–3.5 m lanes so a ~1.8 m Golf
 * sits naturally (was visually oversized vs the hatch).
 */
const WIDTH_BY_HIGHWAY: Record<string, number> = {
  motorway: 13.5, // ~4 × 3.4 m
  trunk: 10.5, // ~3 × 3.5 m
  primary: 7.2, // 2 × 3.5 m + margin
  secondary: 7.0,
  tertiary: 6.6,
  unclassified: 6.2,
  residential: 6.4, // 2 × ~3.2 m
  living_street: 5.4,
  service: 3.8,
  track: 3.2,
  motorway_link: 5.5,
  trunk_link: 5.2,
  primary_link: 5.0,
  secondary_link: 4.8,
  tertiary_link: 4.6,
};

function roadWidth(highway: string | undefined): number {
  if (!highway) return 6;
  return WIDTH_BY_HIGHWAY[highway] ?? 6;
}

function finiteY(y: number): number {
  return Number.isFinite(y) ? y : 0;
}

function horizDir(from: THREE.Vector3, to: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
  const d = new THREE.Vector3().subVectors(to, from);
  d.y = 0;
  if (d.lengthSq() < 1e-8) return fallback.clone().normalize();
  return d.normalize();
}

/**
 * Ribbon with clamped miters — prevents width blow-ups at sharp OSM angles/junctions.
 * Winding is CCW when viewed from +Y so normals face up.
 */
function buildRibbonGeometry(
  points: THREE.Vector3[],
  width: number,
  yBias: number = ROAD_Y_BIAS,
): THREE.BufferGeometry | null {
  if (points.length < 2) return null;
  // Allow thin curb / lane-mark ribbons (~0.1–0.3 m); asphalt carriageways are wider.
  if (!Number.isFinite(width) || width < 0.06 || width > 40) return null;

  const half = width / 2;
  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  const defaultDir = new THREE.Vector3(1, 0, 0);

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      return null;
    }
    let dirIn: THREE.Vector3;
    let dirOut: THREE.Vector3;

    if (i === 0) {
      dirOut = horizDir(points[0], points[1], defaultDir);
      dirIn = dirOut.clone();
    } else if (i === points.length - 1) {
      dirIn = horizDir(points[i - 1], points[i], defaultDir);
      dirOut = dirIn.clone();
    } else {
      dirIn = horizDir(points[i - 1], points[i], defaultDir);
      dirOut = horizDir(points[i], points[i + 1], dirIn);
      if (dirIn.lengthSq() < 1e-8) dirIn = dirOut.clone();
      if (dirOut.lengthSq() < 1e-8) dirOut = dirIn.clone();
    }

    const nIn = new THREE.Vector3(-dirIn.z, 0, dirIn.x);
    const nOut = new THREE.Vector3(-dirOut.z, 0, dirOut.x);

    let miter = new THREE.Vector3().addVectors(nIn, nOut);
    if (miter.lengthSq() < 1e-6) {
      miter.copy(nOut);
    } else {
      miter.normalize();
    }

    let miterLen = half;
    const denom = miter.dot(nOut);
    if (Math.abs(denom) > 1e-4) {
      miterLen = half / denom;
    }

    const maxLen = half * MAX_MITER_FACTOR;
    if (!Number.isFinite(miterLen)) miterLen = half;
    if (miterLen > maxLen) miterLen = maxLen;
    if (miterLen < -maxLen) miterLen = -maxLen;

    const turnDot = THREE.MathUtils.clamp(dirIn.dot(dirOut), -1, 1);
    if (turnDot < 0.35) {
      const bevel = half * (turnDot < 0 ? 1.02 : 1.12);
      miterLen = Math.sign(miterLen || 1) * Math.min(Math.abs(miterLen), bevel);
    }

    const y = finiteY(p.y) + yBias;
    left.push(new THREE.Vector3(p.x + miter.x * miterLen, y, p.z + miter.z * miterLen));
    right.push(new THREE.Vector3(p.x - miter.x * miterLen, y, p.z - miter.z * miterLen));
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  let dist = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) dist += points[i].distanceTo(points[i - 1]);
    const u = dist * 0.12;
    positions.push(left[i].x, left[i].y, left[i].z);
    uvs.push(0, u);
    positions.push(right[i].x, right[i].y, right[i].z);
    uvs.push(1, u);
  }

  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, c, b, b, c, d);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}




/** Thin ribbon offset left (−) / right (+) of centerline for curbs / edge paint. */
function buildOffsetRibbonGeometry(
  points: THREE.Vector3[],
  offset: number,
  width: number,
  yBias: number = ROAD_Y_BIAS,
  yRaise = 0,
): THREE.BufferGeometry | null {
  if (points.length < 2 || !Number.isFinite(width) || width < 0.08) return null;
  const shifted: THREE.Vector3[] = [];
  const defaultDir = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let dir: THREE.Vector3;
    if (i === 0) dir = horizDir(points[0], points[1], defaultDir);
    else if (i === points.length - 1) dir = horizDir(points[i - 1], points[i], defaultDir);
    else {
      const a = horizDir(points[i - 1], points[i], defaultDir);
      const b = horizDir(points[i], points[i + 1], a);
      dir = new THREE.Vector3().addVectors(a, b);
      if (dir.lengthSq() < 1e-8) dir.copy(a);
      else dir.normalize();
    }
    const n = new THREE.Vector3(-dir.z, 0, dir.x);
    shifted.push(
      new THREE.Vector3(p.x + n.x * offset, finiteY(p.y) + yRaise, p.z + n.z * offset),
    );
  }
  return buildRibbonGeometry(shifted, width, yBias);
}

/** Vertical side walls + underside for bridge decks so they aren't paper-thin. */
function buildBridgeSides(points: THREE.Vector3[], width: number, depth: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  if (points.length < 2) return out;
  const half = width / 2 + 0.3;
  const defaultDir = new THREE.Vector3(1, 0, 0);
  const L: THREE.Vector3[] = [];
  const R: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    let dir: THREE.Vector3;
    if (i === 0) dir = horizDir(points[0], points[1], defaultDir);
    else if (i === points.length - 1) dir = horizDir(points[i - 1], points[i], defaultDir);
    else dir = horizDir(points[i - 1], points[i + 1], defaultDir);
    const n = new THREE.Vector3(-dir.z, 0, dir.x);
    L.push(new THREE.Vector3(p.x + n.x * half, p.y + ROAD_Y_BIAS + 0.05, p.z + n.z * half));
    R.push(new THREE.Vector3(p.x - n.x * half, p.y + ROAD_Y_BIAS + 0.05, p.z - n.z * half));
  }
  const wall = (edge: THREE.Vector3[], flip: boolean): THREE.BufferGeometry => {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    let d = 0;
    for (let i = 0; i < edge.length; i++) {
      if (i > 0) d += edge[i].distanceTo(edge[i - 1]);
      const e = edge[i];
      pos.push(e.x, e.y, e.z, e.x, e.y - depth, e.z);
      uv.push(d * 0.25, 1, d * 0.25, 0);
    }
    for (let i = 0; i < edge.length - 1; i++) {
      const a = i * 2;
      if (flip) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  out.push(wall(L, false), wall(R, true));
  // Underside (faces down)
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < L.length; i++) {
    pos.push(L[i].x, L[i].y - depth, L[i].z, R[i].x, R[i].y - depth, R[i].z);
    uv.push(0, i, 1, i);
  }
  for (let i = 0; i < L.length - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  out.push(g);
  return out;
}

function yieldFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export class RoadBuilder {
  private matsByKind = new Map<SurfaceKind, THREE.MeshStandardMaterial>();
  private profilesByKind = new Map<SurfaceKind, SurfaceProfile>();
  private mapsByKind = new Map<SurfaceKind, SurfaceMaps>();
  private laneMat: THREE.MeshStandardMaterial;
  private edgeMat: THREE.MeshStandardMaterial;
  private curbMat: THREE.MeshStandardMaterial;
  private sharedLaneTex: THREE.CanvasTexture;
  private sharedEdgeTex: THREE.CanvasTexture;
  private weather: WeatherPreset = 'clear';
  private disposed = false;

  constructor() {
    this.sharedLaneTex = makeLaneTexture();
    this.sharedEdgeTex = makeEdgeLineTexture();
    this.laneMat = new THREE.MeshStandardMaterial({
      map: this.sharedLaneTex,
      transparent: true,
      roughness: 0.55,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
      depthWrite: false,
    });
    this.edgeMat = new THREE.MeshStandardMaterial({
      map: this.sharedEdgeTex,
      color: 0xf0ece0,
      roughness: 0.5,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    });
    this.curbMat = new THREE.MeshStandardMaterial({
      color: 0x9a9690,
      roughness: 0.78,
      metalness: 0.06,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    // Pre-create common materials
    for (const kind of [
      'asphalt',
      'concrete',
      'gravel',
      'dirt',
      'grass',
      'cobblestone',
      'paving_stones',
      'compacted',
    ] as SurfaceKind[]) {
      this.ensureMat(kind);
    }
  }

  private ensureMat(kind: SurfaceKind): THREE.MeshStandardMaterial {
    let mat = this.matsByKind.get(kind);
    if (mat) return mat;
    const profile =
      kind === 'asphalt' ? defaultAsphaltProfile() : resolveSurfaceProfile({ surface: kind });
    // resolve with surface tag alone
    const p =
      kind === 'unknown'
        ? defaultAsphaltProfile()
        : { ...profile, kind, label: profile.label };
    this.profilesByKind.set(kind, p);
    const maps = makeRoadMaps(kind);
    this.mapsByKind.set(kind, maps);
    mat = new THREE.MeshStandardMaterial({
      color: weatherTintColor(p.color, this.weather),
      map: maps.map,
      roughnessMap: maps.roughnessMap,
      normalMap: maps.normalMap,
      normalScale: new THREE.Vector2(0.45, 0.45),
      roughness: weatherRoughness(p.roughness, this.weather),
      metalness: this.weather === 'rain' ? Math.min(0.35, p.metalness + 0.2) : p.metalness,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.matsByKind.set(kind, mat);
    return mat;
  }

  setWeatherSurface(weather: WeatherPreset): void {
    this.weather = weather;
    for (const [kind, mat] of this.matsByKind) {
      const p = this.profilesByKind.get(kind) ?? defaultAsphaltProfile();
      mat.color.setHex(weatherTintColor(p.color, weather));
      mat.roughness = weatherRoughness(p.roughness, weather);
      mat.metalness = weather === 'rain' ? Math.min(0.35, p.metalness + 0.2) : p.metalness;
      mat.needsUpdate = true;
    }
    if (weather === 'rain') {
      this.laneMat.roughness = 0.4;
    } else if (weather === 'snow') {
      this.laneMat.roughness = 0.8;
    } else {
      this.laneMat.roughness = 0.85;
    }
    this.laneMat.needsUpdate = true;
  }

  /**
   * Build road meshes grouped by surface kind (shared materials).
   * v1.3.2: heights come from the RoadProfile pass (smoothed, grade-capped,
   * junction-pinned, bridges/tunnels level). Yields periodically so large
   * tiles don't freeze the main thread.
   */
  async buildWaysAsync(
    ways: OsmWay[],
    env: ProfileEnv,
  ): Promise<{ group: THREE.Group; centerlines: RoadCenterline[] }> {
    const profiled = profileWays(ways, env);
    const acc = this.newAccumulator();
    let processed = 0;
    for (const pw of profiled) {
      if (this.disposed) break;
      this.addWay(pw, acc);
      processed++;
      if (processed % YIELD_EVERY === 0) await yieldFrame();
    }
    return this.finish(acc);
  }

  /** Sync path for small fallback grids. */
  buildWays(ways: OsmWay[], env: ProfileEnv): { group: THREE.Group; centerlines: RoadCenterline[] } {
    const fixed = ways.map((w) =>
      w.tags.surface ? w : { ...w, tags: { ...w.tags, surface: 'asphalt' } },
    );
    const profiled = profileWays(fixed, env);
    const acc = this.newAccumulator();
    for (const pw of profiled) this.addWay(pw, acc);
    return this.finish(acc);
  }

  private newAccumulator(): RoadAccumulator {
    return {
      geosByKind: new Map(),
      laneGeos: [],
      edgeGeos: [],
      curbGeos: [],
      bridgeGeos: [],
      centerlines: [],
    };
  }

  private addWay(pw: ProfiledWay, acc: RoadAccumulator): void {
    const way = pw.way;
    const highway = way.tags.highway ?? 'residential';
    const profile = resolveSurfaceProfile(way.tags);
    if (!way.tags.surface && !way.tags.highway) Object.assign(profile, defaultAsphaltProfile());
    this.ensureMat(profile.kind);

    const width = roadWidth(highway);
    const pts: THREE.Vector3[] = [];
    const clPoints: RoadCenterPoint[] = [];
    for (const p of pw.points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      const y = finiteY(p.y);
      pts.push(new THREE.Vector3(p.x, y, p.z));
      clPoints.push({ x: p.x, y: y + ROAD_Y_BIAS, z: p.z });
    }
    if (clPoints.length >= 2) {
      acc.centerlines.push({
        points: clPoints,
        surface: profile,
        highway,
        name: way.tags.name,
        ref: way.tags.ref,
        width,
        structure: pw.structure,
        layer: pw.layer,
      });
    }
    // Tunnels: keep the centreline for driving/minimap, but no ribbon over the hill
    if (pw.structure === 'tunnel') return;

    const cleaned: THREE.Vector3[] = [];
    for (const p of pts) {
      if (cleaned.length === 0 || cleaned[cleaned.length - 1].distanceToSquared(p) > 0.36) {
        cleaned.push(p);
      }
    }
    if (cleaned.length < 2) return;
    if (cleaned.length > MAX_WAY_VERTS) {
      const step = Math.ceil(cleaned.length / MAX_WAY_VERTS);
      const dec: THREE.Vector3[] = [];
      for (let i = 0; i < cleaned.length; i += step) dec.push(cleaned[i]);
      if (dec[dec.length - 1] !== cleaned[cleaned.length - 1]) dec.push(cleaned[cleaned.length - 1]);
      cleaned.length = 0;
      cleaned.push(...dec);
    }

    const paved = profile.kind === 'asphalt' || profile.kind === 'concrete' || profile.kind === 'unknown';
    // Visible curbs along paved road edges (raised edge strips)
    if (paved && width >= 4.2) {
      const half = width / 2;
      const curbW = 0.28;
      const left = buildOffsetRibbonGeometry(cleaned, -(half + curbW * 0.35), curbW, ROAD_Y_BIAS + 0.04, 0.06);
      const right = buildOffsetRibbonGeometry(cleaned, half + curbW * 0.35, curbW, ROAD_Y_BIAS + 0.04, 0.06);
      if (left) acc.curbGeos.push(left);
      if (right) acc.curbGeos.push(right);
    }

    const asphalt = buildRibbonGeometry(cleaned, width);
    if (asphalt) {
      let list = acc.geosByKind.get(profile.kind);
      if (!list) {
        list = [];
        acc.geosByKind.set(profile.kind, list);
      }
      list.push(asphalt);
    }

    if (pw.structure === 'bridge') acc.bridgeGeos.push(...buildBridgeSides(cleaned, width, 1.3));

    // Center dashed lane + edge paint for paved 2-lane+ roads (incl. fallback residential)
    if (paved && width >= 5.2) {
      const lane = buildRibbonGeometry(cleaned, Math.min(0.2, Math.max(0.12, width * 0.028)), ROAD_Y_BIAS + 0.025);
      if (lane) acc.laneGeos.push(lane);
      const half = width / 2;
      const edgeW = 0.12;
      const leftE = buildOffsetRibbonGeometry(cleaned, -(half - edgeW * 0.6), edgeW, ROAD_Y_BIAS + 0.02);
      const rightE = buildOffsetRibbonGeometry(cleaned, half - edgeW * 0.6, edgeW, ROAD_Y_BIAS + 0.02);
      if (leftE) acc.edgeGeos.push(leftE);
      if (rightE) acc.edgeGeos.push(rightE);
    }
  }

  private finish(acc: RoadAccumulator): { group: THREE.Group; centerlines: RoadCenterline[] } {
    const group = new THREE.Group();
    group.name = 'roads';
    const add = (geos: THREE.BufferGeometry[], mat: THREE.Material, name: string, shadow: boolean) => {
      if (!geos.length) return;
      const merged = mergeGeometries(geos);
      if (merged) {
        const mesh = new THREE.Mesh(merged, mat);
        mesh.receiveShadow = shadow;
        mesh.name = name;
        group.add(mesh);
      }
      for (const g of geos) g.dispose();
    };
    for (const [kind, geos] of acc.geosByKind) add(geos, this.ensureMat(kind), `surface-${kind}`, true);
    add(acc.curbGeos, this.curbMat, 'curbs', true);
    add(acc.bridgeGeos, this.curbMat, 'bridge-sides', true);
    add(acc.laneGeos, this.laneMat, 'lanes', false);
    add(acc.edgeGeos, this.edgeMat, 'edges', false);
    return { group, centerlines: acc.centerlines };
  }

  dispose(): void {
    this.disposed = true;
    for (const mat of this.matsByKind.values()) mat.dispose();
    this.matsByKind.clear();
    for (const maps of this.mapsByKind.values()) {
      maps.map.dispose();
      maps.roughnessMap.dispose();
      maps.normalMap.dispose();
    }
    this.mapsByKind.clear();
    this.laneMat.dispose();
    this.edgeMat.dispose();
    this.curbMat.dispose();
    this.sharedLaneTex.dispose();
    this.sharedEdgeTex.dispose();
  }
}

interface RoadAccumulator {
  geosByKind: Map<SurfaceKind, THREE.BufferGeometry[]>;
  laneGeos: THREE.BufferGeometry[];
  edgeGeos: THREE.BufferGeometry[];
  curbGeos: THREE.BufferGeometry[];
  bridgeGeos: THREE.BufferGeometry[];
  centerlines: RoadCenterline[];
}

function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geos.length === 0) return null;
  let vertCount = 0;
  let indexCount = 0;
  for (const g of geos) {
    vertCount += g.getAttribute('position').count;
    indexCount += g.getIndex()?.count ?? g.getAttribute('position').count;
  }
  // Hard cap to avoid OOM / freeze on pathological tiles
  if (vertCount > 250_000) {
    console.warn('Road merge truncated: too many verts', vertCount);
    // Keep first geos until under cap
    let kept = 0;
    let vc = 0;
    const trimmed: THREE.BufferGeometry[] = [];
    for (const g of geos) {
      const c = g.getAttribute('position').count;
      if (vc + c > 200_000) break;
      trimmed.push(g);
      vc += c;
      kept++;
    }
    if (kept === 0) return null;
    return mergeGeometries(trimmed);
  }

  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices: number[] = [];

  let vOffset = 0;
  let iWrite = 0;
  for (const g of geos) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nor = g.getAttribute('normal') as THREE.BufferAttribute | null;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute | null;
    const idx = g.getIndex();

    for (let i = 0; i < pos.count; i++) {
      positions[(vOffset + i) * 3] = pos.getX(i);
      positions[(vOffset + i) * 3 + 1] = pos.getY(i);
      positions[(vOffset + i) * 3 + 2] = pos.getZ(i);
      if (nor) {
        normals[(vOffset + i) * 3] = nor.getX(i);
        normals[(vOffset + i) * 3 + 1] = nor.getY(i);
        normals[(vOffset + i) * 3 + 2] = nor.getZ(i);
      } else {
        normals[(vOffset + i) * 3 + 1] = 1;
      }
      if (uv) {
        uvs[(vOffset + i) * 2] = uv.getX(i);
        uvs[(vOffset + i) * 2 + 1] = uv.getY(i);
      }
    }

    if (idx) {
      for (let i = 0; i < idx.count; i++) {
        indices[iWrite++] = idx.getX(i) + vOffset;
      }
    } else {
      for (let i = 0; i < pos.count; i++) {
        indices[iWrite++] = i + vOffset;
      }
    }
    vOffset += pos.count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setIndex(indices);
  return out;
}
