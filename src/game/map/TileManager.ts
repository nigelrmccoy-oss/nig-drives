import * as THREE from 'three';
import { OverpassClient } from './OverpassClient';
import { RoadBuilder, ROAD_Y_BIAS, type RoadCenterline } from './RoadBuilder';
import { BuildingBuilder } from './BuildingBuilder';
import { StreetLabels } from './StreetLabels';
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
/** How long a tile build waits for its DEM before building with provisional heights. */
const DEM_WAIT_MS = 15_000;
/** How often (s) to look for provisional tiles whose DEM has since arrived. */
const REHEIGHT_CHECK_S = 0.75;
/** Coarse DEM zoom used as a stand-in while fine tiles stream (never "last known"). */
const COARSE_DEM_ZOOM = 11;
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
  /** Source data kept so the tile can be re-heighted when late DEM tiles land. */
  ways: OsmWay[];
  buildings: OsmWay[];
  /** Built with at least one height that wasn't from the fine DEM. */
  provisional: boolean;
  rebuilding: boolean;
  /** Fill-building budget used for this tile (re-used on rebuild). */
  fillCount: number;
  fillSeed: number;
  /** Re-height attempts so a tile can never rebuild in a loop. */
  reheights: number;
}

const MAX_REHEIGHTS = 3;

/** Lat/lon extent of the source geometry (OSM ways run past the tile bbox). */
function dataBounds(
  ways: OsmWay[],
  fallback: { south: number; west: number; north: number; east: number },
): { south: number; west: number; north: number; east: number } {
  let south = fallback.south;
  let west = fallback.west;
  let north = fallback.north;
  let east = fallback.east;
  for (const w of ways) {
    for (const g of w.geometry) {
      if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
      if (g.lat < south) south = g.lat;
      if (g.lat > north) north = g.lat;
      if (g.lon < west) west = g.lon;
      if (g.lon > east) east = g.lon;
    }
  }
  const pad = 0.0004;
  return { south: south - pad, west: west - pad, north: north + pad, east: east + pad };
}

