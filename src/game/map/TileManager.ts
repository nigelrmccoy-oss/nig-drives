import * as THREE from 'three';
import { OverpassClient } from './OverpassClient';
import { RoadBuilder, type RoadCenterline } from './RoadBuilder';
import { BuildingBuilder, type Footprint } from './BuildingBuilder';
import { ShoreMask, SHORE_HALF_M, type ShoreClass, type ShoreLines } from './ShoreMask';
import { loadBundledShore, bundledCovers, bundledShoreLines, bundledInlandNear, type BundledShore } from './BundledShore';
import type { OsmNode } from './OverpassClient';
import { WaterMap, assembleRings, type AreaClass, type AreaSample } from './WaterMap';
import { isWaterTags, type OsmArea } from './OverpassClient';
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
/** v1.3.4: OSM-dry shore cells the DEM had sunk are lifted to at least this far above the lake. */
const SHORE_LAND_M = 0.3;
/**
 * Terrain (ring vertices and groundHeight) is kept at least 15 cm off the
 * lake / sea plane (z-fighting); in-band heights are pushed to 17 cm so float
 * error can't land back inside the 15 cm rule (v1.3.5).
 */
const WATER_PLANE_PUSH_M = 0.17;
/** Re-centre the shore mask when the player is this far from its centre. */
const SHORE_RECENTRE_M = 350;
/** OSM shore lines are fetched for the mask window plus this margin. */
const SHORE_FETCH_PAD_M = 1200;
/** Car wheel contact sits this far under the lake / sea surface when it drives in. */
const WATER_WADE_M = 0.55;

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
  /** Solid building footprints in this tile (push-out collision). */
  footprints?: Footprint[];
}

