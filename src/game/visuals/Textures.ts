/**
 * Procedural / CC0-style canvas textures for the v1.3 Forza visual pass.
 * No external photo assets required.
 */
import * as THREE from 'three';

function canvas(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return { c, ctx };
}

function hash(ix: number, iy: number): number {
  const n = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function noise2(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0);
  const b = hash(x0 + 1, y0);
  const c = hash(x0, y0 + 1);
  const d = hash(x0 + 1, y0 + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, oct = 4): number {
  let a = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    a += noise2(x * f, y * f) * amp;
    f *= 2;
    amp *= 0.5;
  }
  return a;
}

function toTex(c: HTMLCanvasElement, wrap = true, anisotropy = 4): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

export interface SurfaceMaps {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
}

/** Grayscale-ish albedo so MeshStandardMaterial.color still tints by surface kind. */
export function makeRoadMaps(kind: string): SurfaceMaps {
  const size = 256;
  const { c: albedoC, ctx: a } = canvas(size, size);
  const { c: roughC, ctx: r } = canvas(size, size);
  const { c: normC, ctx: n } = canvas(size, size);
  const imgA = a.createImageData(size, size);
  const imgR = r.createImageData(size, size);
  const imgN = n.createImageData(size, size);

  const scale = kind === 'cobblestone' || kind === 'paving_stones' ? 0.09 : kind === 'gravel' || kind === 'dirt' ? 0.07 : 0.045;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const nx = x * scale;
      const ny = y * scale;
      let h = fbm(nx, ny, 5);
      if (kind === 'asphalt' || kind === 'unknown') {
        // Fine grit + faint cracks
        const grit = noise2(x * 0.4, y * 0.4) * 0.12;
        const crack = Math.abs(Math.sin((x + y * 0.3) * 0.15 + fbm(x * 0.02, y * 0.02, 2) * 8));
        const line = crack > 0.97 ? -0.18 : 0;
        h = 0.72 + h * 0.18 + grit + line;
      } else if (kind === 'concrete') {
        const tile = ((x >> 5) + (y >> 5)) % 2 === 0 ? 0.04 : 0;
        h = 0.78 + h * 0.14 + tile;
      } else if (kind === 'cobblestone' || kind === 'paving_stones') {
        const cx = (x % 18) / 18;
        const cy = (y % 14) / 14;
        const stone = Math.max(Math.abs(cx - 0.5), Math.abs(cy - 0.5)) > 0.42 ? 0.35 : 0.75 + h * 0.15;
        h = stone;
      } else if (kind === 'gravel' || kind === 'compacted') {
        h = 0.55 + h * 0.35 + noise2(x * 0.6, y * 0.6) * 0.15;
      } else if (kind === 'dirt' || kind === 'sand') {
        h = 0.6 + h * 0.28;
      } else if (kind === 'grass') {
        h = 0.5 + h * 0.3 + noise2(x * 0.8, y * 0.15) * 0.1;
      } else {
        h = 0.7 + h * 0.2;
      }
      const g = Math.max(0, Math.min(255, Math.round(h * 255)));
      imgA.data[i] = g;
      imgA.data[i + 1] = g;
      imgA.data[i + 2] = g;
      imgA.data[i + 3] = 255;

      const rough = kind === 'asphalt' ? 0.55 + (1 - h) * 0.4 : 0.7 + (1 - h) * 0.25;
      const rv = Math.max(0, Math.min(255, Math.round(rough * 255)));
      imgR.data[i] = rv;
      imgR.data[i + 1] = rv;
      imgR.data[i + 2] = rv;
      imgR.data[i + 3] = 255;

      // Cheap normal from height neighbors
      const hx = fbm((x + 1) * scale, y * scale, 4) - fbm((x - 1) * scale, y * scale, 4);
      const hy = fbm(x * scale, (y + 1) * scale, 4) - fbm(x * scale, (y - 1) * scale, 4);
      imgN.data[i] = Math.round((0.5 - hx * 1.8) * 255);
      imgN.data[i + 1] = Math.round((0.5 - hy * 1.8) * 255);
      imgN.data[i + 2] = 255;
      imgN.data[i + 3] = 255;
    }
  }
  a.putImageData(imgA, 0, 0);
  r.putImageData(imgR, 0, 0);
  n.putImageData(imgN, 0, 0);

  const map = toTex(albedoC);
  map.repeat.set(2.2, 14);
  const roughnessMap = toTex(roughC);
  roughnessMap.colorSpace = THREE.NoColorSpace;
  roughnessMap.repeat.set(2.2, 14);
  const normalMap = toTex(normC);
  normalMap.colorSpace = THREE.NoColorSpace;
  normalMap.repeat.set(2.2, 14);
  return { map, roughnessMap, normalMap };
}