export class TileManager {
  readonly origin: GeoOrigin;
  readonly elevation = new ElevationSampler(12, 64);
  /** Low-zoom DEM: provisional heights while fine tiles stream. */
  readonly coarseElevation = new ElevationSampler(COARSE_DEM_ZOOM, 16);
  /** Count of heights served from a non-fine source since last reset. */
  private provisionalSamples = 0;
  private demDirty = false;
  private reheightAcc = 0;
  private reheightBusy = false;
  private terrainProvisional = false;
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
  /** When true, skip Overpass and always use offline road grids (QA: ?fallback=1). */
  private forceOffline = false;
  private weather: WeatherPreset = 'clear';
  private disposed = false;
  private fetchGen = 0;
  readonly streetLabels = new StreetLabels();

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
    scene.add(this.streetLabels.group);
    this.elevation.onTileLoaded(() => {
      this.demDirty = true;
    });
  }

  /**
   * Best available relative height: fine DEM → coarse DEM → spawn level.
   * Anything not from the fine DEM bumps provisionalSamples so the caller can
   * flag its tile for re-heighting (v1.3.2: no more last-sampled plateaus).
   */
  private demHeight(lat: number, lon: number): number {
    const fine = this.elevation.sampleRelative(lat, lon);
    if (fine !== null) return fine;
    this.provisionalSamples++;
    const coarse = this.coarseElevation.sampleRelative(lat, lon);
    if (coarse !== null) return coarse;
    return 0;
  }

  getCenterlines(): RoadCenterline[] {
    return this.centerlines;
  }

  setStatusListener(listener: TileStatusListener): void {
    this.onStatus = listener;
  }

  /** Force offline road grids (no Overpass). Useful for QA via ?fallback=1. */
  setForceOffline(force: boolean): void {
    this.forceOffline = force;
  }

  isForcedOffline(): boolean {
    return this.forceOffline;
  }

  usedFallbackRoads(): boolean {
    return this.usedOfflineFallback;
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
    this.coarseElevation.setOriginElevation(this.elevation.getOriginElevation());
    void this.coarseElevation.preloadArea(
      this.origin.lat - 0.06,
      this.origin.lon - 0.08,
      this.origin.lat + 0.06,
      this.origin.lon + 0.08,
    );

    const { tx, ty } = latLonToTile(this.origin.lat, this.origin.lon);
    this.emitStatus(
      this.forceOffline
        ? `Forced offline roads (?fallback=1) · tile ${tileKey(tx, ty)}…`
        : `Loading spawn tile ${tileKey(tx, ty)}…`,
    );
    await this.loadTile(tx, ty);
    if (this.disposed) return;

    if (!this.hasAnyRoads()) {
      this.buildFallbackGrid();
      this.usedOfflineFallback = true;
      this.emitStatus(
        this.forceOffline
          ? 'Forced offline roads (?fallback=1)'
          : 'Using offline roads (Overpass slow)',
      );
    } else if (this.usedOfflineFallback) {
      this.emitStatus(
        this.forceOffline
          ? 'Forced offline roads (?fallback=1)'
          : 'Using offline roads (Overpass slow)',
      );
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

    if (this.forceOffline) {
      this.emitStatus(
        `Forced offline roads (?fallback=1) — world ready · ${this.centerlines.length} roads`,
      );
    } else if (this.usedOfflineFallback) {
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
    this.checkLateDem();
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
    const before = this.provisionalSamples;
    const y = this.demHeight(ll.lat, ll.lon);
    this.provisionalSamples = before;
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
    let bestHalf = 3.2;

    for (const line of this.centerlines) {
      const pts = line.points;
      const half = Math.max(1.5, (line.width ?? 6.4) * 0.5);
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
          bestHalf = half;
        }
      }
    }

    const dist = Number.isFinite(bestD) ? Math.sqrt(bestD) : Infinity;
    const onRoad = bestHalf + 0.4;
    const soft = bestHalf + 3.5;
    const roadFactor =
      dist < onRoad
        ? 1
        : dist < soft
          ? THREE.MathUtils.clamp(1 - (dist - onRoad) / (soft - onRoad), 0.35, 1)
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
      ways: [],
      buildings: [],
      provisional: false,
      rebuilding: false,
      fillCount: 0,
      fillSeed: tx * 997 + ty * 131,
      reheights: 0,
    };
    this.tiles.set(key, entry);
    this.emitStatus(`Streaming OSM + DEM tile ${key}…`);

    const b = tileBounds(tx, ty);
    const heightAt = this.heightAtFn();

    const gen = this.fetchGen;

    // Roads and buildings wait for their DEM (longer budget than 1.3.1e). If it
    // still isn't there, they build provisionally and get re-heighted later.
    const demReady = await this.elevation.preloadArea(
      b.south,
      b.west,
      b.north,
      b.east,
      DEM_WAIT_MS,
    );
    if (!demReady && !this.disposed) {
      this.emitStatus(`Elevation slow for tile ${key} — building provisionally, will re-height`);
    }
    if (this.disposed || entry.cancelled || gen !== this.fetchGen) {
      this.finishLoading(key);
      return;
    }

    try {
      if (this.forceOffline) {
        this.applyTileFallback(entry, heightAt);
        this.emitStatus(`Forced offline roads · tile ${key}`);
      } else {
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
        entry.ways = freshWays;
        entry.buildings = freshBuildings;
        // Ways extend past the tile bbox: make sure their DEM is in too
        const db = dataBounds([...freshWays, ...freshBuildings], b);
        await this.elevation.preloadArea(db.south, db.west, db.north, db.east, 6_000);
        if (this.disposed || entry.cancelled) {
          this.finishLoading(key);
          return;
        }
        // Density polish: fill sparse lots without waiting on Overpass multipolygons
        const TARGET_PER_TILE = 380;
        entry.fillCount = 0;
        if (freshBuildings.length < 220) {
          entry.fillCount = Math.min(180, TARGET_PER_TILE - freshBuildings.length);
        }
        const built = await this.buildTileContent(entry);
        if (!built || this.disposed || entry.cancelled) {
          this.finishLoading(key);
          return;
        }
        entry.group.add(built.group);
        entry.centerlines = built.centerlines;
        entry.provisional = built.provisional;
        this.rebuildCenterlineIndex();
        const bldgCount = built.buildingCount;

        this.scene.add(entry.group);
        this.emitStatus(
          `Tile ${key}: ${freshWays.length} roads, ${bldgCount} buildings`,
        );
      }
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
    entry.ways = ways;
    entry.buildings = [];
    // Offline tiles have no OSM footprints — seed block-fill buildings
    entry.fillCount = 160;
    entry.fillSeed = entry.tx * 997 + entry.ty * 131 + 7;
    const before = this.provisionalSamples;
    const { group, centerlines } = this.builder.buildWays(ways, this.origin, heightAt);
    entry.centerlines = centerlines;
    entry.group.add(group);
    const fill = this.buildings.buildFillers(centerlines, this.origin, heightAt, {
      maxCount: entry.fillCount,
      seed: entry.fillSeed,
    });
    entry.group.add(fill);
    entry.provisional = this.provisionalSamples > before;
    this.scene.add(entry.group);
    this.rebuildCenterlineIndex();
  }

  private makeGridWaysForTile(tx: number, ty: number): OsmWay[] {
    const b = tileBounds(tx, ty);
    const ways: OsmWay[] = [];
    let id = 900000 + ((tx % 2000) + 2000) * 100 + ((ty % 2000) + 2000);
    // Short city-block segments (~80–110 m) — never one mega-span across the tile.
    // Mix primary/secondary/residential so lane dashes + curbs are exercised.
    const blocks = 6;
    const lats: number[] = [];
    const lons: number[] = [];
    for (let i = 0; i <= blocks; i++) {
      const u = i / blocks;
      lats.push(b.south + (b.north - b.south) * u);
      lons.push(b.west + (b.east - b.west) * u);
    }
    const EW_NAMES = ['Fallback Ave', 'Grid Blvd', 'Offline St', 'Ribbon Rd', 'Curb Way', 'Lane Ct', 'Mark Dr'];
    const NS_NAMES = ['North Grid', 'Center Ave', 'South Park', 'West Line', 'East Row', 'Block St', 'Plaza Rd'];
    for (let i = 0; i <= blocks; i++) {
      // Every 3rd E–W is primary (wider, lanes+curbs); else secondary / residential
      const highwayEw =
        i === Math.floor(blocks / 2) ? 'primary' : i % 3 === 0 ? 'secondary' : 'residential';
      const nameEw = EW_NAMES[i % EW_NAMES.length];
      for (let j = 0; j < blocks; j++) {
        ways.push({
          id: id++,
          tags: { highway: highwayEw, surface: 'asphalt', name: nameEw },
          geometry: [
            { lat: lats[i], lon: lons[j] },
            { lat: lats[i], lon: lons[j + 1] },
          ],
        });
        const highwayNs =
          i === Math.floor(blocks / 2) ? 'secondary' : i % 2 === 0 ? 'residential' : 'tertiary';
        ways.push({
          id: id++,
          tags: {
            highway: highwayNs,
            surface: 'asphalt',
            name: NS_NAMES[i % NS_NAMES.length],
          },
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
    await this.elevation.preloadArea(
      Math.min(sw.lat, ne.lat),
      Math.min(sw.lon, ne.lon),
      Math.max(sw.lat, ne.lat),
      Math.max(sw.lon, ne.lon),
    );
    const provBefore = this.provisionalSamples;
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
        let y = this.demHeight(ll.lat, ll.lon);
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
    this.terrainProvisional = this.provisionalSamples > provBefore;
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

  private heightAtFn(): (lat: number, lon: number) => number {
    return (lat: number, lon: number) => {
      const y = this.demHeight(lat, lon);
      return Number.isFinite(y) ? y : 0;
    };
  }

  /** Build roads + OSM buildings + fillers for a tile from its stored source data. */
  private async buildTileContent(entry: TileEntry): Promise<{
    group: THREE.Group;
    centerlines: RoadCenterline[];
    provisional: boolean;
    buildingCount: number;
  } | null> {
    const heightAt = this.heightAtFn();
    const before = this.provisionalSamples;
    const group = new THREE.Group();
    const { group: roads, centerlines } = await this.builder.buildWaysAsync(
      entry.ways,
      this.origin,
      heightAt,
    );
    if (this.disposed || entry.cancelled) {
      disposeGroup(roads);
      return null;
    }
    group.add(roads);
    let buildingCount = 0;
    if (entry.buildings.length) {
      const bldg = this.buildings.build(entry.buildings, this.origin, heightAt);
      group.add(bldg);
      buildingCount += bldg.children.length;
    }
    if (entry.fillCount > 0) {
      const fill = this.buildings.buildFillers(centerlines, this.origin, heightAt, {
        maxCount: entry.fillCount,
        seed: entry.fillSeed,
      });
      group.add(fill);
      buildingCount += fill.children.length;
    }
    return {
      group,
      centerlines,
      provisional: this.provisionalSamples > before,
      buildingCount,
    };
  }

  /**
   * v1.3.2: when fine DEM tiles land after a tile was built with provisional
   * heights, rebuild that tile's roads/buildings (and the terrain) so they
   * can't drift apart — the 1.3.1e terrain was re-meshed but roads never were.
   */
  private checkLateDem(): void {
    if (!this.demDirty || this.reheightBusy || this.disposed) return;
    const now = performance.now() / 1000;
    if (now - this.reheightAcc < REHEIGHT_CHECK_S) return;
    this.reheightAcc = now;
    this.demDirty = false;

    if (this.terrainProvisional) {
      this.queueTerrainRefresh(this.terrainCenterX, this.terrainCenterZ);
    }
    for (const entry of this.tiles.values()) {
      if (!entry.provisional || entry.loading || entry.rebuilding || entry.cancelled) continue;
      if (entry.reheights >= MAX_REHEIGHTS) continue;
      const b = dataBounds([...entry.ways, ...entry.buildings], tileBounds(entry.tx, entry.ty));
      if (!this.elevation.isAreaLoaded(b.south, b.west, b.north, b.east)) {
        // Still waiting; keep checking as more tiles land
        void this.elevation.preloadArea(b.south, b.west, b.north, b.east);
        continue;
      }
      void this.reheightTile(entry);
      return; // one at a time; the next check picks up the rest
    }
  }

  private async reheightTile(entry: TileEntry): Promise<void> {
    entry.rebuilding = true;
    entry.reheights++;
    this.reheightBusy = true;
    try {
      const built = await this.buildTileContent(entry);
      if (!built || this.disposed || entry.cancelled) {
        if (built) disposeGroup(built.group);
        return;
      }
      for (const child of [...entry.group.children]) {
        entry.group.remove(child);
        disposeGroup(child);
      }
      entry.group.add(built.group);
      entry.centerlines = built.centerlines;
      entry.provisional = built.provisional;
      this.rebuildCenterlineIndex();
      this.emitStatus(`Re-heighted tile ${entry.key} with late elevation data`);
    } finally {
      entry.rebuilding = false;
      this.reheightBusy = false;
      // Another tile may be waiting
      this.demDirty = true;
    }
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
    const heightAt = this.heightAtFn();
    const before = this.provisionalSamples;
    const { group: roads, centerlines } = this.builder.buildWays(ways, this.origin, heightAt);
    const fill = this.buildings.buildFillers(centerlines, this.origin, heightAt, {
      maxCount: 200,
      seed: tx * 17 + ty * 31,
    });
    const group = new THREE.Group();
    group.add(roads);
    group.add(fill);
    this.scene.add(group);
    this.tiles.set('fallback', {
      key: 'fallback',
      tx,
      ty,
      group,
      loading: false,
      centerlines,
      wayIds: [],
      buildingIds: [],
      usedFallback: true,
      cancelled: false,
      ways,
      buildings: [],
      provisional: this.provisionalSamples > before,
      rebuilding: false,
      fillCount: 200,
      fillSeed: tx * 17 + ty * 31,
      reheights: 0,
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
    this.streetLabels.dispose();
    this.elevation.dispose();
    this.coarseElevation.dispose();
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

function disposeGroup(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
}
