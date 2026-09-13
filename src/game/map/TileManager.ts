import * as THREE from 'three';
import { OverpassClient } from './OverpassClient';
import { RoadBuilder } from './RoadBuilder';
import { BuildingBuilder } from './BuildingBuilder';
import { ElevationSampler } from './ElevationSampler';
import {
  GeoOrigin,
  latLonToTile,
  tileBounds,
  tileKey,
} from './geo';
import type { WeatherPreset } from '../weather/Environment';

const LOAD_RADIUS = 2; // 5x5 for denser immersion
const UNLOAD_RADIUS = 4;

export type TileStatusListener = (info: {
  loading: number;
  loaded: number;
  message: string;
}) => void;

interface TileEntry {
  key: string;
  tx: number;
  ty: number;
  group: THREE.Group;
  loading: boolean;
  centerlines: Array<{ x: number; y: number; z: number }[]>;
}

export class TileManager {
  readonly origin: GeoOrigin;
  readonly elevation = new ElevationSampler();
  private scene: THREE.Scene;
  private client = new OverpassClient();
  private builder = new RoadBuilder();
  private buildings = new BuildingBuilder();
  private tiles = new Map<string, TileEntry>();
  private queue: Array<{ tx: number; ty: number }> = [];
  private processing = false;
  private ground: THREE.Mesh;
  private groundMat: THREE.MeshStandardMaterial;
  private onStatus?: TileStatusListener;
  private seenWayIds = new Set<number>();
  private seenBuildingIds = new Set<number>();
  private fallbackBuilt = false;
  private centerlines: Array<{ x: number; y: number; z: number }[]> = [];
  private terrainMesh: THREE.Mesh | null = null;

  constructor(scene: THREE.Scene, originLat: number, originLon: number) {
    this.scene = scene;
    this.origin = new GeoOrigin(originLat, originLon);

    this.groundMat = new THREE.MeshStandardMaterial({
      color: 0x3d5a3d,
      roughness: 1,
      metalness: 0,
    });
    const groundGeo = new THREE.PlaneGeometry(20000, 20000);
    this.ground = new THREE.Mesh(groundGeo, this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.5;
    this.ground.receiveShadow = true;
    scene.add(this.ground);
  }

  setStatusListener(listener: TileStatusListener): void {
    this.onStatus = listener;
  }

  setWeatherSurface(weather: WeatherPreset): void {
    this.builder.setWeatherSurface(weather);
    if (weather === 'snow') {
      this.groundMat.color.setHex(0xd8e0e6);
    } else if (weather === 'rain') {
      this.groundMat.color.setHex(0x2f4a32);
    } else {
      this.groundMat.color.setHex(0x3d5a3d);
    }
  }

  async warmStart(): Promise<void> {
    this.emitStatus('Loading Terrarium elevation (AWS Open Data)…');
    await this.elevation.ensureOrigin(this.origin.lat, this.origin.lon);

    const { tx, ty } = latLonToTile(this.origin.lat, this.origin.lon);
    const order: Array<{ tx: number; ty: number }> = [{ tx, ty }];
    for (let dy = -LOAD_RADIUS; dy <= LOAD_RADIUS; dy++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        if (dx === 0 && dy === 0) continue;
        // ring priority: closer first
        order.push({ tx: tx + dx, ty: ty + dy });
      }
    }
    order.sort(
      (a, b) =>
        Math.max(Math.abs(a.tx - tx), Math.abs(a.ty - ty)) -
        Math.max(Math.abs(b.tx - tx), Math.abs(b.ty - ty)),
    );
    for (const t of order) this.enqueue(t.tx, t.ty);

    const centerKey = tileKey(tx, ty);
    const start = Date.now();
    while (Date.now() - start < 60000) {
      await this.pumpQueue();
      const entry = this.tiles.get(centerKey);
      if (entry && !entry.loading) break;
      await new Promise((r) => setTimeout(r, 40));
    }

    await this.refreshTerrainMesh();

    if (!this.hasAnyRoads()) {
      this.buildFallbackGrid();
      this.emitStatus('Using local fallback roads (Overpass unavailable)');
    } else {
      this.emitStatus(
        `OSM + Terrarium DEM · ${this.tiles.size} tiles · ${this.centerlines.length} roads`,
      );
    }
  }

