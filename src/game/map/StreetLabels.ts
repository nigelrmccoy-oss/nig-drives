import * as THREE from 'three';
import type { RoadCenterline } from './RoadBuilder';

/** Highways that get world name/ref sprites when tagged. */
const LABELABLE = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
]);

const MAX_LABELS = 18;
const SPACING_M = 140;
/** Prefer first sample sooner so short OSM fragments still get a pin. */
const FIRST_FRAC = 0.28;
const MIN_WAY_M = 10;
const SHORT_WAY_M = 95;

/**
 * Compact street-name sprites from OSM name/ref.
 * Smaller scale, curb-height anchors, distance + view-cone fade so they
 * do not dominate / occlude the windshield — but still readable online
 * (OSM ways are often short intersection-to-intersection fragments).
 */
export class StreetLabels {
  readonly group = new THREE.Group();
  private sprites: THREE.Sprite[] = [];
  private pool: THREE.Sprite[] = [];
  private refreshAcc = 0;
  /** Sign-post height above road (m) — near curb, not floaty billboards. */
  private readonly labelClearance = 1.35;

  constructor() {
    this.group.name = 'street-labels';
  }

  update(
    dt: number,
    lines: RoadCenterline[],
    px: number,
    pz: number,
    py: number,
    cam?: { x: number; y: number; z: number; fx: number; fz: number },
  ): void {
    this.refreshAcc += dt;
    // Soft per-frame fade even between rebuilds
    for (const s of this.sprites) {
      const mat = s.material as THREE.SpriteMaterial;
      const target = (s.userData.fadeTarget as number | undefined) ?? mat.opacity;
      mat.opacity += (target - mat.opacity) * Math.min(1, dt * 5);
    }
    if (this.refreshAcc < 0.5) return;
    this.refreshAcc = 0;

    type Cand = { x: number; y: number; z: number; text: string; d: number };
    const cands: Cand[] = [];

    for (const line of lines) {
      if (!LABELABLE.has(line.highway)) continue;
      const text = (line.name || line.ref || '').trim();
      if (!text || text.length > 36) continue;
      const pts = line.points;
      if (pts.length < 2) continue;

      let totalLen = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        if (Number.isFinite(seg) && seg >= 0.5) totalLen += seg;
      }
      if (totalLen < MIN_WAY_M) continue;

      // Short OSM fragments: one mid-way pin. Longer ways: spaced samples.
      const targets: number[] = [];
      if (totalLen < SHORT_WAY_M) {
        targets.push(totalLen * 0.5);
      } else {
        let nextAt = Math.min(SPACING_M * FIRST_FRAC, totalLen * 0.35);
        nextAt = Math.max(12, nextAt);
        while (nextAt <= totalLen) {
          targets.push(nextAt);
          nextAt += SPACING_M;
        }
      }

      for (const sampleAt of targets) {
        let distAlong = 0;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          const seg = Math.hypot(b.x - a.x, b.z - a.z);
          if (!Number.isFinite(seg) || seg < 0.5) continue;
          if (distAlong + seg < sampleAt) {
            distAlong += seg;
            continue;
          }
          const t = (sampleAt - distAlong) / seg;
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          const y = a.y + (b.y - a.y) * t + this.labelClearance;
          const d = (x - px) ** 2 + (z - pz) ** 2;
          // Mid-range band: skip windshield-close and far horizon
          if (d > 12 * 12 && d < 150 * 150) cands.push({ x, y, z, text, d });
          break;
        }
      }
    }

    cands.sort((a, b) => a.d - b.d);
    // Dedupe near-identical labels
    const picked: Cand[] = [];
    for (const c of cands) {
      if (picked.length >= MAX_LABELS) break;
      if (
        picked.some(
          (p) =>
            p.text === c.text && (p.x - c.x) ** 2 + (p.z - c.z) ** 2 < 48 * 48,
        )
      ) {
        continue;
      }
      picked.push(c);
    }

    while (this.sprites.length > picked.length) {
      const s = this.sprites.pop()!;
      this.group.remove(s);
      s.userData.placed = false;
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
      // Keep at road sign height — do not lift to eye level (floaty windshield occluders)
      const ty = c.y;
      if (s.userData.placed) {
        s.position.x += (c.x - s.position.x) * 0.4;
        s.position.y += (ty - s.position.y) * 0.4;
        s.position.z += (c.z - s.position.z) * 0.4;
      } else {
        s.position.set(c.x, ty, c.z);
        s.userData.placed = true;
      }
      const prev = s.userData.labelText as string | undefined;
      if (prev !== c.text) {
        updateSpriteText(s, c.text);
        s.userData.labelText = c.text;
      }
      const dist = Math.sqrt(c.d);
      let fade = distFade(dist);

      // Soft view-cone: only strong attenuation when nearly dead-ahead AND close
      if (cam && fade > 0) {
        const dx = c.x - cam.x;
        const dz = c.z - cam.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = dx / len;
        const nz = dz / len;
        const fl = Math.hypot(cam.fx, cam.fz) || 1;
        const fxx = cam.fx / fl;
        const fzz = cam.fz / fl;
        const facing = nx * fxx + nz * fzz; // 1 = straight ahead
        if (facing > 0.85 && dist < 38) {
          const cone = (facing - 0.85) / 0.15; // 0..1
          const near = 1 - Math.min(1, Math.max(0, (dist - 12) / 26));
          fade *= 1 - cone * near * 0.55;
        }
      }

      // Readable mid-range without dominating the frame
      s.userData.fadeTarget = Math.max(0, Math.min(0.82, 0.18 + fade * 0.62));
      // Compact world scale (~60% of 1.3.1b — still larger than 1.3.1c's near-invisible pins)
      const sc = 3.15 + Math.min(3.6, c.text.length * 0.13);
      s.scale.set(sc, sc * 0.27, 1);
      void py;
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

/** Soft bell: invisible too close / too far, readable mid-range. */
function distFade(d: number): number {
  if (d < 12) return 0;
  if (d < 24) return (d - 12) / 12;
  if (d < 95) return 1;
  if (d > 145) return 0;
  return 1 - (d - 95) / 50;
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
  c.width = 384;
  c.height = 96;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, c.width, c.height);
  // Compact sign plate
  ctx.fillStyle = 'rgba(18, 22, 30, 0.68)';
  roundRect(ctx, 12, 22, 360, 52, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(201, 163, 106, 0.75)';
  ctx.lineWidth = 2;
  roundRect(ctx, 12, 22, 360, 52, 7);
  ctx.stroke();
  ctx.fillStyle = '#f0ebe3';
  ctx.font = 'bold 26px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 192, 48, 340);
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
