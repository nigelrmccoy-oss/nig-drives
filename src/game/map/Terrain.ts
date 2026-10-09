import * as THREE from 'three';

/**
 * v1.3.2 terrain: three nested heightfield rings that follow the player.
 *
 *  near  ~1.2 km square, ~6 m cells, carved to the road corridors (cut/fill)
 *  mid   ~4.8 km, ~30 m cells (z12 DEM)
 *  far   ~16 km (±8 km), ~125 m cells (z11 DEM) — distant hills and skyline
 *
 * Each outer ring is pushed down inside the next-inner ring's footprint in its
 * vertex shader (see TerrainMaterial: uInner), so the rings can recentre
 * independently without rebuilding each other. Grids snap to a multiple of
 * their cell size so recentring doesn't make the surface swim, and builds are
 * time-sliced across frames (a few ms per slice).
 */

export interface RingConfig {
  name: string;
  size: number;
  res: number;
  /** Recentre when the player is this far from the ring centre. */
  recenter: number;
  /** Skirt depth (m) to hide steps at the ring edge. */
  skirt: number;
  /** Uses the road corridor carve (near ring only). */
  carve: boolean;
}

export interface RingSample {
  y: number;
  /** 0..1 gravel/dirt verge factor next to roads. */
  verge: number;
}

export type RingHeightFn = (x: number, z: number) => RingSample;

export class TerrainRing {
  readonly cfg: RingConfig;
  readonly mesh: THREE.Mesh;
  centerX = Number.NaN;
  centerZ = Number.NaN;
  building = false;
  builtOnce = false;
  /** True if the last build used any non-final DEM heights. */
  provisional = false;
  /** RoadIndex version the last (near) build carved against. */
  roadVersion = -1;
  lastBuildAt = 0;
  private generation = 0;

