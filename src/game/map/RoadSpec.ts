/**
 * v1.5.0a: real road cross-sections from OSM tags.
 *
 * One resolver feeds the road mesh (RoadBuilder), the terrain carve and the
 * physics height (TileManager), so what is drawn is what the wheels touch.
 *
 * Cross-section, measured outwards from the centreline (d, metres):
 *   0 … half                carriageway (lanes + parking / cycle lanes)
 *   half … half+shoulder    flush shoulder (rural / no kerb)           dy = 0
 *   half … half+KERB_RAMP   kerb face, 0 → kerbH                       (kerb roads)
 *   … half+KERB_RAMP+walk   raised pavement (sidewalk) at kerbH        (if mapped)
 *   beyond                  ground (carved to `groundDy` under the road level)
 * Left = the +normal side of the way direction (−dir.z, dir.x); right is −normal.
 */

export type ShoulderKind = 'paved' | 'gravel' | 'grass';

export interface RoadSpec {
  /** Carriageway width incl. parking / cycle lanes (m). */
  width: number;
  lanes: number;
  /** Which tag decided the width. */
  source: 'width' | 'lanes' | 'class';
  oneway: boolean;
  /** Raised kerb at the carriageway edge. */
  kerb: boolean;
  kerbH: number;
  /** Flush shoulder beyond the edge, [left, right] (m). 0 = none. */
  shoulder: [number, number];
  shoulderKind: ShoulderKind;
  /** Raised sidewalk beyond the kerb, [left, right] (m). 0 = none. */
  walk: [number, number];
  /** Flat platform edge beyond the carriageway edge on each side, [left, right]. */
  extent: [number, number];
  /** Ground level under/next to the road relative to the road surface. */
  groundDy: number;
  /** Steepest cut / fill batter (rise per metre) when the ground rejoins the DEM. */
  batter: number;
}

export const KERB_H = 0.13;
export const KERB_RAMP = 0.28;
/** Flat kerb top where no sidewalk is mapped. */
export const KERB_TOP = 0.2;
const WALK_DEFAULT = 1.8;

/** Old per-class totals, used only when a way has neither `width` nor `lanes`. */
const CLASS_WIDTH: Record<string, number> = {
  motorway: 11.0,
  trunk: 10.0,
  primary: 7.2,
  secondary: 7.0,
  tertiary: 6.6,
  unclassified: 6.2,
  residential: 6.4,
  living_street: 5.4,
  service: 3.8,
  track: 3.2,
  motorway_link: 5.5,
  trunk_link: 5.2,
  primary_link: 5.0,
  secondary_link: 4.8,
  tertiary_link: 4.6,
};

/** Typical lane width by class (m): Ontario geometric design / TAC norms. */
const LANE_W: Record<string, number> = {
  motorway: 3.7,
  trunk: 3.6,
  primary: 3.5,
  secondary: 3.4,
  tertiary: 3.2,
  unclassified: 3.1,
  residential: 3.0,
  living_street: 2.8,
  service: 2.8,
  track: 2.6,
  motorway_link: 3.9,
  trunk_link: 3.7,
  primary_link: 3.6,
  secondary_link: 3.5,
  tertiary_link: 3.4,
};

const PARK_LANE_W = 2.2;
const CYCLE_LANE_W = 1.5;

/** Parse an OSM length ("7.5", "7.5 m", "24'6\"", "25 ft") to metres, or NaN. */
export function parseLengthM(raw: string | undefined): number {
  if (!raw) return NaN;
  const s = raw.trim().toLowerCase();
  const ft = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?)?$/);
  if (ft) return (parseFloat(ft[1]) * 12 + (ft[2] ? parseFloat(ft[2]) : 0)) * 0.0254;
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(m|ft|feet|km)?$/);
  if (!m) return NaN;
  const v = parseFloat(m[1].replace(',', '.'));
  if (m[2] === 'ft' || m[2] === 'feet') return v * 0.3048;
  if (m[2] === 'km') return v * 1000;
  return v;
}

/** [left, right] truthiness of a "key" / "key:left" / "key:right" / "key:both" family. */
function sides(tags: Record<string, string>, key: string, ok: (v: string | undefined) => boolean): [boolean, boolean] {
  const both = tags[key] ?? tags[`${key}:both`];
  let l = ok(tags[`${key}:left`]);
  let r = ok(tags[`${key}:right`]);
  if (both === 'left') l = true;
  else if (both === 'right') r = true;
  else if (ok(both)) {
    l = true;
    r = true;
  }
  return [l, r];
}

