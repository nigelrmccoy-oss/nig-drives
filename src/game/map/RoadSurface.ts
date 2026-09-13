/**
 * OSM surface / highway → visual + physics mapping (v1.2c).
 * Offline fallback roads default to asphalt-like grip.
 */

import type { WeatherPreset } from '../weather/Environment';

export type SurfaceKind =
  | 'asphalt'
  | 'concrete'
  | 'paving_stones'
  | 'cobblestone'
  | 'compacted'
  | 'gravel'
  | 'dirt'
  | 'grass'
  | 'sand'
  | 'wood'
  | 'metal'
  | 'unknown';

export interface SurfaceProfile {
  kind: SurfaceKind;
  /** Short HUD label */
  label: string;
  /** Dry grip multiplier (1 = good asphalt) */
  grip: number;
  /** Lateral noise / bumpiness 0–1 for tire model */
  noise: number;
  color: number;
  roughness: number;
  metalness: number;
  /** Wet weather grip retention (higher = less loss) */
  wetRetain: number;
  /** Snow weather grip retention */
  snowRetain: number;
}

const PROFILES: Record<SurfaceKind, SurfaceProfile> = {
  asphalt: {
    kind: 'asphalt',
    label: 'Asphalt',
    grip: 1.0,
    noise: 0.05,
    color: 0x2c2c30,
    roughness: 0.92,
    metalness: 0.05,
    wetRetain: 0.72,
    snowRetain: 0.48,
  },
  concrete: {
    kind: 'concrete',
    label: 'Concrete',
    grip: 0.98,
    noise: 0.06,
    color: 0x4a4a4e,
    roughness: 0.85,
    metalness: 0.04,
    wetRetain: 0.7,
    snowRetain: 0.46,
  },
  paving_stones: {
    kind: 'paving_stones',
    label: 'Paving stones',
    grip: 0.88,
    noise: 0.18,
    color: 0x5a5550,
    roughness: 0.95,
    metalness: 0.02,
    wetRetain: 0.55,
    snowRetain: 0.4,
  },
  cobblestone: {
    kind: 'cobblestone',
    label: 'Cobblestone',
    grip: 0.78,
    noise: 0.28,
    color: 0x6a6058,
    roughness: 0.98,
    metalness: 0.02,
    wetRetain: 0.5,
    snowRetain: 0.38,
  },
  compacted: {
    kind: 'compacted',
    label: 'Compacted',
    grip: 0.82,
    noise: 0.16,
    color: 0x5c5348,
    roughness: 0.96,
    metalness: 0.02,
    wetRetain: 0.55,
    snowRetain: 0.42,
  },
  gravel: {
    kind: 'gravel',
    label: 'Gravel',
    grip: 0.65,
    noise: 0.35,
    color: 0x7a6e5c,
    roughness: 0.99,
    metalness: 0.01,
    wetRetain: 0.5,
    snowRetain: 0.4,
  },
  dirt: {
    kind: 'dirt',
    label: 'Dirt',
    grip: 0.55,
    noise: 0.32,
    color: 0x6b5340,
    roughness: 1.0,
    metalness: 0,
    wetRetain: 0.4,
    snowRetain: 0.35,
  },
  grass: {
    kind: 'grass',
    label: 'Grass',
    grip: 0.45,
    noise: 0.25,
    color: 0x4a6b3a,
    roughness: 1.0,
    metalness: 0,
    wetRetain: 0.35,
    snowRetain: 0.3,
  },
  sand: {
    kind: 'sand',
    label: 'Sand',
    grip: 0.4,
    noise: 0.4,
    color: 0xc2a878,
    roughness: 1.0,
    metalness: 0,
    wetRetain: 0.55,
    snowRetain: 0.35,
  },
  wood: {
    kind: 'wood',
    label: 'Wood',
    grip: 0.7,
    noise: 0.2,
    color: 0x6b4e32,
    roughness: 0.9,
    metalness: 0.02,
    wetRetain: 0.4,
    snowRetain: 0.32,
  },
  metal: {
    kind: 'metal',
    label: 'Metal',
    grip: 0.75,
    noise: 0.08,
    color: 0x7a8088,
    roughness: 0.45,
    metalness: 0.55,
    wetRetain: 0.35,
    snowRetain: 0.28,
  },
  unknown: {
    kind: 'unknown',
    label: 'Road',
    grip: 0.95,
    noise: 0.08,
    color: 0x2c2c30,
    roughness: 0.92,
    metalness: 0.05,
    wetRetain: 0.68,
    snowRetain: 0.45,
  },
};

/** Normalize OSM surface=* tag to a SurfaceKind. */
export function parseSurfaceTag(raw: string | undefined): SurfaceKind | null {
  if (!raw) return null;
  const s = raw.toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (
    s === 'asphalt' ||
    s === 'tarmac' ||
    s === 'paved' ||
    s === 'bitumen' ||
    s === 'asphalt:concrete'
  )
    return 'asphalt';
  if (s === 'concrete' || s === 'cement' || s.startsWith('concrete:')) return 'concrete';
  if (
    s === 'paving_stones' ||
    s === 'paving_stone' ||
    s === 'sett' ||
    s === 'pavingstones'
  )
    return 'paving_stones';
  if (s === 'cobblestone' || s === 'cobblestones' || s === 'unhewn_cobblestone')
    return 'cobblestone';
  if (s === 'compacted' || s === 'fine_gravel') return 'compacted';
  if (s === 'gravel' || s === 'pebblestone' || s === 'chipseal') return 'gravel';
  if (s === 'dirt' || s === 'earth' || s === 'ground' || s === 'mud' || s === 'soil')
    return 'dirt';
  if (s === 'grass' || s === 'grass_paver') return 'grass';
  if (s === 'sand') return 'sand';
  if (s === 'wood' || s === 'boardwalk') return 'wood';
  if (s === 'metal' || s === 'steel') return 'metal';
  if (s === 'unpaved') return 'dirt';
  return null;
}

