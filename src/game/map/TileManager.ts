import * as THREE from 'three';
import { OverpassClient } from './OverpassClient';
import { RoadBuilder, ROAD_Y_BIAS, type RoadCenterline } from './RoadBuilder';
import { BuildingBuilder } from './BuildingBuilder';
import { ElevationSampler } from './ElevationSampler';
import {
  defaultAsphaltProfile,
  effectiveGrip,
  type SurfaceProfile,
} from './RoadSurface';
import {
  GeoOrigin,
  latLonToTile,
  tileBounds,
  tileKey,
} from './geo';
import type { OsmWay } from './OverpassClient';
import type { WeatherPreset } from '../weather/Environment';
import { makeTerrainTexture } from '../visuals/Textures';

const LOAD_RADIUS = 2;
const UNLOAD_RADIUS = 4;
const ROAD_HEIGHT_RADIUS = 14;
const TERRAIN_SIZE = 900;
const TERRAIN_RES = 96;
const TERRAIN_RECENTER_M = 120;
const TERRAIN_Y_BIAS = -0.62;
const SPAWN_DEADLINE_MS = 14_000;
/** Cap queued + loading tiles to avoid memory / Overpass storms. */
const MAX_PENDING_TILES = 12;
/** Max tiles kept loaded (Chebyshev neighborhood soft cap). */
const MAX_LOADED_TILES = 36;

export type TileStatusListener = (info: {
  loading: number;
  loaded: number;
  message: string;
}) => void;

export interface SurfaceSample {
  roadFactor: number;
  height: number;
  grip: number;
  noise: number;
  label: string;
  kind: string;
}

interface TileEntry {
  key: string;
  tx: number;
  ty: number;
  group: THREE.Group;
  loading: boolean;
  centerlines: RoadCenterline[];
  wayIds: number[];
  buildingIds: number[];
  usedFallback: boolean;
  cancelled: boolean;
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
  private terrainMat: THREE.MeshStandardMaterial;
  private onStatus?: TileStatusListener;
  private seenWayIds = new Set<number>();
  private seenBuildingIds = new Set<number>();
  private fallbackBuilt = false;
  private centerlines: RoadCenterline[] = [];
  private terrainMesh: THREE.Mesh | null = null;
  private terrainCenterX = 0;
  private terrainCenterZ = 0;
  private terrainRefreshQueued = false;
  private usedOfflineFallback = false;
  private weather: WeatherPreset = 'clear';
  private disposed = false;
  private fetchGen = 0;

