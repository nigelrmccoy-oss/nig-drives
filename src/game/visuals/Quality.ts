/**
 * v1.3.2 graphics presets. Medium is the default and is budgeted for a
 * Ryzen 7 7730U-class iGPU in Chrome (target ≥ 50 FPS).
 */
export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualitySettings {
  level: QualityLevel;
  label: string;
  /** Max devicePixelRatio used by the renderer. */
  pixelRatioCap: number;
  shadowMapSize: number;
  /** Near terrain ring grid resolution (1.2 km square). */
  nearRingRes: number;
  /** Texture-array layer size for the terrain splat (px). */
  splatSize: number;
  /** Terrain/road normal maps. */
  normals: boolean;
  /** Triplanar rock on steep slopes. */
  triplanar: boolean;
  /** ARM (AO/roughness) maps on terrain. */
  arm: boolean;
  /** Second, rotated, larger-scale sample per layer (anti-tiling). */
  antiTile: boolean;
  anisotropy: number;
  /** Bloom pass (headlight/window glow). SMAA stays on at every level. */
  bloom: boolean;
}

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  low: {
    level: 'low',
    label: 'Low',
    pixelRatioCap: 1.0,
    shadowMapSize: 1024,
    nearRingRes: 128,
    splatSize: 512,
    normals: false,
    triplanar: false,
    arm: false,
    antiTile: false,
    anisotropy: 2,
    bloom: false,
  },
  medium: {
    level: 'medium',
    label: 'Medium',
    pixelRatioCap: 1.25,
    shadowMapSize: 1536,
    nearRingRes: 192,
    splatSize: 512,
    normals: true,
    triplanar: true,
    arm: false,
    antiTile: true,
    anisotropy: 4,
    bloom: true,
  },
  high: {
    level: 'high',
    label: 'High',
    pixelRatioCap: 1.5,
    shadowMapSize: 2048,
    nearRingRes: 256,
    splatSize: 1024,
    normals: true,
    triplanar: true,
    arm: true,
    antiTile: true,
    anisotropy: 8,
    bloom: true,
  },
};

const KEY = 'nigdrives.quality';

function isLevel(v: unknown): v is QualityLevel {
  return v === 'low' || v === 'medium' || v === 'high';
}

/** ?quality=low|medium|high overrides the saved choice (QA). */
export function loadQualityLevel(): QualityLevel {
  try {
    const q = new URLSearchParams(window.location.search).get('quality');
    if (isLevel(q)) return q;
    const s = window.localStorage.getItem(KEY);
    if (isLevel(s)) return s;
  } catch {
    /* storage blocked */
  }
  return 'medium';
}

export function saveQualityLevel(level: QualityLevel): void {
  try {
    window.localStorage.setItem(KEY, level);
  } catch {
    /* ignore */
  }
}