export interface WaterInfo {
  /** Height the car wades at. */
  y: number;
  /** Water surface height. */
  surface: number;
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
  /** Relative height of the sea / Great Lake surface (water plane). */
  private seaRel = -1e6;
  /** v1.3.3: true when seaRel is a Great Lake level (flat DEM lake surface). */
  private lakeMode = false;
  private waterMap = new WaterMap();
  private areaTmp: AreaSample = { water: 0, level: Number.NaN, park: 0, forest: 0, farm: 0 };
  private ringWaterVersion: string[] = ['', '', ''];
  /** v1.3.4 near-camera Great-Lake shoreline (DEM + OSM shore lines). */
  private shore = new ShoreMask();
  private shoreLines: { minX: number; minZ: number; maxX: number; maxZ: number; lines: ShoreLines } | null = null;
  private shoreFetching = false;
  /** v1.3.5: bundled western Lake Ontario outline (null outside / not loaded). */
  private bundled: BundledShore | null = null;
  private bundledLines: ShoreLines | null = null;
  /** Where the published shore mask came from. */
  private shoreSource: 'none' | 'bundled' | 'overpass' | 'dem' = 'none';
  private shoreFetchRetryAt = 0;
  private shoreStale = false;
  /** Shore mask classed (partly) from the z12 stand-in: rebuild once fine DEM lands. */
  private shoreProvisional = false;
  private shoreClassProv = false;
  private waterTime = 0;
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
  private buildings: BuildingBuilder;
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
    this.buildings = new BuildingBuilder(textures);
    this.buildings.skipAt = (x, z) => this.isWaterLocal(x, z);
    this.buildings.roadAt = (x, z) => {
      const hit = this.roadIndex.nearest(x, z, 16);
      return !!hit && Math.sqrt(hit.distSq) < (hit.line.width ?? 6) * 0.5 + 1.5;
    };

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
    if (fine !== null) return this.clampSea(fine, lat, lon, this.elevation);
    this.provisionalSamples++;
    const mid = this.midElevation.sampleRelative(lat, lon);
    if (mid !== null) return this.clampSea(mid, lat, lon, this.midElevation);
    const coarse = this.coarseElevation.sampleRelative(lat, lon);
    if (coarse !== null) return this.clampSea(coarse, lat, lon, this.coarseElevation);
    return 0;
  }

  /** Bathymetry → just under the sea-level water plane (SF Bay is water, not a bowl). */
  private clampSea(
    y: number,
    lat: number,
    lon: number,
    src: { sampleRelative(lat: number, lon: number): number | null },
  ): number {
    if (!this.lakeMode) return y < this.seaRel - 1.5 ? this.seaRel - 1.5 : y;
    // Great Lakes are flat in Terrarium at their surface level: sink that
    // surface just under the lake-level water plane so it reads as water.
    const d = y - this.seaRel;
    if (d < LAKE_FLAT_M) return this.seaRel - 1.5;
    if (d > LAKE_NOISE_M) return y;
    // DEM noise in the lake (0.4–1.3 m bumps) used to poke through as green
    // patches: a near-level sample that is mostly surrounded by lake is lake.
    const mLat = 1 / 111_320;
    const mLon = mLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    let wet = 0;
    let n = 0;
    for (const r of LAKE_PROBE_R) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + r * 0.01;
        const v = src.sampleRelative(lat + Math.sin(a) * r * mLat, lon + Math.cos(a) * r * mLon);
        if (v === null) continue;
        n++;
        if (v - this.seaRel < LAKE_FLAT_M) wet++;
      }
    }
    return n > 0 && wet / n >= 0.6 ? this.seaRel - 1.5 : y;
  }

  /** Is this point under the sea / Great-Lake plane or inside an OSM water polygon? */
  private isWaterLocal(x: number, z: number): boolean {
    if (this.waterMap.size && this.waterMap.sample(x, z, this.areaTmp).water > 0.5) return true;
    if (this.seaRel < -1e5) return false;
    const before = this.provisionalSamples;
    const y = this.shoreAdjust(x, z, this.demHeightLocal(x, z));
    this.provisionalSamples = before;
    return y <= this.seaRel - 1;
  }

  /**
   * v1.3.4: inside the near-camera shore mask the lake / land split follows
   * OSM (and the 2.5 m raster), not the 7 m DEM: water cells are sunk under
   * the plane, dry cells the DEM had sunk are lifted just above it.
   */
  private shoreAdjust(x: number, z: number, dem: number): number {
    // v1.3.5: a DEM-only mask (no OSM / bundled outline) is no better than
    // the raw DEM and was 2–3× further off in QA — keep the 1.3.3 shore then.
    if (!this.lakeMode || !this.shore.ready || !this.shore.osm) return dem;
    const w = this.shore.sample(x, z);
    if (Number.isNaN(w)) return dem;
    const sunk = this.seaRel - 1.5;
    const landY = dem < this.seaRel + SHORE_LAND_M ? this.seaRel + SHORE_LAND_M : dem;
    if (w <= 0.3) return landY;
    if (w >= 0.7) return sunk;
    const t = (w - 0.3) / 0.4;
    return landY + (sunk - landY) * t * t * (3 - 2 * t);
  }

  /** Lake / sea / OSM water under (x, z) → wading height, else null. */
  waterInfo(x: number, z: number, groundY?: number): WaterInfo | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    if (this.waterMap.size) {
      const s = this.waterMap.sample(x, z, this.areaTmp);
      if (s.water > 0.5) {
        const g = groundY ?? this.groundHeight(x, z);
        const surf = Number.isFinite(s.level) ? s.level : g + 0.6;
        return { y: g, surface: surf };
      }
    }
    if (this.seaRel < -1e5) return null;
    if (!this.isWaterLocal(x, z)) return null;
    // v1.3.5 P2-1: the 2.5 m mask / DEM can call a cell wet where the 6.25 m
    // mesh is still visibly land (shore band) — the car then sat ~0.8 m into
    // the drawn ground. Ride on what is drawn: visibly dry → not water.
    const vis = this.visibleGround(x, z, groundY ?? this.groundHeight(x, z));
    if (vis >= this.seaRel - 0.05) return null;
    return { y: Math.max(this.seaRel - WATER_WADE_M, vis), surface: this.seaRel };
  }

  /**
   * v1.3.5: on the lake / sea shore band the drawn near-ring surface can sit
   * above groundHeight (triangle interpolation over sunk 2.5 m cells): use the
   * higher of the two there so wheels don't sink into visible terrain.
   */
  private visibleGround(x: number, z: number, g: number): number {
    if (this.seaRel < -1e5 || g > this.seaRel + 0.5) return g;
    const m = this.rings[0]?.sampleHeight(x, z) ?? Number.NaN;
    return Number.isFinite(m) && m > g ? m : g;
  }

  /** Relative height of the lake / sea plane (−1e6 when there is none). */
  getSeaLevel(): number {
    return this.seaRel;
  }

  /**
   * v1.3.3 inland water: inside an OSM lake/river polygon the ground goes to
   * the lake level (rivers: just under the DEM), with the banks easing down.
   * Leaves the full sample in this.areaTmp for the caller.
   */
  private applyWater(x: number, z: number, dem: number): number {
    dem = this.shoreAdjust(x, z, dem);
    const s = this.waterMap.sample(x, z, this.areaTmp);
    if (s.water <= 0) return dem;
    const yW = Number.isFinite(s.level) ? s.level : dem - 0.6;
    const t = Math.min(1, s.water * 2);
    if (t >= 1) return yW;
    return dem + (Math.min(dem, yW) - dem) * t;
  }

  /** Lake level from the DEM around its shore (15th percentile, a touch under). */
  private lakeLevel(rings: Array<Array<{ x: number; z: number }>>): { level: number; provisional: boolean } {
    const before = this.provisionalSamples;
    const pts: number[] = [];
    let total = 0;
    for (const r of rings) total += r.length;
    const step = Math.max(1, Math.floor(total / 160));
    let k = 0;
    for (const r of rings)
      for (const p of r) {
        if (k++ % step) continue;
        const y = this.demHeightLocal(p.x, p.z);
        if (Number.isFinite(y)) pts.push(y);
      }
    const provisional = this.provisionalSamples > before;
    this.provisionalSamples = before;
    if (!pts.length) return { level: 0, provisional: true };
    pts.sort((a, b) => a - b);
    return { level: pts[Math.floor(pts.length * 0.15)] - 0.15, provisional };
  }

  private addAreas(areas: OsmArea[]): void {
    for (const a of areas) {
      if (this.waterMap.has(a.key)) continue;
      const cls = areaClass(a.tags);
      if (!cls) continue;
      const parts = a.parts.map((g) => g.map((n) => this.origin.toLocal(n.lat, n.lon)));
      const rings = a.key.startsWith('r') ? assembleRings(parts) : parts.map((r) => {
        const c = r.slice();
        const f = c[0];
        const l = c[c.length - 1];
        if (c.length > 3 && Math.abs(f.x - l.x) < 0.05 && Math.abs(f.z - l.z) < 0.05) c.pop();
        return c;
      });
      // open ways (unclosed coastline-ish pieces) aren't areas
      if (a.key.startsWith('w')) {
        const g = a.parts[0];
        const f = g[0];
        const l = g[g.length - 1];
        if (Math.abs(f.lat - l.lat) > 1e-7 || Math.abs(f.lon - l.lon) > 1e-7) continue;
      }
      this.waterMap.add({ key: a.key, cls, rings }, (r) => this.lakeLevel(r));
    }
  }

  /** ≥ 40 % of a 5×5 sample grid over the tile is sea / lake / OSM water. */
  private tileMostlyWater(b: { south: number; west: number; north: number; east: number }): boolean {
    let wet = 0;
    for (let j = 0; j < 5; j++)
      for (let i = 0; i < 5; i++) {
        const p = this.origin.toLocal(b.south + ((j + 0.5) / 5) * (b.north - b.south), b.west + ((i + 0.5) / 5) * (b.east - b.west));
        if (this.isWaterLocal(p.x, p.z)) wet++;
      }
    return wet >= 10;
  }

  /** Water polygon under (x, z)? (0..1) */
  waterAt(x: number, z: number): number {
    return this.waterMap.sample(x, z, this.areaTmp).water;
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
      if (m !== null) return this.clampSea(m, ll.lat, ll.lon, this.midElevation);
    }
    const c = this.coarseElevation.sampleRelative(ll.lat, ll.lon);
    if (c !== null) return this.clampSea(c, ll.lat, ll.lon, this.coarseElevation);
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

  /**
   * Push heights out of the ±WATER_PLANE_PUSH_M band around a visible lake /
   * sea plane (v1.3.4 ring vertices; v1.3.5 also groundHeight). The push is a
   * little more than the 15 cm rule so float error can't land inside it.
   */
  private offPlane(y: number): number {
    if (!this.water.mesh.visible || this.seaRel < -1e5) return y;
    const d = y - this.seaRel;
    if (d > -WATER_PLANE_PUSH_M && d < WATER_PLANE_PUSH_M) {
      return d >= 0 ? this.seaRel + WATER_PLANE_PUSH_M : this.seaRel - WATER_PLANE_PUSH_M;
    }
    return y;
  }

  /** Final ground height (DEM + corridor carve), consistent with the near terrain ring. */
  groundHeight(x: number, z: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const before = this.provisionalSamples;
    const dem = this.applyWater(x, z, this.demHeightLocal(x, z));
    this.provisionalSamples = before;
    const y = this.carveAt(x, z, dem, this.rings[0]?.cell ?? 6.25).y;
    // v1.3.5 P1-3: the same off-plane push as the ring vertices, so physics,
    // spawn and QA sampling never see terrain within 15 cm of the water plane
    return Number.isFinite(y) ? this.offPlane(y) : 0;
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
    const lake = greatLakeAt(this.origin.lat, this.origin.lon, originAbs);
    if (lake) {
      // Toronto / Chicago / Cleveland…: the plane sits at the lake surface
      this.lakeMode = true;
      this.seaRel = lake.level - originAbs;
      this.water.mesh.visible = true;
    } else {
      this.lakeMode = false;
      this.seaRel = -originAbs;
      // Only bother drawing the sea where it can be seen (SF…)
      this.water.mesh.visible = originAbs < 250;
    }
    this.water.mesh.position.y = this.seaRel;
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

    // v1.3.5: bundled OSM shoreline / inland lakes (offline-safe, separate chunk)
    this.bundled = await loadBundledShore();
    if (this.disposed) return;
    if (this.bundled) {
      const near = bundledInlandNear(this.bundled, this.origin.lat, this.origin.lon, 15);
      if (near.length) this.addAreas(near);
    }

    if (this.lakeMode) {
      // v1.3.4: DEM shore mask before anything is placed (OSM lines follow in the background)
      this.emitStatus('Mapping the shoreline…');
      await Promise.race([this.refreshShore(0, 0), new Promise<void>((r) => setTimeout(r, 8_000))]);
      if (this.disposed) return;
    }

    const { tx, ty } = latLonToTile(this.origin.lat, this.origin.lon);
    this.emitStatus(
      this.forceOffline
        ? `Forced offline roads (?fallback=1) · tile ${tileKey(tx, ty)}…`
        : `Loading spawn tile ${tileKey(tx, ty)}…`,
    );
    await this.loadTile(tx, ty);
    if (this.disposed) return;

    if (!this.hasAnyRoads()) {
      // Fallback grid is masked against water: make sure the 3×3 DEM is in
      const tb0 = tileBounds(tx - 1, ty + 1);
      const tb1 = tileBounds(tx + 1, ty - 1);
      await this.elevation.preloadArea(
        Math.min(tb0.south, tb1.south),
        Math.min(tb0.west, tb1.west),
        Math.max(tb0.north, tb1.north),
        Math.max(tb0.east, tb1.east),
        6_000,
      );
      if (this.disposed) return;
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
    if (
      this.lakeMode &&
      !this.shore.building &&
      (this.shoreStale ||
        !this.shore.ready ||
        Math.max(Math.abs(playerX - this.shore.centerX), Math.abs(playerZ - this.shore.centerZ)) > SHORE_RECENTRE_M)
    ) {
      void this.refreshShore(playerX, playerZ);
    }
    this.ground.position.x = playerX;
    this.ground.position.z = playerZ;

    this.waterTime = performance.now() / 1000;
    for (const m of this.ringMats) m.setTime(this.waterTime);
    this.water.setTime(this.waterTime);
    this.waterMap.evict(playerX, playerZ);
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
    const groundY = this.visibleGround(x, z, this.groundHeight(x, z));
    const offRoad: SurfaceSample = {
      roadFactor: 0.35,
      height: groundY,
      grip: effectiveGrip(defaultAsphaltProfile(), 0.35, this.weather) * 0.85,
      noise: 0.2,
      label: 'Off-road',
      kind: 'dirt',
    };
    if (!Number.isFinite(x) || !Number.isFinite(z)) return offRoad;
    // v1.3.4: lake / sea / river → 'Water': almost no traction, the car wades
    // (Game adds drag, a splash and a reset to the last dry road point).
    const wet = (): SurfaceSample => {
      const wi = this.waterInfo(x, z, groundY);
      if (!wi) return offRoad;
      return { roadFactor: 0, height: wi.y, grip: 0.1, noise: 0.05, label: 'Water', kind: 'water' };
    };

    const near = this.roadIndex.nearest(x, z, ROAD_HEIGHT_RADIUS + 8, undefined, preferY);
    if (!near) return wet();
    const line = near.line;
    // A tunnel only counts once you're actually down at its level (through the portal)
    if (line.structure === 'tunnel' && (preferY === undefined || Math.abs(near.y - preferY) > 3)) {
      return wet();
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

    // Off the asphalt (and not on a bridge deck): water wins over dirt
    if (roadFactor <= 0.5 && !(line.structure !== 'ground' && dist <= half + 1.5)) {
      const w = wet();
      if (w.kind === 'water') return w;
    }
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
    // v1.3.2 P3: spatial index first (snaps onto the segment, not just a vertex)
    const hit = this.roadIndex.nearest(x, z, 600, (l) => l.structure === 'ground');
    if (hit && Number.isFinite(hit.y)) return { x: hit.x, z: hit.z, y: hit.y };
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
        await this.applyTileFallback(entry, heightAt);
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

      // v1.3.3 water + landuse polygons (cheap: rasterised once, shared by all rings)
      this.addAreas(result.areas ?? []);
      if (result.relationIds?.length) {
        void this.client
          .fetchRelations(result.relationIds, gen)
          .then((rels) => {
            if (!this.disposed && gen === this.fetchGen) this.addAreas(rels);
          })
          .catch(() => {
            /* water relations are optional */
          });
      }

      if (freshWays.length === 0 && this.tileMostlyWater(b)) {
        // v1.3.3: OSM answered and the tile is open water (SF Bay, Lake
        // Ontario): no offline grid roads floating on the water.
      } else if (freshWays.length === 0) {
        await this.applyTileFallback(entry, heightAt);
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
        this.collectFootprints(entry);
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
      await this.applyTileFallback(entry, heightAt);
      this.emitStatus(`Using offline roads (Overpass slow) · tile ${key}`);
    } finally {
      this.finishLoading(key);
    }
  }

  private finishLoading(key: string): void {
    const current = this.tiles.get(key);
    if (current) current.loading = false;
  }

  private async applyTileFallback(
    entry: TileEntry,
    heightAt: (lat: number, lon: number) => number,
  ): Promise<void> {
    if (entry.cancelled || this.disposed) return;
    this.usedOfflineFallback = true;
    entry.usedFallback = true;
    const ways = this.maskWaysAgainstWater(this.makeGridWaysForTile(entry.tx, entry.ty));
    entry.ways = ways;
    entry.buildings = [];
    // Offline tiles have no OSM footprints — seed block-fill buildings
    entry.fillCount = 160;
    entry.fillSeed = entry.tx * 997 + entry.ty * 131 + 7;
    const before = this.provisionalSamples;
    void heightAt;
    // P3: yields between ways so a 5×5 offline grid doesn't stall the frame
    const fixed = ways.map((w) => (w.tags.surface ? w : { ...w, tags: { ...w.tags, surface: 'asphalt' } }));
    const { group, centerlines } = await this.builder.buildWaysAsync(fixed, this.profileEnv());
    if (entry.cancelled || this.disposed) {
      disposeGroup(group);
      return;
    }
    entry.centerlines = centerlines;
    this.roadIndex.add(centerlines);
    entry.group.add(group);
    const fill = this.buildings.buildFillers(centerlines, this.origin, this.groundAtFn(), {
      maxCount: entry.fillCount,
      seed: entry.fillSeed,
    });
    entry.group.add(fill);
    this.collectFootprints(entry);
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
    const waterVersion = this.areaVersion();
    // v1.3.4: keep vertices off the lake / sea plane so the shore band can't z-fight
    const offPlane = (y: number): number => this.offPlane(y);
    const heightAt = (wx: number, wz: number): RingSample => {
      const dem = this.applyWater(wx, wz, this.ringDem(index, wx, wz));
      const a = this.areaTmp;
      const water = a.water;
      const park = a.park;
      const forest = a.forest;
      const farm = a.farm;
      if (index === 0) {
        const c = this.carveAt(wx, wz, dem, cell);
        return { y: offPlane(c.y), verge: c.verge * (1 - Math.min(1, water * 2)), water, park, forest, farm };
      }
      return { y: offPlane(dem), verge: 0, water, park, forest, farm };
    };
    const ok = await ring.build(c.x, c.z, heightAt, () => this.disposed);
    if (!ok || this.disposed) return;
    ring.provisional = this.provisionalSamples > provBefore;
    ring.roadVersion = roadVersion;
    this.ringWaterVersion[index] = waterVersion;
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
      // New lakes / parks streamed in (throttled like the road re-carve)
      if (
        !want &&
        this.ringWaterVersion[i] !== this.areaVersion() &&
        now - ring.lastBuildAt > CARVE_REBUILD_MS * (i + 1)
      ) {
        want = true;
      }
      if (want) {
        const cx = i === 0 ? px : px;
        void this.rebuildRing(i, cx, pz);
      }
    }
  }

  /** Water polygons + shore mask version (rings re-sample when it changes). */
  private areaVersion(): string {
    return `${this.waterMap.version}:${this.shore.version}`;
  }

  /** DEM class for the shore mask (fine z14, z12 stand-in; 3 = no DEM yet). */
  private shoreClass = (x: number, z: number): ShoreClass => {
    const ll = this.origin.toLatLon(x, z);
    let v = this.elevation.sampleRelative(ll.lat, ll.lon);
    if (v === null) {
      v = this.midElevation.sampleRelative(ll.lat, ll.lon);
      this.shoreClassProv = true;
    }
    if (v === null) return 3;
    const d = v - this.seaRel;
    return d < LAKE_FLAT_M ? 1 : d < LAKE_NOISE_M ? 2 : 0;
  };

  /** v1.3.5: bundled OSM outline when the whole shore window is inside its coverage. */
  private bundledLinesFor(cx: number, cz: number): ShoreLines | null {
    const b = this.bundled;
    if (!b) return null;
    const a = this.origin.toLatLon(cx - SHORE_HALF_M, cz - SHORE_HALF_M);
    const c = this.origin.toLatLon(cx + SHORE_HALF_M, cz + SHORE_HALF_M);
    if (!bundledCovers(b, Math.min(a.lat, c.lat), Math.min(a.lon, c.lon), Math.max(a.lat, c.lat), Math.max(a.lon, c.lon))) {
      return null;
    }
    if (!this.bundledLines) this.bundledLines = bundledShoreLines(b, (lat, lon) => this.origin.toLocal(lat, lon));
    return this.bundledLines;
  }

  private shoreLinesFor(cx: number, cz: number): ShoreLines | null {
    const c = this.shoreLines;
    if (!c) return null;
    if (cx - SHORE_HALF_M < c.minX || cx + SHORE_HALF_M > c.maxX || cz - SHORE_HALF_M < c.minZ || cz + SHORE_HALF_M > c.maxZ) {
      return null;
    }
    return c.lines;
  }

  /** (Re)build the near-camera shore mask around (px, pz); fetch OSM shore lines in the background. */
  private async refreshShore(px: number, pz: number): Promise<void> {
    if (!this.lakeMode || this.shore.building || this.disposed) return;
    this.shore.building = true;
    this.shoreStale = false;
    try {
      const cx = Math.round(px / 25) * 25;
      const cz = Math.round(pz / 25) * 25;
      const a = this.origin.toLatLon(cx - SHORE_HALF_M, cz - SHORE_HALF_M);
      const b = this.origin.toLatLon(cx + SHORE_HALF_M, cz + SHORE_HALF_M);
      await this.elevation.preloadArea(
        Math.min(a.lat, b.lat),
        Math.min(a.lon, b.lon),
        Math.max(a.lat, b.lat),
        Math.max(a.lon, b.lon),
        6_000,
      );
      if (this.disposed) return;
      const bundled = this.bundledLinesFor(cx, cz);
      const lines = bundled ?? this.shoreLinesFor(cx, cz);
      this.shoreClassProv = false;
      const built = await this.shore.build(cx, cz, this.shoreClass, lines, () => this.disposed);
      if (built) {
        this.shoreProvisional = bundled ? false : this.shoreClassProv;
        this.shoreSource = bundled ? 'bundled' : this.shore.osm ? 'overpass' : 'dem';
      }
      if (!lines && !this.forceOffline) void this.fetchShoreLines(cx, cz);
    } finally {
      this.shore.building = false;
    }
  }

  private async fetchShoreLines(cx: number, cz: number): Promise<void> {
    if (this.shoreFetching || this.disposed || performance.now() < this.shoreFetchRetryAt) return;
    this.shoreFetching = true;
    const r = SHORE_HALF_M + SHORE_FETCH_PAD_M;
    const a = this.origin.toLatLon(cx - r, cz - r);
    const b = this.origin.toLatLon(cx + r, cz + r);
    const gen = this.fetchGen;
    try {
      const res = await this.client.fetchShore(
        Math.min(a.lat, b.lat),
        Math.min(a.lon, b.lon),
        Math.max(a.lat, b.lat),
        Math.max(a.lon, b.lon),
        gen,
      );
      if (this.disposed || gen !== this.fetchGen) return;
      const loc = (g: OsmNode[]) => g.map((n) => this.origin.toLocal(n.lat, n.lon));
      this.shoreLines = {
        minX: cx - r,
        minZ: cz - r,
        maxX: cx + r,
        maxZ: cz + r,
        lines: { barriers: res.barriers.map(loc), landAreas: res.landAreas.map(loc), landLines: res.landLines.map(loc) },
      };
      this.shoreStale = true;
      this.emitStatus(`OSM shoreline: ${res.barriers.length} water edges, ${res.landAreas.length + res.landLines.length} piers`);
    } catch {
      // Overpass down: keep the DEM mask, try again later
      this.shoreFetchRetryAt = performance.now() + 30_000;
    } finally {
      this.shoreFetching = false;
    }
  }

  /** Shore-mask stats for QA (`__nig.game.tiles.shoreInfo()`). */
  shoreInfo(): {
    ready: boolean;
    osm: boolean;
    source: 'none' | 'bundled' | 'overpass' | 'dem';
    provisional: boolean;
    centerX: number;
    centerZ: number;
    version: number;
  } {
    return {
      ready: this.shore.ready,
      osm: this.shore.osm,
      source: this.shoreSource,
      provisional: this.shoreProvisional,
      centerX: this.shore.centerX,
      centerZ: this.shore.centerZ,
      version: this.shore.version,
    };
  }

  /**
   * v1.3.4 P4: offline grid ways are cut per ~6 m against water (lake, sea,
   * OSM water) so no fallback road deck runs across open water; dry runs
   * shorter than 12 m are dropped.
   */
  private maskWaysAgainstWater(ways: OsmWay[]): OsmWay[] {
    if (this.seaRel < -1e5 && !this.waterMap.size) return ways;
    const out: OsmWay[] = [];
    for (const w of ways) {
      const g = w.geometry;
      if (g.length < 2) continue;
      const pa = this.origin.toLocal(g[0].lat, g[0].lon);
      const pb = this.origin.toLocal(g[g.length - 1].lat, g[g.length - 1].lon);
      const len = Math.hypot(pb.x - pa.x, pb.z - pa.z);
      if (!(len > 1)) continue;
      const n = Math.max(2, Math.ceil(len / 6));
      const nx = -(pb.z - pa.z) / len;
      const nz = (pb.x - pa.x) / len;
      const dry: boolean[] = [];
      for (let k = 0; k <= n; k++) {
        const x = pa.x + ((pb.x - pa.x) * k) / n;
        const z = pa.z + ((pb.z - pa.z) * k) / n;
        dry.push(
          !this.isWaterLocal(x, z) && !this.isWaterLocal(x + nx * 6, z + nz * 6) && !this.isWaterLocal(x - nx * 6, z - nz * 6),
        );
      }
      if (dry.every(Boolean)) {
        out.push(w);
        continue;
      }
      let run = 0;
      let k0 = -1;
      for (let k = 0; k <= n + 1; k++) {
        if (k <= n && dry[k]) {
          if (k0 < 0) k0 = k;
          continue;
        }
        if (k0 >= 0 && ((k - 1 - k0) * len) / n >= 12) {
          const t0 = k0 / n;
          const t1 = (k - 1) / n;
          const lerp = (t: number) => ({
            lat: g[0].lat + (g[g.length - 1].lat - g[0].lat) * t,
            lon: g[0].lon + (g[g.length - 1].lon - g[0].lon) * t,
          });
          out.push({ id: w.id * 16 + run++, tags: w.tags, geometry: [lerp(t0), lerp(t1)] });
        }
        k0 = -1;
      }
    }
    return out;
  }

  private collectFootprints(entry: TileEntry): void {
    const fps: Footprint[] = [];
    entry.group.traverse((o) => {
      const f = o.userData.footprints as Footprint[] | undefined;
      if (f) fps.push(...f);
    });
    entry.footprints = fps;
  }

  /**
   * v1.3.4 P2: building push-out. Returns the displacement + outward normal
   * that moves a car of radius `r` at (x, z) out of the nearest solid
   * footprint, or null. OSM buildings only collide off-road (some OSM
   * footprints overlap carriageways); procedural fillers always do.
   */
  pushOutOfBuildings(x: number, z: number, r: number, onRoad: boolean): { dx: number; dz: number; nx: number; nz: number } | null {
    const ll = this.origin.toLatLon(x, z);
    const { tx, ty } = latLonToTile(ll.lat, ll.lon);
    let best: { dx: number; dz: number; nx: number; nz: number; d: number } | null = null;
    for (const e of this.tiles.values()) {
      if (e.key !== 'fallback' && Math.max(Math.abs(e.tx - tx), Math.abs(e.ty - ty)) > 1) continue;
      if (!e.footprints) continue;
      for (const f of e.footprints) {
        if (x < f.minX - r || x > f.maxX + r || z < f.minZ - r || z > f.maxZ + r) continue;
        if (onRoad && !f.always) continue;
        const pts = f.pts;
        let inside = false;
        let qd = Infinity;
        let qx = 0;
        let qz = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const a = pts[j];
          const b = pts[i];
          if ((b.z > z) !== (a.z > z) && x < ((a.x - b.x) * (z - b.z)) / (a.z - b.z) + b.x) inside = !inside;
          const abx = b.x - a.x;
          const abz = b.z - a.z;
          const l2 = abx * abx + abz * abz;
          let t = l2 > 1e-9 ? ((x - a.x) * abx + (z - a.z) * abz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = a.x + abx * t;
          const pz = a.z + abz * t;
          const d = (x - px) ** 2 + (z - pz) ** 2;
          if (d < qd) {
            qd = d;
            qx = px;
            qz = pz;
          }
        }
        const dist = Math.sqrt(qd);
        if (!inside && dist >= r) continue;
        let nx: number;
        let nz: number;
        if (dist < 1e-4) {
          nx = 1;
          nz = 0;
        } else if (inside) {
          nx = (qx - x) / dist;
          nz = (qz - z) / dist;
        } else {
          nx = (x - qx) / dist;
          nz = (z - qz) / dist;
        }
        const push = inside ? dist + r : r - dist;
        const cand = { dx: nx * push, dz: nz * push, nx, nz, d: push };
        if (!best || cand.d > best.d) best = cand;
      }
    }
    return best ? { dx: best.dx, dz: best.dz, nx: best.nx, nz: best.nz } : null;
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
      const dem = this.applyWater(p.x, p.z, this.demHeight(lat, lon));
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
      const bldg = await this.buildings.buildAsync(
        entry.buildings,
        this.origin,
        heightAt,
        () => this.disposed || entry.cancelled,
      );
      group.add(bldg);
      buildingCount += (bldg.userData.count as number | undefined) ?? 0;
    }
    if (entry.fillCount > 0) {
      const fill = this.buildings.buildFillers(centerlines, this.origin, heightAt, {
        maxCount: entry.fillCount,
        seed: entry.fillSeed,
      });
      group.add(fill);
      buildingCount += (fill.userData.count as number | undefined) ?? 0;
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
    if (this.waterMap.hasProvisional) this.waterMap.refreshLevels((r) => this.lakeLevel(r));
    if (this.shoreProvisional) {
      const a = this.origin.toLatLon(this.shore.centerX - SHORE_HALF_M, this.shore.centerZ - SHORE_HALF_M);
      const b = this.origin.toLatLon(this.shore.centerX + SHORE_HALF_M, this.shore.centerZ + SHORE_HALF_M);
      if (this.elevation.isAreaLoaded(Math.min(a.lat, b.lat), Math.min(a.lon, b.lon), Math.max(a.lat, b.lat), Math.max(a.lon, b.lon))) {
        this.shoreProvisional = false;
        this.shoreStale = true;
      }
    }

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
      this.collectFootprints(entry);
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
        ways.push(...this.maskWaysAgainstWater(this.makeGridWaysForTile(tx + dx, ty + dy)));
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
    const fbEntry: TileEntry = {
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
    };
    this.collectFootprints(fbEntry);
    this.tiles.set('fallback', fbEntry);
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
    this.waterMap.clear();
    this.roadIndex.clear();
    this.junctionRegistry.clear();
    this.scene.remove(this.ground);
    this.ground.geometry.dispose();
    this.groundMat.map?.dispose();
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

/** v1.3.3: OSM area tags → raster class (null = not drawn). */
function areaClass(t: Record<string, string>): AreaClass | null {
  if (isWaterTags(t)) {
    const w = t.water ?? '';
    if (t.waterway === 'riverbank' || w === 'river' || w === 'canal' || w === 'stream' || w === 'rapids') return 'river';
    return 'lake';
  }
  if (t.landuse === 'forest' || t.natural === 'wood' || t.natural === 'scrub') return 'forest';
  if (t.landuse === 'farmland' || t.landuse === 'meadow') return 'farm';
  if (
    t.leisure === 'park' ||
    t.leisure === 'golf_course' ||
    t.landuse === 'recreation_ground' ||
    t.landuse === 'cemetery' ||
    t.landuse === 'village_green'
  )
    return 'park';
  return null;
}

/**
 * Great Lakes: Terrarium stores them as flat surfaces at their mean level, so
 * a lake-level water plane + sinking that flat surface draws them as water
 * (OSM's Lake Ontario multipolygon is far too big to fetch per tile).
 */
const LAKE_FLAT_M = 0.35;
const LAKE_NOISE_M = 1.4;
const LAKE_PROBE_R = [45, 110];

const GREAT_LAKES = [
  { name: 'Ontario', s: 43.15, w: -79.95, n: 44.3, e: -76.0, level: 74.8 },
  { name: 'Erie', s: 41.35, w: -83.55, n: 42.95, e: -78.85, level: 173.8 },
  { name: 'Michigan-Huron', s: 41.6, w: -88.1, n: 46.4, e: -79.6, level: 175.2 },
  { name: 'Superior', s: 46.3, w: -92.2, n: 49.1, e: -84.3, level: 183.4 },
];

function greatLakeAt(lat: number, lon: number, originAbs: number): { name: string; level: number } | null {
  for (const l of GREAT_LAKES) {
    if (lat < l.s || lat > l.n || lon < l.w || lon > l.e) continue;
    // Only near the shore (inland cities in the bbox, e.g. KW, keep the sea logic)
    if (originAbs - l.level < 120) return l;
  }
  return null;
}