  constructor(scene: THREE.Scene, originLat: number, originLon: number) {
    this.scene = scene;
    this.origin = new GeoOrigin(originLat, originLon);

    const terrainTex = makeTerrainTexture();
    this.groundMat = new THREE.MeshStandardMaterial({
      color: 0x4a6238,
      map: terrainTex,
      roughness: 0.95,
      metalness: 0,
    });
    this.terrainMat = new THREE.MeshStandardMaterial({
      color: 0x5a6e44,
      map: terrainTex,
      roughness: 0.95,
      metalness: 0,
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    const groundGeo = new THREE.PlaneGeometry(3600, 3600);
    this.ground = new THREE.Mesh(groundGeo, this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -6;
    this.ground.receiveShadow = true;
    this.ground.name = 'ground-fallback';
    scene.add(this.ground);
  }

  setStatusListener(listener: TileStatusListener): void {
    this.onStatus = listener;
  }

  setWeatherSurface(weather: WeatherPreset): void {
    this.weather = weather;
    this.builder.setWeatherSurface(weather);
    const groundHex =
      weather === 'snow' ? 0xd8e0e6 : weather === 'rain' ? 0x2f4a32 : 0x3d5a3d;
    this.groundMat.color.setHex(groundHex);
    this.terrainMat.color.setHex(groundHex);
  }

  /**
   * Load spawn tile first (timeout + offline fallback), show world ASAP,
   * then stream the 5×5 ring in the background with the same policy.
   */
  async warmStart(): Promise<void> {
    const t0 = Date.now();
    this.emitStatus('Loading Terrarium elevation…');
    await this.elevation.ensureOrigin(this.origin.lat, this.origin.lon);
    if (this.disposed) return;

    const { tx, ty } = latLonToTile(this.origin.lat, this.origin.lon);
    this.emitStatus(`Loading spawn tile ${tileKey(tx, ty)}…`);
    await this.loadTile(tx, ty);
    if (this.disposed) return;

    if (!this.hasAnyRoads()) {
      this.buildFallbackGrid();
      this.usedOfflineFallback = true;
      this.emitStatus('Using offline roads (Overpass slow)');
    } else if (this.usedOfflineFallback) {
      this.emitStatus('Using offline roads (Overpass slow)');
    }

    await Promise.race([
      this.refreshTerrainMesh(0, 0),
      new Promise<void>((r) => setTimeout(r, 4_000)),
    ]);
    if (this.disposed) return;

    const remaining = Math.max(0, SPAWN_DEADLINE_MS - (Date.now() - t0));
    if (remaining > 0 && !this.hasAnyRoads()) {
      await new Promise((r) => setTimeout(r, Math.min(500, remaining)));
    }

    if (this.usedOfflineFallback) {
      this.emitStatus('Using offline roads (Overpass slow) — world ready');
    } else {
      this.emitStatus(
        `OSM + Terrarium DEM · spawn ready · ${this.centerlines.length} roads`,
      );
    }

    for (let dy = -LOAD_RADIUS; dy <= LOAD_RADIUS; dy++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        if (dx === 0 && dy === 0) continue;
        this.enqueue(tx + dx, ty + dy);
      }
    }
    void this.pumpQueue();
  }

  update(playerX: number, playerZ: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(playerX) || !Number.isFinite(playerZ)) return;

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
        this.unloadTile(key, entry);
      }
    }

    // Soft cap: unload farthest non-loading tiles if over budget
    if (this.tiles.size > MAX_LOADED_TILES) {
      const ranked = [...this.tiles.values()]
        .filter((e) => !e.loading && e.key !== 'fallback')
        .map((e) => ({
          e,
          dist: Math.max(Math.abs(e.tx - tx), Math.abs(e.ty - ty)),
        }))
        .sort((a, b) => b.dist - a.dist);
      while (this.tiles.size > MAX_LOADED_TILES && ranked.length) {
        const far = ranked.shift()!;
        this.unloadTile(far.e.key, far.e);
      }
    }

    void this.pumpQueue();
    this.ground.position.x = playerX;
    this.ground.position.z = playerZ;

