import * as THREE from 'three';
import type { OsmWay } from './OverpassClient';
import type { GeoOrigin } from './geo';
import type { RoadCenterline } from './RoadBuilder';
import { makeBuildingFacade } from '../visuals/Textures';

const BUILDING_COLORS = [0x8a9099, 0x9aa3ad, 0x7d858f, 0xa8b0b8, 0x6e7680, 0xb0a89c];

/** Soft min footprint area (m²) — allow denser small lots without noise. */
const MIN_FOOTPRINT_AREA = 5.5;
const MAX_FOOTPRINT_AREA = 55_000;

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

export class BuildingBuilder {
  private materials: THREE.MeshStandardMaterial[];
  private facades: Array<{ map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture }>;

  constructor() {
    this.facades = BUILDING_COLORS.map((_, i) => makeBuildingFacade(i + 1));
    this.materials = BUILDING_COLORS.map(
      (c, i) =>
        new THREE.MeshStandardMaterial({
          color: c,
          map: this.facades[i].map,
          emissive: 0xffe6a8,
          emissiveMap: this.facades[i].emissiveMap,
          emissiveIntensity: 0,
          roughness: 0.78 + (i % 3) * 0.04,
          metalness: 0.08 + (i % 2) * 0.04,
          envMapIntensity: 0.55,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        }),
    );
  }

  setNightGlow(night: number): void {
    const e = Math.max(0, Math.min(1, night)) * 0.85;
    for (const m of this.materials) m.emissiveIntensity = e;
  }

  build(
    buildings: OsmWay[],
    origin: GeoOrigin,
    heightAt?: (lat: number, lon: number) => number,
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = 'buildings';

    let i = 0;
    for (const b of buildings) {
      if (b.geometry.length < 3) continue;

      const localRaw: Array<{ x: number; z: number; lat: number; lon: number }> = [];
      for (const node of b.geometry) {
        const p = origin.toLocal(node.lat, node.lon);
        localRaw.push({ x: p.x, z: p.z, lat: node.lat, lon: node.lon });
      }

      const local = cleanFootprint(localRaw.map((p) => ({ x: p.x, z: p.z })));
      if (local.length < 3) continue;

      let cx = 0;
      let cz = 0;
      for (const p of local) {
        cx += p.x;
        cz += p.z;
      }
      cx /= local.length;
      cz /= local.length;

      let area = Math.abs(signedAreaXZ(local));
      if (area < MIN_FOOTPRINT_AREA || area > MAX_FOOTPRINT_AREA) continue;

      // Ensure CCW in shape space (x, z) so extrusion faces wind correctly after rotateX
      const ring = signedAreaXZ(local) < 0 ? local.slice().reverse() : local.slice();

      const shape = new THREE.Shape();
      for (let k = 0; k < ring.length; k++) {
        const x = ring[k].x - cx;
        const y = ring[k].z - cz;
        if (k === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      }
      shape.closePath();

      const height = buildingHeight(b.tags, b.id);
      let geo: THREE.ExtrudeGeometry;
      try {
        geo = new THREE.ExtrudeGeometry(shape, {
          depth: height,
          bevelEnabled: false,
          steps: 1,
        });
      } catch {
        continue;
      }
      // Extrude goes along +Z in shape space; rotate to Y-up
      geo.rotateX(-Math.PI / 2);
      geo.computeVertexNormals();
      const uv = geo.getAttribute('uv');
      if (uv) {
        // ~one facade tile per ~6 m horizontally; ~one floor (~3.1 m) vertically
        const uScale = Math.max(1.4, Math.sqrt(area) * 0.1);
        const floors = Math.max(1, height / 3.15);
        const vScale = Math.max(1.5, floors * 0.95);
        for (let u = 0; u < uv.count; u++) {
          uv.setXY(u, uv.getX(u) * uScale, uv.getY(u) * vScale);
        }
        uv.needsUpdate = true;
      }

      const mat = this.materials[i % this.materials.length];
      i++;
      const mesh = new THREE.Mesh(geo, mat);

      // Base height at footprint centroid (not first node) to reduce float/sink on slopes
      let baseY = 0;
      if (heightAt) {
        let sumLat = 0;
        let sumLon = 0;
        let n = 0;
        for (const node of b.geometry) {
          sumLat += node.lat;
          sumLon += node.lon;
          n++;
        }
        baseY = heightAt(sumLat / n, sumLon / n);
      }
      // Tiny lift above terrain — avoid floaters
      if (!Number.isFinite(baseY)) baseY = 0;
      mesh.position.set(cx, baseY + 0.02, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    return group;
  }

  /**
   * Procedural block-fill buildings along road sides when OSM density is sparse
   * or when using offline fallback grids. Shared materials; capped count for FPS.
   */
  buildFillers(
    centerlines: RoadCenterline[],
    origin: GeoOrigin,
    heightAt: ((lat: number, lon: number) => number) | undefined,
    opts: { maxCount: number; seed?: number } = { maxCount: 140 },
  ): THREE.Group {
    const group = new THREE.Group();
    group.name = 'buildings-fill';
    const maxCount = Math.max(0, Math.min(220, opts.maxCount));
    if (maxCount === 0 || centerlines.length === 0) return group;

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
      // Skip thin service/track for fillers
      if (hwy === 'service' || hwy === 'track' || hwy === 'motorway_link') continue;
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
          const h =
            hwy === 'primary' || hwy === 'secondary'
              ? 10 + rnd() * 22
              : 6 + rnd() * 12;

          const ll = origin.toLatLon(bx, bz);
          let baseY = heightAt ? heightAt(ll.lat, ll.lon) : 0;
          if (!Number.isFinite(baseY)) baseY = 0;

          const geo = new THREE.BoxGeometry(w, h, d);
          // UV stretch roughly by floors
          const uv = geo.getAttribute('uv');
          if (uv) {
            const uScale = Math.max(1.2, w / 6);
            const vScale = Math.max(1.2, h / 3.15);
            for (let u = 0; u < uv.count; u++) {
              uv.setXY(u, uv.getX(u) * uScale, uv.getY(u) * vScale);
            }
            uv.needsUpdate = true;
          }

          const mat = this.materials[added % this.materials.length];
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set(bx, baseY + h * 0.5 + 0.02, bz);
          // Align long axis roughly with road
          mesh.rotation.y = Math.atan2(dx, dz);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          group.add(mesh);
          placed.push({ x: bx, z: bz });
          added++;
          nextAt += 20 + rnd() * 14;
        }
      }
    }

    return group;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    for (const f of this.facades) {
      f.map.dispose();
      f.emissiveMap.dispose();
    }
  }
}
