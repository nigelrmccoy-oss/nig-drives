import * as THREE from 'three';
import type { RoadCenterline } from './RoadBuilder';

const MAJOR = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
]);

const MAX_LABELS = 36;
const SPACING_M = 95;

/**
 * Performance-conscious floating street name sprites from OSM name/ref.
 * Only major ways; capped count; nearest to player refreshed periodically.
 */
export class StreetLabels {
  readonly group = new THREE.Group();
  private sprites: THREE.Sprite[] = [];
  private pool: THREE.Sprite[] = [];
  private refreshAcc = 0;

  constructor() {
    this.group.name = 'street-labels';
  }

  update(dt: number, lines: RoadCenterline[], px: number, pz: number, py: number): void {
    this.refreshAcc += dt;
    if (this.refreshAcc < 0.45) return;
    this.refreshAcc = 0;

    type Cand = { x: number; y: number; z: number; text: string; d: number };
    const cands: Cand[] = [];

    for (const line of lines) {
      if (!MAJOR.has(line.highway)) continue;
      const text = (line.name || line.ref || '').trim();
      if (!text || text.length > 42) continue;
      const pts = line.points;
      if (pts.length < 2) continue;
      let distAlong = 0;
      let nextAt = SPACING_M * 0.35;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        if (!Number.isFinite(seg) || seg < 0.5) continue;
        const prev = distAlong;
        distAlong += seg;
        while (nextAt <= distAlong) {
          const t = (nextAt - prev) / seg;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          const y = (a.y + (b.y - a.y) * t) + 3.2;
          const d = (x - px) ** 2 + (z - pz) ** 2;
          if (d < 220 * 220) cands.push({ x, y, z, text, d });
          nextAt += SPACING_M;
        }
      }
    }

    cands.sort((a, b) => a.d - b.d);
    // Dedupe near-identical labels
    const picked: Cand[] = [];
    for (const c of cands) {
      if (picked.length >= MAX_LABELS) break;
      if (picked.some((p) => p.text === c.text && (p.x - c.x) ** 2 + (p.z - c.z) ** 2 < 40 * 40)) {
        continue;
      }
      picked.push(c);
    }

    while (this.sprites.length > picked.length) {
      const s = this.sprites.pop()!;
      this.group.remove(s);
      this.pool.push(s);
    }
    while (this.sprites.length < picked.length) {
      const s = this.pool.pop() ?? makeLabelSprite(' ');
      this.group.add(s);
      this.sprites.push(s);
    }

    for (let i = 0; i < picked.length; i++) {
      const c = picked[i];
      const s = this.sprites[i];
      s.position.set(c.x, Math.max(c.y, py + 2.5), c.z);
      const prev = s.userData.labelText as string | undefined;
      if (prev !== c.text) {
        updateSpriteText(s, c.text);
        s.userData.labelText = c.text;
      }
      const dist = Math.sqrt(c.d);
      const fade = dist < 40 ? 1 : dist > 180 ? 0 : 1 - (dist - 40) / 140;
      const mat = s.material as THREE.SpriteMaterial;
      mat.opacity = 0.35 + fade * 0.55;
      const sc = 8 + Math.min(10, c.text.length * 0.35);
      s.scale.set(sc, sc * 0.28, 1);
    }
  }

  dispose(): void {
    for (const s of [...this.sprites, ...this.pool]) {
      const mat = s.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
    this.sprites = [];
    this.pool = [];
    this.group.clear();
  }
}

function makeLabelSprite(text: string): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: makeTextTexture(text),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
  });
  const s = new THREE.Sprite(mat);
  s.center.set(0.5, 0.5);
  s.renderOrder = 2;
  return s;
}

function updateSpriteText(s: THREE.Sprite, text: string): void {
  const mat = s.material as THREE.SpriteMaterial;
  mat.map?.dispose();
  mat.map = makeTextTexture(text);
  mat.needsUpdate = true;
}

function makeTextTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  // Sign post / billboard plate
  ctx.fillStyle = 'rgba(18, 22, 30, 0.72)';
  roundRect(ctx, 16, 28, 480, 72, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(201, 163, 106, 0.85)';
  ctx.lineWidth = 3;
  roundRect(ctx, 16, 28, 480, 72, 10);
  ctx.stroke();
  ctx.fillStyle = '#f0ebe3';
  ctx.font = 'bold 36px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 64, 450);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
