import * as THREE from 'three';
import { OverpassClient } from './OverpassClient';
import { RoadBuilder, type RoadCenterline } from './RoadBuilder';
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
import { RoadIndex } from './RoadIndex';
import type { ProfileEnv } from './RoadProfile';
import { TerrainRing, WaterPlane, type RingConfig, type RingSample } from './Terrain';
import { createTerrainMaterial, type TerrainMaterialHandle } from '../visuals/TerrainMaterial';
import type { TextureLibrary } from '../visuals/TextureLibrary';
import { QUALITY, type QualitySettings } from '../visuals/Quality';

const LOAD_RADIUS = 2;
const UNLOAD_RADIUS = 4;
/** Car height blends from road centreline to ground within this distance of a road. */
const ROAD_HEIGHT_RADIUS = 14;
/** Terrain under the asphalt sits this far below the road surface (replaces the blanket −0.62 m sink). */
const CARVE_UNDER_ROAD = 0.14;
/** Flatten this far beyond each road edge (+ ~0.6 grid cell so coarse triangles can't poke through). */
const CARVE_FLAT_EXTRA = 1.0;
/** Then blend back to the DEM over this shoulder. */
const CARVE_SHOULDER = 7;
/** Re-carve the near ring at most this often (ms) as new road tiles stream in. */
const CARVE_REBUILD_MS = 2500;