/**
 * Infer surface from highway class when surface=* is missing.
 * Motorways/trunks → asphalt; track → dirt.
 */
export function inferSurfaceFromHighway(highway: string | undefined): SurfaceKind {
  if (!highway) return 'asphalt';
  if (highway === 'track') return 'dirt';
  return 'asphalt';
}

/** Highway class grip bias (treated major roads hold better in weather). */
function highwayGripBias(highway: string | undefined): number {
  if (!highway) return 0;
  switch (highway) {
    case 'motorway':
    case 'trunk':
      return 0.06;
    case 'motorway_link':
    case 'trunk_link':
    case 'primary':
      return 0.04;
    case 'primary_link':
    case 'secondary':
      return 0.02;
    case 'residential':
    case 'living_street':
      return -0.02;
    case 'service':
      return -0.04;
    case 'track':
      return -0.08;
    default:
      return 0;
  }
}

/** Light maxspeed hint: higher posted speed → slightly better maintained pavement. */
function maxspeedBias(tags: Record<string, string>): number {
  const raw = tags.maxspeed;
  if (!raw) return 0;
  const m = raw.match(/(\d+)/);
  if (!m) return 0;
  let v = parseInt(m[1], 10);
  if (!Number.isFinite(v)) return 0;
  if (/mph/i.test(raw)) v = Math.round(v * 1.609);
  if (v >= 90) return 0.04;
  if (v >= 70) return 0.03;
  if (v >= 50) return 0.015;
  if (v <= 20) return -0.02;
  return 0;
}

export function resolveSurfaceProfile(tags: Record<string, string>): SurfaceProfile {
  const fromTag = parseSurfaceTag(tags.surface);
  const kind = fromTag ?? inferSurfaceFromHighway(tags.highway);
  const base = { ...PROFILES[kind] };
  const bias = highwayGripBias(tags.highway) + maxspeedBias(tags);
  base.grip = clamp(base.grip + bias, 0.25, 1.15);

  const hw = tags.highway;
  if (hw === 'motorway' || hw === 'trunk' || hw === 'motorway_link' || hw === 'trunk_link') {
    // Treated major roads: less weather loss
    base.wetRetain = Math.min(0.85, base.wetRetain + 0.1);
    base.snowRetain = Math.min(0.6, base.snowRetain + 0.08);
    if (kind === 'asphalt') base.label = 'Motorway asphalt';
  }
  return base;
}

/** Offline fallback: plausible asphalt. */
export function defaultAsphaltProfile(): SurfaceProfile {
  return { ...PROFILES.asphalt };
}

/**
 * Effective grip for the tire model.
 * - dry: profile.grip × roadFactor × weatherBase
 * - rain/snow: profile × surface retain × roadFactor, scaled so motorway asphalt
 *   loses less than untreated dirt/grass (ice-like on low-grip in snow).
 */
export function effectiveGrip(
  profile: SurfaceProfile,
  roadFactor: number,
  weather: WeatherPreset,
): number {
  const onRoad = clamp(roadFactor, 0.2, 1);
  if (weather === 'clear') {
    return clamp(profile.grip * onRoad, 0.15, 1.2);
  }
  const retain = weather === 'rain' ? profile.wetRetain : profile.snowRetain;
  // Untreated / low-grip surfaces get ice-like in snow
  const untreated =
    weather === 'snow' && profile.grip < 0.7 ? 0.65 : 1;
  return clamp(profile.grip * retain * untreated * onRoad, 0.1, 1.05);
}

/** Weather-tinted color for a base surface color. */
export function weatherTintColor(baseHex: number, weather: WeatherPreset): number {
  if (weather === 'clear') return baseHex;
  const r = (baseHex >> 16) & 0xff;
  const g = (baseHex >> 8) & 0xff;
  const b = baseHex & 0xff;
  if (weather === 'rain') {
    return (Math.round(r * 0.72) << 16) | (Math.round(g * 0.78) << 8) | Math.round(b * 0.88);
  }
  const nr = Math.min(255, Math.round(r * 0.55 + 90));
  const ng = Math.min(255, Math.round(g * 0.55 + 95));
  const nb = Math.min(255, Math.round(b * 0.55 + 100));
  return (nr << 16) | (ng << 8) | nb;
}

export function weatherRoughness(base: number, weather: WeatherPreset): number {
  if (weather === 'rain') return Math.min(0.95, base * 0.4);
  if (weather === 'snow') return Math.min(1, base * 0.85 + 0.05);
  return base;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function profileForKind(kind: SurfaceKind): SurfaceProfile {
  return { ...PROFILES[kind] };
}