  update(playerX: number, playerZ: number): void {
    const ll = this.origin.toLatLon(playerX, playerZ);
    const { tx, ty } = latLonToTile(ll.lat, ll.lon);

    for (let dy = -LOAD_RADIUS; dy <= LOAD_RADIUS; dy++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        this.enqueue(tx + dx, ty + dy);
      }
    }

    for (const [key, entry] of [...this.tiles.entries()]) {
      const dist = Math.max(Math.abs(entry.tx - tx), Math.abs(entry.ty - ty));
      if (dist > UNLOAD_RADIUS && !entry.loading) {
        this.scene.remove(entry.group);
        entry.group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) obj.geometry.dispose();
        });
        this.tiles.delete(key);
        this.rebuildCenterlineIndex();
      }
    }

    void this.pumpQueue();
    this.ground.position.x = playerX;
    this.ground.position.z = playerZ;
  }

  /** Height under a local XZ point (relative to spawn). */
  getHeight(x: number, z: number): number {
    const ll = this.origin.toLatLon(x, z);
    return this.elevation.sampleRelative(ll.lat, ll.lon);
  }

  /**
   * Road factor + nearest centerline height.
   * 1 = on asphalt, ~0.35 = grass/off-road.
   */
  sampleSurface(x: number, z: number): { roadFactor: number; height: number } {
    let bestD = Infinity;
    let bestY = this.getHeight(x, z);
    for (const line of this.centerlines) {
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        const d = distPointSegSq(x, z, a.x, a.z, b.x, b.z);
        if (d < bestD) {
          bestD = d;
          const t = projectT(x, z, a.x, a.z, b.x, b.z);
          bestY = a.y + (b.y - a.y) * t;
        }
      }
    }
    const dist = Math.sqrt(bestD);
    const roadFactor = dist < 5 ? 1 : dist < 12 ? THREE.MathUtils.clamp(1 - (dist - 5) / 7, 0.35, 1) : 0.35;
    return { roadFactor, height: bestY };
  }

  findNearestRoadPoint(x: number, z: number): { x: number; z: number; y: number } | null {
    let best: { x: number; z: number; y: number; d: number } | null = null;
    for (const line of this.centerlines) {
      for (const p of line) {
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (!best || d < best.d) best = { x: p.x, z: p.z, y: p.y, d };
      }
    }
    return best ? { x: best.x, z: best.z, y: best.y } : null;
  }

  private enqueue(tx: number, ty: number): void {
    const key = tileKey(tx, ty);
    if (this.tiles.has(key)) return;
    if (this.queue.some((q) => q.tx === tx && q.ty === ty)) return;
    this.queue.push({ tx, ty });
  }

  private async pumpQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        await this.loadTile(next.tx, next.ty);
      }
    } finally {
      this.processing = false;
    }
  }

  private async loadTile(tx: number, ty: number): Promise<void> {
    const key = tileKey(tx, ty);
    if (this.tiles.has(key)) return;

    const entry: TileEntry = {
      key,
      tx,
      ty,
      group: new THREE.Group(),
      loading: true,
      centerlines: [],
    };
    this.tiles.set(key, entry);
    this.emitStatus(`Streaming OSM + DEM tile ${key}…`);

    const b = tileBounds(tx, ty);
    try {
      await this.elevation.preloadArea(b.south, b.west, b.north, b.east);
      const heightAt = (lat: number, lon: number) => this.elevation.sampleRelative(lat, lon);

      const result = await this.client.fetchTile(key, b.south, b.west, b.north, b.east);
      const freshWays = result.ways.filter((w) => {
        if (this.seenWayIds.has(w.id)) return false;
        this.seenWayIds.add(w.id);
        return true;
      });
      const freshBuildings = result.buildings.filter((w) => {
        if (this.seenBuildingIds.has(w.id)) return false;
        this.seenBuildingIds.add(w.id);
        return true;
      });

      const { group: roads, centerlines } = this.builder.buildWays(freshWays, this.origin, heightAt);
      entry.centerlines = centerlines;
      this.rebuildCenterlineIndex();
      entry.group.add(roads);

      const bldg = this.buildings.build(freshBuildings, this.origin, heightAt);
      entry.group.add(bldg);

      this.scene.add(entry.group);
      this.emitStatus(
        `Tile ${key}: ${freshWays.length} roads, ${freshBuildings.length} buildings`,
      );
    } catch (err) {
      console.warn('Tile load failed', key, err);
      this.emitStatus(`Tile ${key} failed`);
      this.tiles.delete(key);
    } finally {
      const current = this.tiles.get(key);
      if (current) current.loading = false;
    }
  }

  private async refreshTerrainMesh(): Promise<void> {
    // Lightweight heightfield around origin for visible grades
    const res = 48;
    const size = 600;
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const ll = this.origin.toLatLon(x, z);
      const y = this.elevation.sampleRelative(ll.lat, ll.lon);
      pos.setY(i, y - 0.35);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }
    this.terrainMesh = new THREE.Mesh(geo, this.groundMat);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.name = 'terrain';
    this.scene.add(this.terrainMesh);
    this.ground.visible = false;
  }

  private hasAnyRoads(): boolean {
    return this.centerlines.length > 0;
  }

  private buildFallbackGrid(): void {
    if (this.fallbackBuilt) return;
    this.fallbackBuilt = true;
    const ways = [];
    const blocks = 8;
    const spacing = 80;
    const half = (blocks * spacing) / 2;
    let id = 1;
    for (let i = 0; i <= blocks; i++) {
      const o = -half + i * spacing;
      ways.push({
        id: id++,
        tags: { highway: i % 3 === 0 ? 'primary' : 'residential' },
        geometry: [
          {
            lat: this.origin.lat + -half / this.origin.mPerDegLat,
            lon: this.origin.lon + o / this.origin.mPerDegLon,
          },
          {
            lat: this.origin.lat + half / this.origin.mPerDegLat,
            lon: this.origin.lon + o / this.origin.mPerDegLon,
          },
        ],
      });
      ways.push({
        id: id++,
        tags: { highway: i % 3 === 0 ? 'secondary' : 'residential' },
        geometry: [
          {
            lat: this.origin.lat + o / this.origin.mPerDegLat,
            lon: this.origin.lon + -half / this.origin.mPerDegLon,
          },
          {
            lat: this.origin.lat + o / this.origin.mPerDegLat,
            lon: this.origin.lon + half / this.origin.mPerDegLon,
          },
        ],
      });
    }
    const heightAt = (lat: number, lon: number) => this.elevation.sampleRelative(lat, lon);
    const { group, centerlines } = this.builder.buildWays(ways, this.origin, heightAt);
    this.scene.add(group);
    this.tiles.set('fallback', {
      key: 'fallback',
      tx: 0,
      ty: 0,
      group,
      loading: false,
      centerlines,
    });
    this.rebuildCenterlineIndex();
  }


  private rebuildCenterlineIndex(): void {
    this.centerlines = [];
    for (const tile of this.tiles.values()) {
      this.centerlines.push(...tile.centerlines);
    }
  }

  private emitStatus(message: string): void {
    let loading = 0;
    let loaded = 0;
    for (const t of this.tiles.values()) {
      if (t.loading) loading++;
      else loaded++;
    }
    this.onStatus?.({ loading, loaded, message });
  }

  dispose(): void {
    this.builder.dispose();
    this.buildings.dispose();
  }
}

function projectT(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const abx = bx - ax;
  const abz = bz - az;
  const len = abx * abx + abz * abz;
  if (len < 1e-8) return 0;
  return Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / len));
}

function distPointSegSq(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const t = projectT(px, pz, ax, az, bx, bz);
  const qx = ax + (bx - ax) * t;
  const qz = az + (bz - az) * t;
  return (px - qx) ** 2 + (pz - qz) ** 2;
}
