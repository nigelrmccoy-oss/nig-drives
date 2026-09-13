import * as THREE from 'three';
import type { OsmWay } from './OverpassClient';
import type { GeoOrigin } from './geo';

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

function buildRibbonGeometry(
  points: THREE.Vector3[],
  width: number,
): THREE.BufferGeometry | null {
  if (points.length < 2) return null;

  const half = width / 2;
  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];

  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dir = new THREE.Vector3().subVectors(next, prev);
    dir.y = 0;
    if (dir.lengthSq() < 1e-8) {
      dir.set(1, 0, 0);
    } else {
      dir.normalize();
    }
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    const p = points[i];
    left.push(new THREE.Vector3(p.x + perp.x * half, p.y + 0.05, p.z + perp.z * half));
    right.push(new THREE.Vector3(p.x - perp.x * half, p.y + 0.05, p.z - perp.z * half));
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
  return tex;
}

export class RoadBuilder {
  private asphaltMat: THREE.MeshStandardMaterial;
  private laneMat: THREE.MeshStandardMaterial;
  private sharedLaneTex: THREE.CanvasTexture;

  constructor() {
    this.sharedLaneTex = laneMarkTexture();
    this.asphaltMat = new THREE.MeshStandardMaterial({
      color: 0x2c2c30,
      roughness: 0.92,
      metalness: 0.05,
    });
    this.laneMat = new THREE.MeshStandardMaterial({
      map: this.sharedLaneTex,
      roughness: 0.85,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  }

  private baseAsphalt = 0x2c2c30;
  private baseRoughness = 0.92;

  setWeatherSurface(weather: 'clear' | 'rain' | 'snow'): void {
    if (weather === 'rain') {
      this.asphaltMat.color.setHex(0x1e242c);
      this.asphaltMat.roughness = 0.35;
      this.asphaltMat.metalness = 0.25;
    } else if (weather === 'snow') {
      this.asphaltMat.color.setHex(0x6a727a);
      this.asphaltMat.roughness = 0.75;
      this.asphaltMat.metalness = 0.05;
    } else {
      this.asphaltMat.color.setHex(this.baseAsphalt);
      this.asphaltMat.roughness = this.baseRoughness;
      this.asphaltMat.metalness = 0.05;
    }
  }

  buildWays(
    ways: OsmWay[],
    origin: GeoOrigin,
    heightAt?: (lat: number, lon: number) => number,
  ): { group: THREE.Group; centerlines: Array<{ x: number; y: number; z: number }[]> } {
    const group = new THREE.Group();
    group.name = 'roads';

    const asphaltGeos: THREE.BufferGeometry[] = [];
    const laneGeos: THREE.BufferGeometry[] = [];

    const centerlines: Array<{ x: number; y: number; z: number }[]> = [];

    for (const way of ways) {
      const highway = way.tags.highway;
      const width = roadWidth(highway);
      const pts: THREE.Vector3[] = [];
      const cl: { x: number; y: number; z: number }[] = [];
      for (const n of way.geometry) {
        const p = origin.toLocal(n.lat, n.lon);
        const y = heightAt ? heightAt(n.lat, n.lon) : 0;
        pts.push(new THREE.Vector3(p.x, y, p.z));
        cl.push({ x: p.x, y, z: p.z });
      }
      if (cl.length >= 2) centerlines.push(cl);
      // Deduplicate consecutive near-identical points
      const cleaned: THREE.Vector3[] = [];
      for (const p of pts) {
        if (cleaned.length === 0 || cleaned[cleaned.length - 1].distanceToSquared(p) > 0.25) {
          cleaned.push(p);
        }
      }
      if (cleaned.length < 2) continue;

      const asphalt = buildRibbonGeometry(cleaned, width);
      if (asphalt) asphaltGeos.push(asphalt);

      const major =
        highway === 'motorway' ||
        highway === 'trunk' ||
        highway === 'primary' ||
        highway === 'secondary';
      if (major && width >= 8) {
        const lane = buildRibbonGeometry(cleaned, Math.min(0.35, width * 0.04));
        if (lane) {
          // Lift lane marks slightly
          const pos = lane.getAttribute('position') as THREE.BufferAttribute;
          for (let i = 0; i < pos.count; i++) {
            pos.setY(i, pos.getY(i) + 0.04);
          }
          pos.needsUpdate = true;
          laneGeos.push(lane);
        }
      }
    }

    if (asphaltGeos.length) {
      const merged = mergeGeometries(asphaltGeos);
      if (merged) {
        const mesh = new THREE.Mesh(merged, this.asphaltMat);
        mesh.receiveShadow = true;
        group.add(mesh);
      }
      for (const g of asphaltGeos) g.dispose();
    }

    if (laneGeos.length) {
      const merged = mergeGeometries(laneGeos);
      if (merged) {
        const mesh = new THREE.Mesh(merged, this.laneMat);
        group.add(mesh);
      }
      for (const g of laneGeos) g.dispose();
    }

    return { group, centerlines };
  }

  dispose(): void {
    this.asphaltMat.dispose();
    this.laneMat.dispose();
    this.sharedLaneTex.dispose();
  }
}

function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geos.length === 0) return null;
  // Manual merge to avoid depending on BufferGeometryUtils path quirks
  let vertCount = 0;
  let indexCount = 0;
  for (const g of geos) {
    vertCount += g.getAttribute('position').count;
    indexCount += g.getIndex()?.count ?? g.getAttribute('position').count;
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
