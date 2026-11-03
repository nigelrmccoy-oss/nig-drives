import * as THREE from 'three';
import type { GeoOrigin } from './geo';

/**
 * v1.5.0b optional satellite imagery for the near terrain ring.
 *
 * Source: Bing Maps *Aerial* (no labels) resolved through Cesium ion asset 2, which needs
 * `VITE_CESIUM_ION_TOKEN`. Without a token (or on any failure) nothing happens and the ground keeps
 * its procedural photo-texture look. The style is verified to be plain "Aerial" - a labelled style
 * (street names) is refused. Attribution text comes from ion + Bing and is shown in the HUD badge.
 *
 * A window of 7 x 7 Web-Mercator tiles (zoom 17, ~0.87 m/px at 43 N, ~1.5 km square) is stitched into one
 * texture; the shader maps world x/z to it with an affine transform (the window is < 2 km, so the
 * Mercator curvature error is centimetres). The window is rebuilt when the car drifts 350 m off centre.
 */
const ION_ASSET = 2;
const ZOOM = 17;
const N = 7; // tiles per side
const TS = 256;
const REBUILD_M = 350;

interface BingMeta {
  template: string;
  subdomains: string[];
  copyright: string;
}

export interface SatUniforms {
  uSat: { value: THREE.Texture | null };
  /** (a0, a1, b0, b1): u = a0 + a1 * x, v = b0 + b1 * z. */
  uSatA: { value: THREE.Vector4 };
  /** x = mix strength (0 = off). */
  uSatMix: { value: number };
}

export function createSatUniforms(): SatUniforms {
  return { uSat: { value: null }, uSatA: { value: new THREE.Vector4() }, uSatMix: { value: 0 } };
}

function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}
function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
function quadkey(x: number, y: number, z: number): string {
  let q = '';
  for (let i = z; i > 0; i--) {
    const m = 1 << (i - 1);
    q += ((x & m ? 1 : 0) + (y & m ? 2 : 0)).toString();
  }
  return q;
}

export class SatelliteImagery {
  readonly uniforms = createSatUniforms();
  enabled = false;
  available = false;
  attribution = '';
  private meta: BingMeta | null = null;
  private origin: GeoOrigin | null = null;
  private cx = Number.NaN;
  private cz = Number.NaN;
  private building = false;
  private tiles = new Map<string, Promise<HTMLImageElement | null>>();
  private onChange: (() => void) | null = null;
  private disposed = false;

  static token(): string | null {
    const t = (import.meta.env?.VITE_CESIUM_ION_TOKEN as string | undefined)?.trim();
    return t ? t : null;
  }

  setOnChange(fn: () => void): void {
    this.onChange = fn;
  }

