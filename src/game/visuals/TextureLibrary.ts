import * as THREE from 'three';
import type { QualitySettings } from './Quality';
import { FACADE_LAYERS } from './BuildingMaterial';

/**
 * v1.3.2 photo textures (CC0, Poly Haven — see public/textures/CREDITS.md).
 * Terrain layers go into DataArrayTextures (one sampler per map type) so the
 * splat shader needs only 3 texture units; road sets are plain 2D textures.
 * Everything is optional: until (or unless) loading succeeds the game keeps
 * its procedural canvas textures / vertex colours.
 */
export const TERRAIN_LAYERS = ['grass', 'dirt', 'rock', 'snow'] as const;
export type RoadSetName = 'asphalt' | 'concrete' | 'paving' | 'gravel' | 'dirt';
const ROAD_SETS: RoadSetName[] = ['asphalt', 'concrete', 'paving', 'gravel', 'dirt'];

export interface RoadTextureSet {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  arm: THREE.Texture;
}

export interface TerrainArrays {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  arm: THREE.DataArrayTexture;
}

function base(): string {
  const b = (import.meta.env?.BASE_URL as string | undefined) ?? './';
  return b.endsWith('/') ? b : `${b}/`;
}

async function fetchBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  // Flip so image-top lands at v = 1 (GL convention), matching TextureLoader + nor_gl maps
  return createImageBitmap(blob, {
    imageOrientation: 'flipY',
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
}

export class TextureLibrary {
  private roads = new Map<RoadSetName, RoadTextureSet>();
  private terrain: TerrainArrays | null = null;
  private loading: Promise<boolean> | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  private q: QualitySettings;
  private loadedSplatSize = 0;
  /** v1.3.3 building facades + roofs (CC0 ambientCG), 512 px on every quality. */
  private facades: THREE.DataArrayTexture | null = null;

  constructor(quality: QualitySettings) {
    this.q = quality;
  }

  get ready(): boolean {
    return this.terrain !== null;
  }

  get quality(): QualitySettings {
    return this.q;
  }

  getRoadSet(name: RoadSetName): RoadTextureSet | null {
    return this.roads.get(name) ?? null;
  }

  getBuildingFacades(): THREE.DataArrayTexture | null {
    return this.facades;
  }

  getTerrain(): TerrainArrays | null {
    return this.terrain;
  }

  /** Called once textures are ready (immediately if they already are). Returns unsubscribe. */
  onReady(cb: () => void): () => void {
    if (this.ready) cb();
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Changing quality re-uploads the terrain arrays at the new size if needed. */
  setQuality(q: QualitySettings): void {
    this.q = q;
    for (const set of this.roads.values()) {
      for (const t of [set.albedo, set.normal, set.arm]) {
        t.anisotropy = q.anisotropy;
        t.needsUpdate = true;
      }
    }
    if (this.terrain && this.loadedSplatSize !== q.splatSize) {
      this.loading = null;
      void this.load();
    }
  }

  load(): Promise<boolean> {
    if (this.loading) return this.loading;
    this.loading = this.doLoad().catch((err) => {
      console.warn('Photo textures unavailable — keeping procedural look', err);
      return false;
    });
    return this.loading;
  }

  private async doLoad(): Promise<boolean> {
    const root = `${base()}textures/`;
    const kinds = ['albedo', 'normal', 'arm'] as const;
    // Road sets first (closest to the camera)
    if (this.roads.size === 0) {
      await Promise.all(
        ROAD_SETS.map(async (name) => {
          const [albedo, normal, arm] = await Promise.all(
            kinds.map((k) => fetchBitmap(`${root}${name}/${k}.webp`)),
          );
          if (this.disposed) return;
          this.roads.set(name, {
            albedo: this.make2D(albedo, true),
            normal: this.make2D(normal, false),
            arm: this.make2D(arm, false),
          });
        }),
      );
    }
    if (this.disposed) return false;

    if (!this.facades) {
      try {
        const bitmaps = await Promise.all(
          FACADE_LAYERS.map((layer) => fetchBitmap(`${root}buildings/${layer}.webp`)),
        );
        if (this.disposed) return false;
        this.facades = packArray(bitmaps, 512, true, this.q.anisotropy);
        for (const b of bitmaps) b.close();
      } catch (err) {
        console.warn('Building facades unavailable — plain tinted walls', err);
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    // Terrain arrays: decode → resize → pack layers
    const size = this.q.splatSize;
    const arrays: Partial<TerrainArrays> = {};
    for (const k of kinds) {
      const bitmaps = await Promise.all(
        TERRAIN_LAYERS.map((layer) => fetchBitmap(`${root}${layer}/${k}.webp`)),
      );
      if (this.disposed) return false;
      arrays[k] = packArray(bitmaps, size, k === 'albedo', this.q.anisotropy);
      for (const b of bitmaps) b.close();
      await new Promise((r) => setTimeout(r, 0));
    }
    const old = this.terrain;
    this.terrain = arrays as TerrainArrays;
    this.loadedSplatSize = size;
    if (old) for (const t of Object.values(old)) t.dispose();
    for (const cb of this.listeners) cb();
    return true;
  }

  private make2D(bmp: ImageBitmap, srgb: boolean): THREE.Texture {
    const t = new THREE.Texture(bmp as unknown as HTMLImageElement);
    t.flipY = false; // already flipped at decode
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = this.q.anisotropy;
    t.needsUpdate = true;
    return t;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    for (const set of this.roads.values()) {
      for (const t of [set.albedo, set.normal, set.arm]) {
        (t.image as ImageBitmap | undefined)?.close?.();
        t.dispose();
      }
    }
    this.roads.clear();
    if (this.terrain) for (const t of Object.values(this.terrain)) t.dispose();
    this.terrain = null;
    this.facades?.dispose();
    this.facades = null;
  }
}

function packArray(
  bitmaps: ImageBitmap[],
  size: number,
  srgb: boolean,
  anisotropy: number,
): THREE.DataArrayTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const layerBytes = size * size * 4;
  const data = new Uint8Array(layerBytes * bitmaps.length);
  bitmaps.forEach((bmp, i) => {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(bmp, 0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size).data;
    // getImageData row 0 = canvas top; data arrays upload row 0 at v = 0.
    // The bitmap is already flipped, so copying straight keeps image-top at v = 1.
    data.set(img, i * layerBytes);
  });
  const tex = new THREE.DataArrayTexture(data, size, size, bitmaps.length);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}