function isOneway(tags: Record<string, string>): boolean {
  const o = tags.oneway;
  if (o === 'yes' || o === '1' || o === 'true' || o === '-1') return true;
  if (o === 'no') return false;
  const hw = tags.highway;
  return hw === 'motorway' || hw === 'motorway_link' || tags.junction === 'roundabout';
}

function maxspeedKmh(tags: Record<string, string>): number {
  const m = (tags.maxspeed ?? '').match(/(\d+)/);
  if (!m) return NaN;
  const v = parseInt(m[1], 10);
  return /mph/i.test(tags.maxspeed ?? '') ? v * 1.609 : v;
}

export function resolveRoadSpec(tags: Record<string, string>): RoadSpec {
  const hw = tags.highway ?? 'residential';
  const oneway = isOneway(tags);
  const laneW = LANE_W[hw] ?? 3.1;
  const classW = CLASS_WIDTH[hw] ?? 6;

  // ── carriageway width ────────────────────────────────────────────────────
  let width = classW;
  let source: RoadSpec['source'] = 'class';
  let lanes = hw === 'motorway' || hw === 'trunk' ? 2 : Math.max(1, Math.round(classW / laneW));
  const lanesTag = parseInt(tags.lanes ?? '', 10);
  const widthTag = parseLengthM(tags.width);
  const hasLanes = Number.isFinite(lanesTag) && lanesTag >= 1 && lanesTag <= 12;
  if (hasLanes) {
    lanes = lanesTag;
    // a mapped lane count on a two-way road with 1 lane = a single-track lane both ways
    width = Math.max(lanes, hw === 'service' || hw === 'track' ? 1 : 2) * laneW;
    if (oneway || lanes >= 2) width = lanes * laneW;
    source = 'lanes';
  }
  // parking / cycle lanes ride inside the paved width
  const [pkL, pkR] = sides(tags, 'parking:lane', (v) => v === 'parallel' || v === 'diagonal' || v === 'perpendicular' || v === 'yes');
  const [cyL, cyR] = sides(tags, 'cycleway', (v) => v === 'lane' || v === 'opposite_lane' || v === 'shared_busway');
  const extraLanes = (pkL ? PARK_LANE_W : 0) + (pkR ? PARK_LANE_W : 0) + (cyL ? CYCLE_LANE_W : 0) + (cyR ? CYCLE_LANE_W : 0);
  if (source === 'lanes') width += extraLanes;
  else if (extraLanes > 0 && hw !== 'service' && hw !== 'track') width += extraLanes;
  if (Number.isFinite(widthTag) && widthTag >= 2.4 && widthTag <= 40) {
    width = widthTag;
    source = 'width';
  }
  width = Math.min(34, Math.max(hw === 'track' ? 2.6 : 2.8, width));
  width = Math.round(width * 20) / 20;

  // ── kerb / sidewalk / shoulder ───────────────────────────────────────────
  const [swL, swR] = sides(tags, 'sidewalk', (v) => v === 'yes' || v === 'both' || v === 'left' || v === 'right' || v === 'separate');
  const hasWalk = swL || swR;
  const kerbTag = tags.kerb;
  const speed = maxspeedKmh(tags);
  const highClass = hw === 'motorway' || hw === 'trunk' || hw === 'motorway_link' || hw === 'trunk_link';
  let kerb: boolean;
  if (kerbTag === 'raised' || kerbTag === 'lowered' || kerbTag === 'yes') kerb = true;
  else if (kerbTag === 'flush' || kerbTag === 'no') kerb = false;
  else if (highClass) kerb = false;
  else if (hw === 'track') kerb = false;
  else if (hasWalk) kerb = true;
  else if (hw === 'residential' || hw === 'living_street') kerb = true;
  else if (hw === 'service') kerb = tags.lit === 'yes' && tags.service !== 'driveway';
  else kerb = tags.lit === 'yes' || (Number.isFinite(speed) && speed <= 50);

  // sidewalk=separate/footways are mapped as their own ways: only draw tagged strips
  const walkW = (on: boolean, side: 'left' | 'right'): number => {
    if (!on || !kerb) return 0;
    const w = parseLengthM(tags[`sidewalk:${side}:width`] ?? tags['sidewalk:both:width'] ?? tags['sidewalk:width']);
    if (Number.isFinite(w) && w >= 0.6 && w <= 6) return Math.round(w * 10) / 10;
    return WALK_DEFAULT;
  };
  const walk: [number, number] = [walkW(swL, 'left'), walkW(swR, 'right')];

  // paved shoulder (rural classes) by class; `shoulder=no` removes it
  let shDefault = 0;
  if (!kerb && !highClass && hw !== 'track' && hw !== 'service') {
    if (hw === 'primary') shDefault = 1.5;
    else if (hw === 'secondary') shDefault = 1.0;
    else if (hw === 'tertiary' || hw === 'unclassified') shDefault = 0.5;
    else if (hw.endsWith('_link')) shDefault = 1.0;
  }
  if (hw === 'motorway' || hw === 'trunk') shDefault = hw === 'motorway' ? 3.0 : 2.5;
  if (hw === 'motorway_link' || hw === 'trunk_link') shDefault = 1.5;
  const [shL, shR] = sides(tags, 'shoulder', (v) => v === 'yes' || v === 'both' || v === 'left' || v === 'right');
  const shNo = tags.shoulder === 'no' || tags['shoulder:both'] === 'no';
  const shW = (explicit: boolean, side: 'left' | 'right'): number => {
    if (kerb) return 0;
    if (shNo && !explicit) return 0;
    const w = parseLengthM(tags[`shoulder:${side}:width`] ?? tags['shoulder:both:width'] ?? tags['shoulder:width']);
    if (Number.isFinite(w) && w >= 0.2 && w <= 5) return Math.round(w * 10) / 10;
    if (explicit && shDefault < 1) return 1.0;
    // one-way carriageways of a motorway: the median-side (left) shoulder is narrow
    if (oneway && highClass && side === 'left') return Math.min(shDefault, 1.2);
    return shDefault;
  };
  const shoulder: [number, number] = [shW(shL, 'left'), shW(shR, 'right')];
  const shSurface = (tags['shoulder:surface'] ?? '').toLowerCase();
  const shoulderKind: ShoulderKind =
    shSurface === 'gravel' || shSurface === 'compacted' || shSurface === 'unpaved' || shSurface === 'dirt'
      ? 'gravel'
      : shSurface === 'grass'
        ? 'grass'
        : 'paved';

  const kerbSide = (i: 0 | 1): number => KERB_RAMP + (walk[i] > 0 ? walk[i] : KERB_TOP);
  const extent: [number, number] = kerb ? [kerbSide(0), kerbSide(1)] : [shoulder[0], shoulder[1]];
  const batter = highClass ? 0.4 : hw === 'primary' || hw === 'secondary' ? 0.5 : 0.6;
  return {
    width,
    lanes,
    source,
    oneway,
    kerb,
    kerbH: KERB_H,
    shoulder,
    shoulderKind,
    walk,
    extent,
    groundDy: kerb ? KERB_H - 0.1 : -0.1,
    batter,
  };
}