    const dx = playerX - this.terrainCenterX;
    const dz = playerZ - this.terrainCenterZ;
    if (dx * dx + dz * dz > TERRAIN_RECENTER_M * TERRAIN_RECENTER_M) {
      this.queueTerrainRefresh(playerX, playerZ);
    }
  }

  private unloadTile(key: string, entry: TileEntry): void {
    entry.cancelled = true;
    this.scene.remove(entry.group);
    entry.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        // Shared materials owned by RoadBuilder / BuildingBuilder — do not dispose here
      }
    });
    entry.group.clear();

    for (const id of entry.wayIds) this.seenWayIds.delete(id);
    for (const id of entry.buildingIds) this.seenBuildingIds.delete(id);

    this.tiles.delete(key);
    this.rebuildCenterlineIndex();
  }

  getHeight(x: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const ll = this.origin.toLatLon(x, z);
    const y = this.elevation.sampleRelative(ll.lat, ll.lon);
    return Number.isFinite(y) ? y : 0;
  }

  sampleSurface(x: number, z: number): SurfaceSample {
    const demY = this.getHeight(x, z);
    const offRoad: SurfaceSample = {
      roadFactor: 0.35,
      height: demY,
      grip: effectiveGrip(defaultAsphaltProfile(), 0.35, this.weather) * 0.85,
      noise: 0.2,
      label: 'Off-road',
      kind: 'dirt',
    };

    if (!Number.isFinite(x) || !Number.isFinite(z)) return offRoad;

    let bestD = Infinity;
    let bestY = demY;
    let bestProfile: SurfaceProfile = defaultAsphaltProfile();

    for (const line of this.centerlines) {
      const pts = line.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const d = distPointSegSq(x, z, a.x, a.z, b.x, b.z);
        if (d < bestD) {
          bestD = d;
          const t = projectT(x, z, a.x, a.z, b.x, b.z);
          const y = a.y + (b.y - a.y) * t;
          bestY = Number.isFinite(y) ? y : demY;
          bestProfile = line.surface;
        }
      }
    }

    const dist = Number.isFinite(bestD) ? Math.sqrt(bestD) : Infinity;
    const roadFactor =
      dist < 5
        ? 1
        : dist < 12
          ? THREE.MathUtils.clamp(1 - (dist - 5) / 7, 0.35, 1)
          : 0.35;

    let height: number;
    if (dist <= ROAD_HEIGHT_RADIUS) {
      const w = THREE.MathUtils.clamp(1 - dist / ROAD_HEIGHT_RADIUS, 0, 1);
      height = bestY * w + (demY + ROAD_Y_BIAS * 0.25) * (1 - w);
    } else {
      height = demY;
    }
    if (!Number.isFinite(height)) height = 0;

    const grip = effectiveGrip(bestProfile, roadFactor, this.weather);
    return {
      roadFactor,
      height,
      grip,
      noise: bestProfile.noise * (roadFactor > 0.5 ? 1 : 1.4),
      label: roadFactor > 0.5 ? bestProfile.label : 'Off-road',
      kind: roadFactor > 0.5 ? bestProfile.kind : 'dirt',
    };
  }

  findNearestRoadPoint(x: number, z: number): { x: number; z: number; y: number } | null {
    let best: { x: number; z: number; y: number; d: number } | null = null;
    for (const line of this.centerlines) {
      for (const p of line.points) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.y)) continue;
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
    const pending = this.queue.length + [...this.tiles.values()].filter((t) => t.loading).length;
    if (pending >= MAX_PENDING_TILES) {
      // Drop farthest queued (keep nearer to end of queue which are more recent)
      if (this.queue.length > 0) this.queue.shift();
      else return;
    }
    this.queue.push({ tx, ty });
  }

  private async pumpQueue(): Promise<void> {
    if (this.processing || this.disposed) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const batch: Array<{ tx: number; ty: number }> = [];
        while (batch.length < 2 && this.queue.length > 0) {
          batch.push(this.queue.shift()!);
        }
        await Promise.all(batch.map((t) => this.loadTile(t.tx, t.ty)));
      }
    } finally {
      this.processing = false;
    }
  }

  private async loadTile(tx: number, ty: number): Promise<void> {
    if (this.disposed) return;
    const key = tileKey(tx, ty);
    if (this.tiles.has(key)) return;

    const entry: TileEntry = {
      key,
      tx,
      ty,
      group: new THREE.Group(),
      loading: true,
      centerlines: [],
      wayIds: [],
      buildingIds: [],
      usedFallback: false,
      cancelled: false,
    };
    this.tiles.set(key, entry);
    this.emitStatus(`Streaming OSM + DEM tile ${key}…`);

    const b = tileBounds(tx, ty);
    const heightAt = (lat: number, lon: number) => {
      const y = this.elevation.sampleRelative(lat, lon);
      return Number.isFinite(y) ? y : 0;
    };

    const gen = this.fetchGen;

    await Promise.race([
      this.elevation.preloadArea(b.south, b.west, b.north, b.east),
      new Promise<void>((r) => setTimeout(r, 8_500)),
    ]);
    if (this.disposed || entry.cancelled || gen !== this.fetchGen) {
      this.finishLoading(key);
      return;
    }

    try {
      const result = await this.client.fetchTile(
        key,
        b.south,
        b.west,
        b.north,
        b.east,
        gen,
      );
      if (this.disposed || entry.cancelled || gen !== this.fetchGen) {
        this.finishLoading(key);
        return;
      }

      const freshWays = result.ways.filter((w) => {
        if (this.seenWayIds.has(w.id)) return false;
        this.seenWayIds.add(w.id);
        entry.wayIds.push(w.id);
        return true;
      });
      const freshBuildings = result.buildings.filter((w) => {
        if (this.seenBuildingIds.has(w.id)) return false;
        this.seenBuildingIds.add(w.id);
        entry.buildingIds.push(w.id);
        return true;
      });

      if (freshWays.length === 0) {
        this.applyTileFallback(entry, heightAt);
        this.emitStatus(`Using offline roads (Overpass slow) · tile ${key}`);
      } else {
        const { group: roads, centerlines } = await this.builder.buildWaysAsync(
          freshWays,
          this.origin,
          heightAt,
        );
        if (this.disposed || entry.cancelled) {
          roads.traverse((obj) => {
            if (obj instanceof THREE.Mesh) obj.geometry.dispose();
          });
          this.finishLoading(key);
          return;
        }
        entry.centerlines = centerlines;
        this.rebuildCenterlineIndex();
        entry.group.add(roads);

        const bldg = this.buildings.build(freshBuildings, this.origin, heightAt);
        entry.group.add(bldg);

        this.scene.add(entry.group);
        this.emitStatus(
          `Tile ${key}: ${freshWays.length} roads, ${freshBuildings.length} buildings`,
        );
      }
    } catch (err) {
      if (this.disposed || entry.cancelled) {
        this.finishLoading(key);
        return;
      }
      console.warn('Tile load failed — offline fallback', key, err);
      this.applyTileFallback(entry, heightAt);
      this.emitStatus(`Using offline roads (Overpass slow) · tile ${key}`);
    } finally {
      this.finishLoading(key);
    }
  }

  private finishLoading(key: string): void {
    const current = this.tiles.get(key);
    if (current) current.loading = false;
  }

  private applyTileFallback(
    entry: TileEntry,
    heightAt: (lat: number, lon: number) => number,
  ): void {
    if (entry.cancelled || this.disposed) return;
    this.usedOfflineFallback = true;
    entry.usedFallback = true;
    const ways = this.makeGridWaysForTile(entry.tx, entry.ty);
    const { group, centerlines } = this.builder.buildWays(ways, this.origin, heightAt);
    entry.centerlines = centerlines;
    entry.group.add(group);
    this.scene.add(entry.group);
    this.rebuildCenterlineIndex();
  }

  private makeGridWaysForTile(tx: number, ty: number): OsmWay[] {
    const b = tileBounds(tx, ty);
    const ways: OsmWay[] = [];
    let id = 900000 + tx * 10000 + ty * 20;
    // Short city-block segments (~80 m) — never one mega-span across the tile.
    const blocks = 5;
    const lats: number[] = [];
    const lons: number[] = [];
    for (let i = 0; i <= blocks; i++) {
      const u = i / blocks;
      lats.push(b.south + (b.north - b.south) * u);
      lons.push(b.west + (b.east - b.west) * u);
    }
    for (let i = 0; i <= blocks; i++) {
      const highway = i % 3 === 0 ? 'secondary' : 'residential';
      for (let j = 0; j < blocks; j++) {
        ways.push({
          id: id++,
          tags: { highway, surface: 'asphalt' },
          geometry: [
            { lat: lats[i], lon: lons[j] },
            { lat: lats[i], lon: lons[j + 1] },
          ],
        });
        ways.push({
          id: id++,
          tags: { highway: i % 2 === 0 ? 'residential' : 'tertiary', surface: 'asphalt' },
          geometry: [
            { lat: lats[j], lon: lons[i] },
            { lat: lats[j + 1], lon: lons[i] },
          ],
        });
      }
    }
    return ways;
  }

  private queueTerrainRefresh(x: number, z: number): void {
    if (this.terrainRefreshQueued || this.disposed) return;
    this.terrainRefreshQueued = true;
    void this.refreshTerrainMesh(x, z).finally(() => {
      this.terrainRefreshQueued = false;
    });
  }

  private async refreshTerrainMesh(centerX: number, centerZ: number): Promise<void> {
    if (this.disposed) return;
    const res = TERRAIN_RES;
    const size = TERRAIN_SIZE;
    const geo = new THREE.PlaneGeometry(size, size, res, res);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;

    const half = size * 0.5;
    const sw = this.origin.toLatLon(centerX - half, centerZ - half);
    const ne = this.origin.toLatLon(centerX + half, centerZ + half);
    await Promise.race([
      this.elevation.preloadArea(
        Math.min(sw.lat, ne.lat),
        Math.min(sw.lon, ne.lon),
        Math.max(sw.lat, ne.lat),
        Math.max(sw.lon, ne.lon),
      ),
      new Promise<void>((r) => setTimeout(r, 8_500)),
    ]);
    if (this.disposed) {
      geo.dispose();
      return;
    }

    // Chunk vertex updates to reduce main-thread stalls
    const count = pos.count;
    const CHUNK = 1024;
    for (let start = 0; start < count; start += CHUNK) {
      const end = Math.min(count, start + CHUNK);
      for (let i = start; i < end; i++) {
        const lx = pos.getX(i) + centerX;
        const lz = pos.getZ(i) + centerZ;
        const ll = this.origin.toLatLon(lx, lz);
        let y = this.elevation.sampleRelative(ll.lat, ll.lon);
        if (!Number.isFinite(y)) y = 0;
        pos.setY(i, y + TERRAIN_Y_BIAS);
      }
      pos.needsUpdate = true;
      if (end < count) {
        await new Promise<void>((r) => setTimeout(r, 0));
        if (this.disposed) {
          geo.dispose();
          return;
        }
      }
    }
    geo.computeVertexNormals();
    const colors = new Float32Array(pos.count * 3);
    const col = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i) + centerX;
      const lz = pos.getZ(i) + centerZ;
      const y = pos.getY(i);
      const n =
        Math.sin(lx * 0.021 + lz * 0.017) * 0.5 +
        Math.sin(lx * 0.007 - lz * 0.011) * 0.5;
      const t = 0.45 + n * 0.22 + Math.max(-0.1, Math.min(0.2, y * 0.012));
      col.setRGB(0.28 + t * 0.18, 0.36 + t * 0.16, 0.18 + t * 0.08);
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
    }
    this.terrainMesh = new THREE.Mesh(geo, this.terrainMat);
    this.terrainMesh.position.set(centerX, 0, centerZ);
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.name = 'terrain';
    this.scene.add(this.terrainMesh);
    this.terrainCenterX = centerX;
    this.terrainCenterZ = centerZ;
    this.ground.visible = false;
  }

  private hasAnyRoads(): boolean {
    return this.centerlines.length > 0;
  }

  private buildFallbackGrid(): void {
    if (this.fallbackBuilt || this.disposed) return;
    this.fallbackBuilt = true;
    this.usedOfflineFallback = true;
    const { tx, ty } = latLonToTile(this.origin.lat, this.origin.lon);
    const ways: OsmWay[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        ways.push(...this.makeGridWaysForTile(tx + dx, ty + dy));
      }
    }
    const heightAt = (lat: number, lon: number) => {
      const y = this.elevation.sampleRelative(lat, lon);
      return Number.isFinite(y) ? y : 0;
    };
    const { group, centerlines } = this.builder.buildWays(ways, this.origin, heightAt);
    this.scene.add(group);
    this.tiles.set('fallback', {
      key: 'fallback',
      tx: 0,
      ty: 0,
      group,
      loading: false,
      centerlines,
      wayIds: [],
      buildingIds: [],
      usedFallback: true,
      cancelled: false,
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

  setNightGlow(night: number): void {
    this.buildings.setNightGlow(night);
  }

  dispose(): void {
    this.disposed = true;
    this.fetchGen++;
    this.client.cancelAll();
    this.queue.length = 0;
    for (const [key, entry] of [...this.tiles.entries()]) {
      entry.cancelled = true;
      this.unloadTile(key, entry);
    }
    if (this.terrainMesh) {
      this.scene.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
      this.terrainMesh = null;
    }
    this.scene.remove(this.ground);
    this.ground.geometry.dispose();
    this.groundMat.dispose();
    this.terrainMat.dispose();
    this.builder.dispose();
    this.buildings.dispose();
    this.elevation.dispose();
    this.seenWayIds.clear();
    this.seenBuildingIds.clear();
    this.centerlines = [];
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