const NEAR_RING: RingConfig = { name: 'near', size: 1200, res: 192, recenter: 160, skirt: 12, carve: true };
const MID_RING: RingConfig = { name: 'mid', size: 4800, res: 160, recenter: 700, skirt: 40, carve: false };
const FAR_RING: RingConfig = { name: 'far', size: 16000, res: 128, recenter: 2600, skirt: 120, carve: false };
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
  /** v1.3.2: z14 (~9 m/px) for roads, buildings and the near terrain ring. */
  readonly elevation = new ElevationSampler(14, 128);
  /** z12 for the mid ring (and a provisional stand-in for z14). */
  readonly midElevation = new ElevationSampler(12, 24);
  /** Low-zoom DEM: far ring + last-resort provisional heights while fine tiles stream. */
  readonly coarseElevation = new ElevationSampler(COARSE_DEM_ZOOM, 16);
  /** Spatial hash of road centreline segments (carve, car surface, nearest road). */
  readonly roadIndex = new RoadIndex();
  /** Junction heights shared across tiles (RoadProfile). */
  private junctionRegistry = new Map<string, { y: number; provisional: boolean }>();
  private rings: TerrainRing[] = [];
  private ringMats: TerrainMaterialHandle[] = [];
  private water = new WaterPlane();
  private seaRel = -1e6;
  /** Count of heights served from a non-fine source since last reset. */
  private provisionalSamples = 0;
  private demDirty = false;
  private reheightAcc = 0;
  private reheightBusy = false;
  private scene: THREE.Scene;
  private client = new OverpassClient();
  private builder: RoadBuilder;
  private textures: TextureLibrary | null;
  private quality: QualitySettings;
  private unsubTextures: (() => void) | null = null;
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
  private centerlines: RoadCenterline[] = [];
  private usedOfflineFallback = false;
  /** When true, skip Overpass and always use offline road grids (QA: ?fallback=1). */
  private forceOffline = false;
  private weather: WeatherPreset = 'clear';
  private disposed = false;
  private fetchGen = 0;
  readonly streetLabels = new StreetLabels();

  constructor(
    scene: THREE.Scene,
    originLat: number,
    originLon: number,
    textures: TextureLibrary | null = null,
    quality: QualitySettings = QUALITY.medium,
  ) {
    this.scene = scene;
    this.origin = new GeoOrigin(originLat, originLon);
    this.textures = textures;
    this.quality = quality;
    this.builder = new RoadBuilder(textures);

    const terrainTex = makeTerrainTexture();
    this.groundMat = new THREE.MeshStandardMaterial({
      color: 0x4a6238,
      map: terrainTex,
      roughness: 0.95,
      metalness: 0,
    });
    // One material per ring (each has its own inner-ring "hole" uniform)
    const ringCfgs = [NEAR_RING, MID_RING, FAR_RING];
    ringCfgs.forEach((cfg, i) => {
      const handle = createTerrainMaterial({
        polygonOffsetFactor: 2 + i * 3,
        name: `terrain-${cfg.name}`,
        variant: i === 0 ? 'near' : 'far',
      });
      this.ringMats.push(handle);
      const ringCfg = i === 0 ? { ...cfg, res: quality.nearRingRes } : cfg;
      const ring = new TerrainRing(ringCfg, handle.material);
      this.rings.push(ring);
      scene.add(ring.mesh);
    });
    scene.add(this.water.mesh);
    if (textures) {
      this.unsubTextures = textures.onReady(() => {
        if (this.disposed) return;
        const arrays = textures.getTerrain();
        for (const m of this.ringMats) m.setTextures(arrays, this.quality);
        this.applyTerrainWeather();
      });
    }
    const groundGeo = new THREE.PlaneGeometry(3600, 3600);
    this.ground = new THREE.Mesh(groundGeo, this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -6;
    this.ground.receiveShadow = true;
    this.ground.name = 'ground-fallback';
    scene.add(this.ground);
    scene.add(this.streetLabels.group);
    for (const sampler of [this.elevation, this.midElevation, this.coarseElevation]) {
      sampler.onTileLoaded(() => {
        this.demDirty = true;
      });
    }
  }

  /**
   * Best available relative height: fine DEM → coarse DEM → spawn level.
   * Anything not from the fine DEM bumps provisionalSamples so the caller can
   * flag its tile for re-heighting (v1.3.2: no more last-sampled plateaus).
   */
  private demHeight(lat: number, lon: number): number {
    const fine = this.elevation.sampleRelative(lat, lon);
    if (fine !== null) return this.clampSea(fine);
    this.provisionalSamples++;
    const mid = this.midElevation.sampleRelative(lat, lon);
    if (mid !== null) return this.clampSea(mid);
    const coarse = this.coarseElevation.sampleRelative(lat, lon);
    if (coarse !== null) return this.clampSea(coarse);
    return 0;
  }

  /** Bathymetry → just under the sea-level water plane (SF Bay is water, not a bowl). */
  private clampSea(y: number): number {
    return y < this.seaRel - 1.5 ? this.seaRel - 1.5 : y;
  }

  private demHeightLocal(x: number, z: number): number {
    const ll = this.origin.toLatLon(x, z);
    return this.demHeight(ll.lat, ll.lon);
  }

  /** Height source per ring: near = z14 chain, mid = z12 chain, far = z11. */
  private ringDem(ring: number, x: number, z: number): number {
    const ll = this.origin.toLatLon(x, z);
    if (ring === 0) return this.demHeight(ll.lat, ll.lon);
    if (ring === 1) {
      const m = this.midElevation.sampleRelative(ll.lat, ll.lon);
      if (m !== null) return this.clampSea(m);
    }
    const c = this.coarseElevation.sampleRelative(ll.lat, ll.lon);
    if (c !== null) return this.clampSea(c);
    this.provisionalSamples++;
    return 0;
  }

  /**
   * v1.3.2 corridor carve (replaces TERRAIN_Y_BIAS −0.62): within each road's
   * half-width + ~1 m (+ a fraction of the grid cell) the ground sits just under
   * the road surface; beyond that it blends back to the DEM over a shoulder.
   * Bridges and tunnels don't carve.
   */
  carveAt(x: number, z: number, dem: number, cell = 6.25): RingSample {
    const flatPad = CARVE_FLAT_EXTRA + cell * 0.6;
    const radius = 7 + flatPad + CARVE_SHOULDER;
    let bestW = 0;
    let bestY = dem;
    let bestD = Infinity;
    let verge = 0;
    this.roadIndex.forEachNear(x, z, radius, (ref) => {
      const line = ref.line;
      if (line.structure !== 'ground') return;
      const pts = line.points;
      const a = pts[ref.i];
      const b = pts[ref.i + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len = abx * abx + abz * abz;
      let t = len < 1e-8 ? 0 : ((x - a.x) * abx + (z - a.z) * abz) / len;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
      const half = (line.width ?? 6) * 0.5;
      const flat = half + flatPad;
      let w: number;
      if (d <= flat) w = 1;
      else if (d >= flat + CARVE_SHOULDER) w = 0;
      else {
        const u = 1 - (d - flat) / CARVE_SHOULDER;
        w = u * u * (3 - 2 * u);
      }
      if (w <= 0) return;
      // Verge (gravel/dirt strip) just beyond the edge
      const vd = d - half;
      if (vd > -0.5 && vd < 3.5) verge = Math.max(verge, 1 - Math.max(0, vd - 1.5) / 2);
      if (w > bestW || (w === bestW && d < bestD)) {
        bestW = w;
        bestD = d;
        bestY = a.y + (b.y - a.y) * t - CARVE_UNDER_ROAD;
      }
    });
    return { y: dem + (bestY - dem) * bestW, verge };
  }

  /** Final ground height (DEM + corridor carve), consistent with the near terrain ring. */
  groundHeight(x: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const before = this.provisionalSamples;
    const dem = this.demHeightLocal(x, z);
    this.provisionalSamples = before;
    const y = this.carveAt(x, z, dem, this.rings[0]?.cell ?? 6.25).y;
    return Number.isFinite(y) ? y : 0;
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
    this.applyTerrainWeather();
  }

  private applyTerrainWeather(): void {
    const weather = this.weather;
    const textured = !!this.textures?.ready;
    for (const m of this.ringMats) {
      if (textured) {
        // Splat shader handles snow cover / wet darkening itself
        m.material.color.setHex(0xffffff);
        m.setWeather(weather === 'snow' ? 1 : 0, weather === 'rain' ? 1 : 0);
      } else {
        m.material.color.setHex(weather === 'snow' ? 0xe6ecf0 : weather === 'rain' ? 0xa6b0a6 : 0xffffff);
      }
    }
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
    const originAbs = this.elevation.getOriginElevation();
    this.midElevation.setOriginElevation(originAbs);
    this.coarseElevation.setOriginElevation(originAbs);
    this.seaRel = -originAbs;
    this.water.mesh.position.y = this.seaRel;
    // Only bother drawing the sea where it can be seen (SF, Toronto shore…)
    this.water.mesh.visible = originAbs < 250;
    void this.midElevation.preloadArea(
      this.origin.lat - 0.025,
      this.origin.lon - 0.035,
      this.origin.lat + 0.025,
      this.origin.lon + 0.035,
    );
    void this.coarseElevation.preloadArea(
      this.origin.lat - 0.08,
      this.origin.lon - 0.11,
      this.origin.lat + 0.08,
      this.origin.lon + 0.11,
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
      this.rebuildRing(0, 0, 0),
      new Promise<void>((r) => setTimeout(r, 6_000)),
    ]);
    void this.rebuildRing(1, 0, 0);
    void this.rebuildRing(2, 0, 0);
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

    this.updateTerrain(playerX, playerZ);
    this.water.mesh.position.x = playerX;
    this.water.mesh.position.z = playerZ;
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

    this.roadIndex.remove(entry.centerlines);
    for (const id of entry.wayIds) this.seenWayIds.delete(id);
    for (const id of entry.buildingIds) this.seenBuildingIds.delete(id);

    this.tiles.delete(key);
    this.rebuildCenterlineIndex();
  }

  /** Ground height incl. road corridor carve (camera clamp, spawn, off-road). */
  getHeight(x: number, z: number): number {
    return this.groundHeight(x, z);
  }

  /**
   * Surface under (x, z). v1.3.2: spatial-hash lookup (was every segment of every
   * road), carved ground off-road, and `preferY` keeps a car on its own deck when
   * roads stack (bridges over roads, tunnels under hills).
   */
  sampleSurface(x: number, z: number, preferY?: number): SurfaceSample {
    const groundY = this.groundHeight(x, z);
    const offRoad: SurfaceSample = {
      roadFactor: 0.35,
      height: groundY,
      grip: effectiveGrip(defaultAsphaltProfile(), 0.35, this.weather) * 0.85,
      noise: 0.2,
      label: 'Off-road',
      kind: 'dirt',
    };
    if (!Number.isFinite(x) || !Number.isFinite(z)) return offRoad;

    const near = this.roadIndex.nearest(x, z, ROAD_HEIGHT_RADIUS + 8, undefined, preferY);
    if (!near) return offRoad;
    const line = near.line;
    // A tunnel only counts once you're actually down at its level (through the portal)
    if (line.structure === 'tunnel' && (preferY === undefined || Math.abs(near.y - preferY) > 3)) {
      return offRoad;
    }
    const dist = Math.sqrt(near.distSq);
    const half = Math.max(1.5, (line.width ?? 6.4) * 0.5);
    const onRoad = half + 0.4;
    const soft = half + 3.5;
    const roadFactor =
      dist < onRoad
        ? 1
        : dist < soft
          ? THREE.MathUtils.clamp(1 - (dist - onRoad) / (soft - onRoad), 0.35, 1)
          : 0.35;

    let height: number;
    if (line.structure !== 'ground') {
      // Decks/tunnels: no blending to the ground below/above
      height = dist <= half + 1.5 ? near.y : groundY;
    } else if (dist <= onRoad) {
      height = near.y;
    } else if (dist <= ROAD_HEIGHT_RADIUS) {
      const w = THREE.MathUtils.clamp(1 - (dist - onRoad) / (ROAD_HEIGHT_RADIUS - onRoad), 0, 1);
      height = near.y * w + groundY * (1 - w);
    } else {
      height = groundY;
    }
    if (!Number.isFinite(height)) height = groundY;

    const profile: SurfaceProfile = line.surface;
    const grip = effectiveGrip(profile, roadFactor, this.weather);
    return {
      roadFactor,
      height,
      grip,
      noise: profile.noise * (roadFactor > 0.5 ? 1 : 1.4),
      label: roadFactor > 0.5 ? profile.label : 'Off-road',
      kind: roadFactor > 0.5 ? profile.kind : 'dirt',
    };
  }

  findNearestRoadPoint(x: number, z: number): { x: number; z: number; y: number } | null {
    let best: { x: number; z: number; y: number; d: number } | null = null;
    for (const line of this.centerlines) {
      if (line.structure !== 'ground') continue; // never spawn on a bridge deck / in a tunnel
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
          if (built) {
            this.roadIndex.remove(built.centerlines);
            disposeGroup(built.group);
          }
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
    void heightAt;
    const { group, centerlines } = this.builder.buildWays(ways, this.profileEnv());
    entry.centerlines = centerlines;
    this.roadIndex.add(centerlines);
    entry.group.add(group);
    const fill = this.buildings.buildFillers(centerlines, this.origin, this.groundAtFn(), {
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

  /** Rebuild one terrain ring around (x, z) (snapped), time-sliced. */
  private async rebuildRing(index: number, x: number, z: number): Promise<void> {
    const ring = this.rings[index];
    if (!ring || this.disposed) return;
    const c = ring.snapCenter(x, z);
    const cell = ring.cell;
    const provBefore = this.provisionalSamples;
    const roadVersion = this.roadIndex.version;
    if (index === 0) {
      const half = ring.cfg.size / 2;
      const a = this.origin.toLatLon(c.x - half, c.z - half);
      const b = this.origin.toLatLon(c.x + half, c.z + half);
      await this.elevation.preloadArea(
        Math.min(a.lat, b.lat),
        Math.min(a.lon, b.lon),
        Math.max(a.lat, b.lat),
        Math.max(a.lon, b.lon),
        6_000,
      );
      if (this.disposed) return;
    }
    const heightAt = (wx: number, wz: number): RingSample => {
      const dem = this.ringDem(index, wx, wz);
      if (index === 0) return this.carveAt(wx, wz, dem, cell);
      return { y: dem, verge: 0 };
    };
    const ok = await ring.build(c.x, c.z, heightAt, () => this.disposed);
    if (!ok || this.disposed) return;
    ring.provisional = this.provisionalSamples > provBefore;
    ring.roadVersion = roadVersion;
    this.ground.visible = false;
    this.syncRingHoles();
  }

  /** Point each outer ring's vertex-shader hole at the current inner ring. */
  private syncRingHoles(): void {
    for (let i = 1; i < this.rings.length; i++) {
      const inner = this.rings[i - 1];
      const h = this.ringMats[i].inner;
      if (!inner.builtOnce) {
        h.set(0, 0, 0, 0);
        continue;
      }
      // Hole slightly inside the inner footprint; fade over one outer cell
      h.set(inner.centerX, inner.centerZ, inner.cfg.size / 2 - inner.cell, this.rings[i].cell);
    }
  }

  private updateTerrain(px: number, pz: number): void {
    const now = performance.now();
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i];
      if (ring.building) continue;
      let want = ring.needsRecentre(px, pz);
      // Near ring: re-carve when new roads streamed in nearby (throttled)
      if (
        !want &&
        i === 0 &&
        ring.roadVersion !== this.roadIndex.version &&
        now - ring.lastBuildAt > CARVE_REBUILD_MS
      ) {
        want = true;
      }
      if (want) {
        const cx = i === 0 ? px : px;
        void this.rebuildRing(i, cx, pz);
      }
    }
  }

  private heightAtFn(): (lat: number, lon: number) => number {
    return (lat: number, lon: number) => {
      const y = this.demHeight(lat, lon);
      return Number.isFinite(y) ? y : 0;
    };
  }

  /** Carved ground by lat/lon — what buildings stand on. */
  private groundAtFn(): (lat: number, lon: number) => number {
    return (lat: number, lon: number) => {
      const p = this.origin.toLocal(lat, lon);
      const dem = this.demHeight(lat, lon);
      const y = this.carveAt(p.x, p.z, dem, this.rings[0]?.cell ?? 6.25).y;
      return Number.isFinite(y) ? y : 0;
    };
  }

  private profileEnv(): ProfileEnv {
    if (this.junctionRegistry.size > 200_000) this.junctionRegistry.clear();
    return {
      origin: this.origin,
      heightAt: this.heightAtFn(),
      seaRel: this.seaRel,
      registry: this.junctionRegistry,
      provisionalCounter: () => this.provisionalSamples,
    };
  }

  /** Build roads + OSM buildings + fillers for a tile from its stored source data. */
  private async buildTileContent(entry: TileEntry): Promise<{
    group: THREE.Group;
    centerlines: RoadCenterline[];
    provisional: boolean;
    buildingCount: number;
  } | null> {
    const before = this.provisionalSamples;
    const group = new THREE.Group();
    const { group: roads, centerlines } = await this.builder.buildWaysAsync(
      entry.ways,
      this.profileEnv(),
    );
    if (this.disposed || entry.cancelled) {
      disposeGroup(roads);
      return null;
    }
    group.add(roads);
    // Buildings stand on the carved ground, so the new roads must be indexed first
    const tmpIndexed = !entry.centerlines.length || entry.centerlines !== centerlines;
    if (tmpIndexed) {
      this.roadIndex.remove(entry.centerlines);
      this.roadIndex.add(centerlines);
    }
    const heightAt = this.groundAtFn();
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

    this.rings.forEach((ring, i) => {
      if (ring.provisional && !ring.building && ring.builtOnce) {
        void this.rebuildRing(i, ring.centerX, ring.centerZ);
      }
    });
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
        if (built) {
          this.roadIndex.remove(built.centerlines);
          disposeGroup(built.group);
        }
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
    const before = this.provisionalSamples;
    const { group: roads, centerlines } = this.builder.buildWays(ways, this.profileEnv());
    this.roadIndex.add(centerlines);
    const fill = this.buildings.buildFillers(centerlines, this.origin, this.groundAtFn(), {
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
    for (const ring of this.rings) {
      this.scene.remove(ring.mesh);
      ring.dispose();
    }
    this.rings = [];
    this.unsubTextures?.();
    this.unsubTextures = null;
    for (const m of this.ringMats) m.material.dispose();
    this.ringMats = [];
    this.scene.remove(this.water.mesh);
    this.water.dispose();
    this.roadIndex.clear();
    this.junctionRegistry.clear();
    this.scene.remove(this.ground);
    this.ground.geometry.dispose();
    this.groundMat.dispose();
    this.builder.dispose();
    this.buildings.dispose();
    this.streetLabels.dispose();
    this.elevation.dispose();
    this.coarseElevation.dispose();
    this.midElevation.dispose();
    this.seenWayIds.clear();
    this.seenBuildingIds.clear();
    this.centerlines = [];
  }
}



function disposeGroup(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose();
  });
}