  /** Resolve the imagery endpoint. Resolves false (and stays off) when there is no key or it fails. */
  async init(origin: GeoOrigin): Promise<boolean> {
    this.origin = origin;
    const token = SatelliteImagery.token();
    if (!token) return false;
    try {
      const ep = await (await fetch(`https://api.cesium.com/v1/assets/${ION_ASSET}/endpoint?access_token=${encodeURIComponent(token)}`)).json();
      const o = ep?.options;
      if (ep?.externalType !== 'BING' || !o?.key || !/^aerial$/i.test(String(o.mapStyle))) return false; // never a labelled style
      const m = await (
        await fetch(`${o.url}/REST/v1/Imagery/Metadata/Aerial?incl=ImageryProviders&uriScheme=https&key=${encodeURIComponent(o.key)}`)
      ).json();
      const r = m?.resourceSets?.[0]?.resources?.[0];
      if (!r?.imageUrl || !Array.isArray(r.imageUrlSubdomains)) return false;
      const ion = (ep.attributions ?? [])
        .map((a: { html?: string }) => (a.html ?? '').replace(/<[^>]*>/g, '').trim())
        .filter((s: string) => s && !/upgrade for commercial/i.test(s));
      this.meta = {
        template: String(r.imageUrl).replace('{culture}', 'en-US'),
        subdomains: r.imageUrlSubdomains,
        copyright: String(m.copyright ?? '© Microsoft'),
      };
      this.attribution = `Imagery ${this.meta.copyright} · Bing Maps Aerial via Cesium ion${ion.length ? ' · ' + ion.join(' ') : ''}`;
      this.available = true;
      return true;
    } catch {
      return false;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on && this.available;
    this.uniforms.uSatMix.value = this.enabled && this.uniforms.uSat.value ? 0.9 : 0;
    if (this.enabled) this.cx = this.cz = Number.NaN; // force a (re)build at the next update
    this.onChange?.();
  }

  update(x: number, z: number): void {
    if (!this.enabled || !this.available || this.building || this.disposed) return;
    if (Number.isFinite(this.cx) && Math.hypot(x - this.cx, z - this.cz) < REBUILD_M) return;
    void this.build(x, z);
  }

  private fetchTile(tx: number, ty: number): Promise<HTMLImageElement | null> {
    const key = `${tx}/${ty}`;
    let p = this.tiles.get(key);
    if (!p) {
      const m = this.meta!;
      const url = m.template
        .replace('{subdomain}', m.subdomains[(tx + ty) % m.subdomains.length])
        .replace('{quadkey}', quadkey(tx, ty, ZOOM));
      p = new Promise((res) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => res(img);
        img.onerror = () => res(null);
        img.src = url;
      });
      this.tiles.set(key, p);
      if (this.tiles.size > 220) this.tiles.delete(this.tiles.keys().next().value as string);
    }
    return p;
  }

  private async build(x: number, z: number): Promise<void> {
    const o = this.origin!;
    this.building = true;
    try {
      const ll = o.toLatLon(x, z);
      const fx = lonToTileX(ll.lon, ZOOM);
      const fy = latToTileY(ll.lat, ZOOM);
      const x0 = Math.floor(fx) - (N >> 1);
      const y0 = Math.floor(fy) - (N >> 1);
      const jobs: Promise<HTMLImageElement | null>[] = [];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) jobs.push(this.fetchTile(x0 + i, y0 + j));
      const imgs = await Promise.all(jobs);
      if (this.disposed || !this.enabled) return;
      const c = document.createElement('canvas');
      c.width = c.height = N * TS;
      const g = c.getContext('2d')!;
      let ok = 0;
      imgs.forEach((im, k) => {
        if (!im) return;
        g.drawImage(im, (k % N) * TS, Math.floor(k / N) * TS, TS, TS);
        ok++;
      });
      if (ok < N * N * 0.5) {
        this.cx = this.cz = Number.NaN; // try again next update
        this.building = false;
        setTimeout(() => this.update(x, z), 4000);
        return;
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      // affine world -> uv. Mercator is conformal, so tiles per ground metre is the same N-S and E-W:
      // 2^Z / (360 * metres-per-degree-of-longitude). Tile coords of the game origin anchor the window.
      const f0 = o.toLatLon(0, 0);
      const ox = lonToTileX(f0.lon, ZOOM);
      const oy = latToTileY(f0.lat, ZOOM);
      const tilesPerMX = 2 ** ZOOM / 360 / o.mPerDegLon;
      const tilesPerMY = tilesPerMX;
      this.uniforms.uSatA.value.set((ox - x0) / N, tilesPerMX / N, (oy - y0) / N, tilesPerMY / N);
      const old = this.uniforms.uSat.value;
      this.uniforms.uSat.value = tex;
      old?.dispose();
      this.uniforms.uSatMix.value = this.enabled ? 0.9 : 0;
      this.cx = x;
      this.cz = z;
    } finally {
      this.building = false;
      this.onChange?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.uniforms.uSat.value?.dispose();
    this.uniforms.uSat.value = null;
    this.tiles.clear();
  }
}