  constructor(cfg: RingConfig, material: THREE.Material) {
    this.cfg = cfg;
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.name = `terrain-${cfg.name}`;
    this.mesh.receiveShadow = cfg.carve;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  get cell(): number {
    return this.cfg.size / this.cfg.res;
  }

  snapCenter(x: number, z: number): { x: number; z: number } {
    const snap = this.cell * 4;
    return { x: Math.round(x / snap) * snap, z: Math.round(z / snap) * snap };
  }

  needsRecentre(px: number, pz: number): boolean {
    if (!Number.isFinite(this.centerX)) return true;
    const dx = px - this.centerX;
    const dz = pz - this.centerZ;
    return dx * dx + dz * dz > this.cfg.recenter * this.cfg.recenter;
  }

  /**
   * Rebuild the heightfield around (cx, cz). `heightAt` returns world-relative
   * heights. Yields to the event loop whenever a slice exceeds `sliceMs`.
   * Returns false if superseded or cancelled.
   */
  async build(
    cx: number,
    cz: number,
    heightAt: RingHeightFn,
    isCancelled: () => boolean,
    sliceMs = 4,
  ): Promise<boolean> {
    const gen = ++this.generation;
    this.building = true;
    try {
      const { res, size, skirt } = this.cfg;
      const n = res + 1;
      const cell = size / res;
      const half = size / 2;
      const heights = new Float32Array(n * n);
      const verge = new Float32Array(n * n);
      let t0 = performance.now();
      for (let j = 0; j < n; j++) {
        const z = cz - half + j * cell;
        for (let i = 0; i < n; i++) {
          const x = cx - half + i * cell;
          const s = heightAt(x, z);
          heights[j * n + i] = Number.isFinite(s.y) ? s.y : 0;
          verge[j * n + i] = s.verge;
        }
        if (performance.now() - t0 > sliceMs) {
          await nextSlice();
          if (gen !== this.generation || isCancelled()) return false;
          t0 = performance.now();
        }
      }

      // --- geometry: grid + inward-facing skirt ---------------------------------
      const gridVerts = n * n;
      const skirtVerts = res * 4;
      const total = gridVerts + skirtVerts;
      const pos = new Float32Array(total * 3);
      const nor = new Float32Array(total * 3);
      const col = new Float32Array(total * 3);
      const splat = new Float32Array(total * 2);

      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const k = j * n + i;
          const y = heights[k];
          pos[k * 3] = -half + i * cell;
          pos[k * 3 + 1] = y;
          pos[k * 3 + 2] = -half + j * cell;
          // Central-difference normal from the heightfield (no pillow creases)
          const yl = heights[j * n + Math.max(0, i - 1)];
          const yr = heights[j * n + Math.min(res, i + 1)];
          const yd = heights[Math.max(0, j - 1) * n + i];
          const yu = heights[Math.min(res, j + 1) * n + i];
          const sx = (i > 0 && i < res ? 2 : 1) * cell;
          const sz = (j > 0 && j < res ? 2 : 1) * cell;
          let nx = -(yr - yl) / sx;
          let nz = -(yu - yd) / sz;
          let ny = 1;
          const inv = 1 / Math.hypot(nx, ny, nz);
          nx *= inv;
          ny *= inv;
          nz *= inv;
          nor[k * 3] = nx;
          nor[k * 3 + 1] = ny;
          nor[k * 3 + 2] = nz;
          // Curvature (convex crest > 0, hollow < 0), scaled to ~±1
          const lap = y - (yl + yr + yd + yu) * 0.25;
          const curv = Math.max(-1, Math.min(1, (lap / cell) * 6));
          splat[k * 2] = verge[k];
          splat[k * 2 + 1] = curv;
          // Fallback vertex colour (used until/unless photo textures load):
          // slope → earth, hollows a touch darker (cheap AO), crests drier.
          const slope = 1 - ny;
          const wx = cx + pos[k * 3];
          const wz = cz + pos[k * 3 + 2];
          const nse =
            Math.sin(wx * 0.021 + wz * 0.017) * 0.5 + Math.sin(wx * 0.007 - wz * 0.011) * 0.5;
          const t = 0.5 + nse * 0.18;
          const ao = 1 + Math.min(0, curv) * 0.25;
          const rock = Math.min(1, Math.max(0, (slope - 0.18) * 4));
          const r = (0.3 + t * 0.16) * (1 - rock) + 0.42 * rock;
          const g = (0.38 + t * 0.15) * (1 - rock) + 0.38 * rock;
          const b = (0.2 + t * 0.07) * (1 - rock) + 0.33 * rock;
          col[k * 3] = r * ao;
          col[k * 3 + 1] = g * ao;
          col[k * 3 + 2] = b * ao;
        }
      }

      // Skirt ring: walk the border clockwise; each border vertex gets a twin below.
      const border: number[] = [];
      for (let i = 0; i < res; i++) border.push(i); // top row (j=0)
      for (let j = 0; j < res; j++) border.push(j * n + res); // right col
      for (let i = res; i > 0; i--) border.push(res * n + i); // bottom row
      for (let j = res; j > 0; j--) border.push(j * n); // left col
      for (let b = 0; b < border.length; b++) {
        const src = border[b];
        const k = gridVerts + b;
        pos[k * 3] = pos[src * 3];
        pos[k * 3 + 1] = pos[src * 3 + 1] - skirt;
        pos[k * 3 + 2] = pos[src * 3 + 2];
        nor[k * 3 + 1] = 1;
        col[k * 3] = col[src * 3] * 0.8;
        col[k * 3 + 1] = col[src * 3 + 1] * 0.8;
        col[k * 3 + 2] = col[src * 3 + 2] * 0.8;
      }

      const idxCount = res * res * 6 + border.length * 6;
      const index = total > 65535 ? new Uint32Array(idxCount) : new Uint16Array(idxCount);
      let w = 0;
      for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) {
          const a = j * n + i;
          const b = a + 1;
          const c = a + n;
          const d = c + 1;
          // CCW seen from +Y (X east, Z south)
          index[w++] = a;
          index[w++] = c;
          index[w++] = b;
          index[w++] = b;
          index[w++] = c;
          index[w++] = d;
        }
      }
      for (let b = 0; b < border.length; b++) {
        const top0 = border[b];
        const top1 = border[(b + 1) % border.length];
        const bot0 = gridVerts + b;
        const bot1 = gridVerts + ((b + 1) % border.length);
        // Face inward (towards the ring centre, where the camera always is)
        index[w++] = top0;
        index[w++] = bot0;
        index[w++] = top1;
        index[w++] = top1;
        index[w++] = bot0;
        index[w++] = bot1;
      }

      if (gen !== this.generation || isCancelled()) return false;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 2));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), size);

      const old = this.mesh.geometry;
      this.mesh.geometry = geo;
      old.dispose();
      this.mesh.position.set(cx, 0, cz);
      this.mesh.visible = true;
      this.centerX = cx;
      this.centerZ = cz;
      this.builtOnce = true;
      this.lastBuildAt = performance.now();
      return true;
    } finally {
      if (gen === this.generation) this.building = false;
    }
  }

  dispose(): void {
    this.generation++;
    this.mesh.geometry.dispose();
  }
}

function nextSlice(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Sea-level water plane (SF Bay etc.). Terrarium has bathymetry; terrain is clamped under it. */
export class WaterPlane {
  readonly mesh: THREE.Mesh;
  private mat: THREE.MeshStandardMaterial;

  constructor() {
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x24465a,
      roughness: 0.12,
      metalness: 0.05,
      envMapIntensity: 0.9,
      polygonOffset: true,
      polygonOffsetFactor: 4,
      polygonOffsetUnits: 4,
    });
    const geo = new THREE.PlaneGeometry(24000, 24000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'water-sea-level';
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
  }

  get material(): THREE.MeshStandardMaterial {
    return this.mat;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