export function makeLaneTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(64, 256);
  ctx.clearRect(0, 0, 64, 256);
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, 64, 256);
  ctx.fillStyle = '#f2f0e4';
  // dashed center
  for (let y = 0; y < 256; y += 48) {
    ctx.fillRect(28, y, 8, 26);
  }
  const tex = toTex(c, true, 8);
  tex.repeat.set(1, 8);
  return tex;
}

export function makeEdgeLineTexture(): THREE.CanvasTexture {
  const { c, ctx } = canvas(32, 128);
  ctx.fillStyle = '#e8e4d4';
  ctx.fillRect(10, 0, 12, 128);
  const tex = toTex(c, true, 4);
  tex.repeat.set(1, 10);
  return tex;
}

export function makeTerrainTexture(): THREE.CanvasTexture {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const n = fbm(x * 0.035, y * 0.035, 5);
      const blade = noise2(x * 0.55, y * 0.18);
      const g = 72 + n * 70 + blade * 18;
      const r = 58 + n * 40 - blade * 8;
      const b = 42 + n * 28;
      img.data[i] = Math.max(0, Math.min(255, r));
      img.data[i + 1] = Math.max(0, Math.min(255, g));
      img.data[i + 2] = Math.max(0, Math.min(255, b));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTex(c);
  tex.repeat.set(48, 48);
  return tex;
}

export function makeBuildingFacade(seed: number): { map: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture } {
  const size = 256;
  const { c, ctx } = canvas(size, size);
  const { c: eC, ctx: e } = canvas(size, size);
  const wall = 150 + Math.floor(hash(seed, 3) * 40);
  ctx.fillStyle = `rgb(${wall},${wall + 4},${wall + 8})`;
  ctx.fillRect(0, 0, size, size);
  e.fillStyle = '#000';
  e.fillRect(0, 0, size, size);
  const cols = 6;
  const rows = 8;
  const gapX = 8;
  const gapY = 10;
  const cellW = (size - gapX * (cols + 1)) / cols;
  const cellH = (size - gapY * (rows + 1)) / rows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const lit = hash(seed * 13 + row * 17 + col, 9) > 0.68;
      const x = gapX + col * (cellW + gapX);
      const y = gapY + row * (cellH + gapY);
      ctx.fillStyle = lit ? '#d8c48a' : '#1c2433';
      ctx.fillRect(x, y, cellW, cellH * 0.72);
      if (lit) {
        e.fillStyle = '#e8d6a0';
        e.fillRect(x, y, cellW, cellH * 0.72);
      }
    }
  }
  const map = toTex(c);
  map.repeat.set(1, 1);
  const emissiveMap = toTex(eC);
  emissiveMap.colorSpace = THREE.SRGBColorSpace;
  return { map, emissiveMap };
}

export function disposeMaps(maps: { map?: THREE.Texture; roughnessMap?: THREE.Texture; normalMap?: THREE.Texture; emissiveMap?: THREE.Texture }): void {
  maps.map?.dispose();
  maps.roughnessMap?.dispose();
  maps.normalMap?.dispose();
  maps.emissiveMap?.dispose();
}