/**
 * Height of the paved cross-section above the road surface at lateral offset
 * `d` (≥ 0, metres) on `side` (0 = left, 1 = right), or NaN beyond the platform
 * (the caller then uses the ground). Mirrors exactly what RoadBuilder draws.
 */
export function crossSectionDy(spec: RoadSpec, side: 0 | 1, d: number): number {
  const half = spec.width * 0.5;
  const o = d - half;
  if (o <= 0) return 0;
  if (!spec.kerb) return o <= spec.shoulder[side] ? 0 : Number.NaN;
  if (o <= KERB_RAMP) return (o / KERB_RAMP) * spec.kerbH;
  return o <= spec.extent[side] ? spec.kerbH : Number.NaN;
}

/** Which strip of the cross-section (for grip / HUD) at offset d. */
export type StripKind = 'road' | 'shoulder' | 'kerb' | 'walk' | 'off';
export function stripAt(spec: RoadSpec, side: 0 | 1, d: number): StripKind {
  const o = d - spec.width * 0.5;
  if (o <= 0) return 'road';
  if (!spec.kerb) return o <= spec.shoulder[side] ? 'shoulder' : 'off';
  if (o <= KERB_RAMP) return 'kerb';
  return o <= spec.extent[side] ? 'walk' : 'off';
}
