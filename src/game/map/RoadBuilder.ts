import * as THREE from 'three';
import type { OsmWay } from './OverpassClient';
import type { GeoOrigin } from './geo';
import {
  defaultAsphaltProfile,
  resolveSurfaceProfile,
  weatherRoughness,
  weatherTintColor,
  type SurfaceKind,
  type SurfaceProfile,
} from './RoadSurface';
import type { WeatherPreset } from '../weather/Environment';

/** Lift asphalt slightly above DEM / terrain to avoid Z-fighting and sinking. */
export const ROAD_Y_BIAS = 0.14;

/** Max miter length as a multiple of half-width (clamps exploding sharp corners). */
const MAX_MITER_FACTOR = 2.0;

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
}

const WIDTH_BY_HIGHWAY: Record<string, number> = {
  motorway: 14,
  trunk: 12,
  primary: 10,
  secondary: 9,
  tertiary: 8,
  unclassified: 7,
  residential: 6.5,
  living_street: 5.5,
  service: 4.5,
  track: 3.5,
  motorway_link: 7,
  trunk_link: 6.5,
  primary_link: 6,
  secondary_link: 5.5,
  tertiary_link: 5,
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
  if (!Number.isFinite(width) || width < 0.5 || width > 40) return null;

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
    if (turnDot < 0.15) {
      const bevel = half * (turnDot < -0.5 ? 1.1 : 1.35);
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
    const u = dist * 0.08;
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

function laneMarkTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2a2a2e';
  ctx.fillRect(0, 0, 64, 256);
  ctx.fillStyle = '#d8d8d0';
  ctx.fillRect(30, 0, 4, 40);
  ctx.fillRect(30, 80, 4, 40);
  ctx.fillRect(30, 160, 4, 40);
  ctx.fillRect(30, 240, 4, 16);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

function yieldFrame(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export class RoadBuilder {
  private matsByKind = new Map<SurfaceKind, THREE.MeshStandardMaterial>();
  private profilesByKind = new Map<SurfaceKind, SurfaceProfile>();
  private laneMat: THREE.MeshStandardMaterial;
  private sharedLaneTex: THREE.CanvasTexture;
  private weather: WeatherPreset = 'clear';
  private disposed = false;

  constructor() {
    this.sharedLaneTex = laneMarkTexture();
    this.laneMat = new THREE.MeshStandardMaterial({
      map: this.sharedLaneTex,
      roughness: 0.85,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      depthWrite: true,
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
    mat = new THREE.MeshStandardMaterial({
      color: weatherTintColor(p.color, this.weather),
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
   * Yields periodically so large tiles don't freeze the main thread.
   */
  async buildWaysAsync(
    ways: OsmWay[],
    origin: GeoOrigin,
    heightAt?: (lat: number, lon: number) => number,
  ): Promise<{ group: THREE.Group; centerlines: RoadCenterline[] }> {
    const group = new THREE.Group();
    group.name = 'roads';

    const geosByKind = new Map<SurfaceKind, THREE.BufferGeometry[]>();
    const laneGeos: THREE.BufferGeometry[] = [];
    const centerlines: RoadCenterline[] = [];

    let processed = 0;
    for (const way of ways) {
      if (this.disposed) break;
      const highway = way.tags.highway ?? 'residential';
      const profile = resolveSurfaceProfile(way.tags);
      // Offline synthetic ways without surface still get asphalt
      if (!way.tags.surface && !way.tags.highway) {
        Object.assign(profile, defaultAsphaltProfile());
      }
      this.ensureMat(profile.kind);

      const width = roadWidth(highway);
      const pts: THREE.Vector3[] = [];
      const clPoints: RoadCenterPoint[] = [];
      for (const n of way.geometry) {
        const p = origin.toLocal(n.lat, n.lon);
        let y = heightAt ? heightAt(n.lat, n.lon) : 0;
        y = finiteY(y);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
        pts.push(new THREE.Vector3(p.x, y, p.z));
        clPoints.push({ x: p.x, y: y + ROAD_Y_BIAS, z: p.z });
      }
      if (clPoints.length >= 2) {
        centerlines.push({ points: clPoints, surface: profile, highway });
      }

      const cleaned: THREE.Vector3[] = [];
      for (const p of pts) {
        if (cleaned.length === 0 || cleaned[cleaned.length - 1].distanceToSquared(p) > 0.25) {
          cleaned.push(p);
        }
      }
      if (cleaned.length < 2) continue;
      if (cleaned.length > MAX_WAY_VERTS) {
        // Decimate evenly to cap mesh cost
        const step = Math.ceil(cleaned.length / MAX_WAY_VERTS);
        const dec: THREE.Vector3[] = [];
        for (let i = 0; i < cleaned.length; i += step) dec.push(cleaned[i]);
        if (dec[dec.length - 1] !== cleaned[cleaned.length - 1]) {
          dec.push(cleaned[cleaned.length - 1]);
        }
        cleaned.length = 0;
        cleaned.push(...dec);
      }

      const asphalt = buildRibbonGeometry(cleaned, width);
      if (asphalt) {
        let list = geosByKind.get(profile.kind);
        if (!list) {
          list = [];
          geosByKind.set(profile.kind, list);
        }
        list.push(asphalt);
      }

      const major =
        highway === 'motorway' ||
        highway === 'trunk' ||
        highway === 'primary' ||
        highway === 'secondary';
      if (major && width >= 8 && profile.kind === 'asphalt') {
        const lane = buildRibbonGeometry(cleaned, Math.min(0.35, width * 0.04), ROAD_Y_BIAS + 0.03);
        if (lane) laneGeos.push(lane);
      }

      processed++;
      if (processed % YIELD_EVERY === 0) {
        await yieldFrame();
      }
    }

    for (const [kind, geos] of geosByKind) {
      if (geos.length === 0) continue;
      const merged = mergeGeometries(geos);
      if (merged) {
        const mesh = new THREE.Mesh(merged, this.ensureMat(kind));
        mesh.receiveShadow = true;
        mesh.name = `surface-${kind}`;
        group.add(mesh);
      }
      for (const g of geos) g.dispose();
    }

    if (laneGeos.length) {
      const merged = mergeGeometries(laneGeos);
      if (merged) {
        const mesh = new THREE.Mesh(merged, this.laneMat);
        mesh.name = 'lanes';
        group.add(mesh);
      }
      for (const g of laneGeos) g.dispose();
    }

    return { group, centerlines };
  }

  /** Sync wrapper for small fallback grids. */
  buildWays(
    ways: OsmWay[],
    origin: GeoOrigin,
    heightAt?: (lat: number, lon: number) => number,
  ): { group: THREE.Group; centerlines: RoadCenterline[] } {
    // Fire-and-forget style sync path: no yields (fallback grids are small)
    const group = new THREE.Group();
    group.name = 'roads';
    const geosByKind = new Map<SurfaceKind, THREE.BufferGeometry[]>();
    const laneGeos: THREE.BufferGeometry[] = [];
    const centerlines: RoadCenterline[] = [];

    for (const way of ways) {
      const highway = way.tags.highway ?? 'residential';
      const profile = way.tags.surface
        ? resolveSurfaceProfile(way.tags)
        : resolveSurfaceProfile({
            ...way.tags,
            surface: way.tags.surface ?? 'asphalt',
          });
      // Ensure offline defaults to asphalt
      if (!way.tags.surface) {
        const asphalt = defaultAsphaltProfile();
        profile.kind = asphalt.kind;
        profile.color = asphalt.color;
        profile.roughness = asphalt.roughness;
        profile.grip = asphalt.grip + (highway === 'primary' ? 0.04 : highway === 'track' ? -0.08 : 0);
        profile.noise = asphalt.noise;
        profile.wetRetain = asphalt.wetRetain;
        profile.snowRetain = asphalt.snowRetain;
        profile.label = asphalt.label;
        profile.metalness = asphalt.metalness;
      }
      this.ensureMat(profile.kind);

      const width = roadWidth(highway);
      const pts: THREE.Vector3[] = [];
      const clPoints: RoadCenterPoint[] = [];
      for (const n of way.geometry) {
        const p = origin.toLocal(n.lat, n.lon);
        const y = finiteY(heightAt ? heightAt(n.lat, n.lon) : 0);
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
        pts.push(new THREE.Vector3(p.x, y, p.z));
        clPoints.push({ x: p.x, y: y + ROAD_Y_BIAS, z: p.z });
      }
      if (clPoints.length >= 2) {
        centerlines.push({ points: clPoints, surface: profile, highway });
      }

      const cleaned: THREE.Vector3[] = [];
      for (const p of pts) {
        if (cleaned.length === 0 || cleaned[cleaned.length - 1].distanceToSquared(p) > 0.25) {
          cleaned.push(p);
        }
      }
      if (cleaned.length < 2) continue;

      const asphalt = buildRibbonGeometry(cleaned, width);
      if (asphalt) {
        let list = geosByKind.get(profile.kind);
        if (!list) {
          list = [];
          geosByKind.set(profile.kind, list);
        }
        list.push(asphalt);
      }

      const major =
        highway === 'motorway' ||
        highway === 'trunk' ||
        highway === 'primary' ||
        highway === 'secondary';
      if (major && width >= 8) {
        const lane = buildRibbonGeometry(cleaned, Math.min(0.35, width * 0.04), ROAD_Y_BIAS + 0.03);
        if (lane) laneGeos.push(lane);
      }
    }

    for (const [kind, geos] of geosByKind) {
      const merged = mergeGeometries(geos);
      if (merged) {
        const mesh = new THREE.Mesh(merged, this.ensureMat(kind));
        mesh.receiveShadow = true;
        mesh.name = `surface-${kind}`;
        group.add(mesh);
      }
      for (const g of geos) g.dispose();
    }
    if (laneGeos.length) {
      const merged = mergeGeometries(laneGeos);
      if (merged) {
        const mesh = new THREE.Mesh(merged, this.laneMat);
        mesh.name = 'lanes';
        group.add(mesh);
      }
      for (const g of laneGeos) g.dispose();
    }

    return { group, centerlines };
  }

  dispose(): void {
    this.disposed = true;
    for (const mat of this.matsByKind.values()) mat.dispose();
    this.matsByKind.clear();
    this.laneMat.dispose();
    this.sharedLaneTex.dispose();
  }
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
