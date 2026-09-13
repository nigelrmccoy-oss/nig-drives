import * as THREE from 'three';
import type { OsmWay } from './OverpassClient';
import type { GeoOrigin } from './geo';

const BUILDING_COLORS = [0x8a9099, 0x9aa3ad, 0x7d858f, 0xa8b0b8, 0x6e7680, 0xb0a89c];

function buildingHeight(tags: Record<string, string>): number {
  const h = tags.height ? parseFloat(tags.height) : NaN;
  if (!Number.isNaN(h) && h > 2 && h < 200) return h;
  const levels = tags['building:levels'] ? parseFloat(tags['building:levels']) : NaN;
  if (!Number.isNaN(levels) && levels > 0) return Math.min(levels * 3.2, 120);
  // Cheap procedural variety from id hash feel via tags
  const t = tags.building;
  if (t === 'house' || t === 'detached' || t === 'semidetached_house') return 6 + Math.random() * 4;
  if (t === 'apartments' || t === 'residential') return 12 + Math.random() * 18;
  if (t === 'commercial' || t === 'retail' || t === 'office') return 10 + Math.random() * 25;
  if (t === 'industrial' || t === 'warehouse') return 8 + Math.random() * 10;
  if (t === 'skyscraper') return 60 + Math.random() * 40;
  return 8 + Math.random() * 14;
}

export class BuildingBuilder {
  private materials: THREE.MeshStandardMaterial[];

  constructor() {
    this.materials = BUILDING_COLORS.map(
      (c) =>
        new THREE.MeshStandardMaterial({
          color: c,
          roughness: 0.88,
          metalness: 0.08,
        }),
    );
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
      const shape = new THREE.Shape();
      let first = true;
      let cx = 0;
      let cz = 0;
      let n = 0;
      const local: Array<{ x: number; z: number }> = [];
      for (const node of b.geometry) {
        const p = origin.toLocal(node.lat, node.lon);
        local.push(p);
        cx += p.x;
        cz += p.z;
        n++;
      }
      // Skip tiny footprints
      if (n < 3) continue;
      cx /= n;
      cz /= n;

      // Area estimate
      let area = 0;
      for (let k = 0; k < local.length - 1; k++) {
        area += local[k].x * local[k + 1].z - local[k + 1].x * local[k].z;
      }
      area = Math.abs(area) * 0.5;
      if (area < 25 || area > 25000) continue;

      for (const p of local) {
        const x = p.x - cx;
        const y = p.z - cz;
        if (first) {
          shape.moveTo(x, y);
          first = false;
        } else {
          shape.lineTo(x, y);
        }
      }
      shape.closePath();

      const height = buildingHeight(b.tags);
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

      const mat = this.materials[i % this.materials.length];
      i++;
      const mesh = new THREE.Mesh(geo, mat);
      const baseY = heightAt && b.geometry[0]
        ? heightAt(b.geometry[0].lat, b.geometry[0].lon)
        : 0;
      mesh.position.set(cx, baseY, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    return group;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
  }
}
