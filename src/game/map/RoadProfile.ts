import type { OsmWay } from './OverpassClient';
import type { GeoOrigin } from './geo';

/**
 * v1.3.2 road vertical profiles.
 *
 * Raw DEM heights along a way are noisy at z14 (retaining walls, cuts, building
 * artefacts in the bare-earth model), and junctions between ways used to get
 * whatever the DEM said at each way's own nodes. This pass:
 *   1. densifies the way (≈8 m) and samples the DEM,
 *   2. Gaussian-smooths along arc length (σ by road class),
 *   3. clamps the grade by road class (motorway ≤ 8 %, … residential ≤ 35 %),
 *   4. pins endpoints and shared nodes (junctions) to one deterministic height,
 *      shared across tiles through a registry, and spreads the correction
 *      linearly between pins,
 *   5. keeps bridge/tunnel runs (OSM bridge=* / tunnel=*) level-interpolated
 *      between their abutments instead of following the valley or hill.
 */

export type RoadStructure = 'ground' | 'bridge' | 'tunnel';

export interface ProfilePoint {
  x: number;
  y: number;
  z: number;
}

export interface ProfiledWay {
  way: OsmWay;
  points: ProfilePoint[];
  structure: RoadStructure;
  layer: number;
}

export interface ProfileEnv {
  origin: GeoOrigin;
  /** Relative DEM height (m). */
  heightAt: (lat: number, lon: number) => number;
  /** Relative height of mean sea level (absolute 0 m). */
  seaRel: number;
  /** Junction heights shared across tiles. */
  registry: Map<string, { y: number; provisional: boolean }>;
  /** Increments whenever heightAt had to use a non-final source. */
  provisionalCounter: () => number;
}

const STEP_M = 8;

/** Max grade (rise/run) by OSM highway class. Nigel's defaults from the proposal. */
export function maxGradeFor(highway: string): number {
  switch (highway) {
    case 'motorway':
    case 'trunk':
      return 0.08;
    case 'motorway_link':
    case 'trunk_link':
      return 0.1;
    case 'primary':
    case 'primary_link':
    case 'secondary':
    case 'secondary_link':
      return 0.15;
    case 'tertiary':
    case 'tertiary_link':
      return 0.22;
    default:
      return 0.35; // residential, unclassified, service, living_street, track
  }
}

function smoothSigma(highway: string): number {
  switch (highway) {
    case 'motorway':
    case 'trunk':
      return 22;
    case 'motorway_link':
    case 'trunk_link':
    case 'primary':
      return 13;
    case 'secondary':
    case 'tertiary':
      return 10;
    default:
      return 8;
  }
}

export function structureOf(tags: Record<string, string>): RoadStructure {
  const b = (tags.bridge ?? '').toLowerCase();
  if (b && b !== 'no') return 'bridge';
  const t = (tags.tunnel ?? '').toLowerCase();
  if (t && t !== 'no' && t !== 'building_passage') return 'tunnel';
  if ((tags.covered ?? '') === 'yes' && (tags.layer ?? '').startsWith('-')) return 'tunnel';
  return 'ground';
}

function nodeKey(lat: number, lon: number): string {
  return `${Math.round(lat * 1e6)},${Math.round(lon * 1e6)}`;
}

interface Dense {
  lat: number;
  lon: number;
  x: number;
  z: number;
  /** Original OSM node key when this point is an original node. */
  key?: string;
}

function densify(way: OsmWay, origin: GeoOrigin): Dense[] {
  const out: Dense[] = [];
  const g = way.geometry;
  for (let i = 0; i < g.length; i++) {
    const b = g[i];
    if (!Number.isFinite(b.lat) || !Number.isFinite(b.lon)) continue;
    const pb = origin.toLocal(b.lat, b.lon);
    if (out.length > 0) {
      const a = out[out.length - 1];
      const dist = Math.hypot(pb.x - a.x, pb.z - a.z);
      if (!Number.isFinite(dist) || dist > 1800) continue; // exploded coords
      if (dist < 0.4) {
        // duplicate node — keep the key on the existing point
        if (!a.key) a.key = nodeKey(b.lat, b.lon);
        continue;
      }
      const steps = Math.min(60, Math.floor(dist / STEP_M));
      for (let s = 1; s <= steps; s++) {
        const u = s / (steps + 1);
        out.push({
          lat: a.lat + (b.lat - a.lat) * u,
          lon: a.lon + (b.lon - a.lon) * u,
          x: a.x + (pb.x - a.x) * u,
          z: a.z + (pb.z - a.z) * u,
        });
      }
    }
    out.push({ lat: b.lat, lon: b.lon, x: pb.x, z: pb.z, key: nodeKey(b.lat, b.lon) });
  }
  return out;
}

function arcLengths(pts: Dense[]): number[] {
  const s = [0];
  for (let i = 1; i < pts.length; i++) {
    s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return s;
}

function gaussianSmooth(y: number[], s: number[], sigma: number): number[] {
  const n = y.length;
  if (n < 3) return y.slice();
  const out = new Array<number>(n);
  const lim = sigma * 2.5;
  const inv = 1 / (2 * sigma * sigma);
  let lo = 0;
  for (let i = 0; i < n; i++) {
    while (s[i] - s[lo] > lim) lo++;
    let wSum = 0;
    let acc = 0;
    for (let j = lo; j < n && s[j] - s[i] <= lim; j++) {
      const d = s[j] - s[i];
      const w = Math.exp(-d * d * inv);
      wSum += w;
      acc += w * y[j];
    }
    out[i] = wSum > 0 ? acc / wSum : y[i];
  }
  return out;
}

function clampGrade(y: number[], s: number[], g: number): void {
  for (let i = 1; i < y.length; i++) {
    const ds = s[i] - s[i - 1];
    y[i] = Math.min(y[i - 1] + g * ds, Math.max(y[i - 1] - g * ds, y[i]));
  }
  for (let i = y.length - 2; i >= 0; i--) {
    const ds = s[i + 1] - s[i];
    y[i] = Math.min(y[i + 1] + g * ds, Math.max(y[i + 1] - g * ds, y[i]));
  }
}

/** Apply pin corrections, interpolated linearly by arc length between pins. */
function applyPins(y: number[], s: number[], pins: Map<number, number>): void {
  const idx = [...pins.keys()].sort((a, b) => a - b);
  if (idx.length === 0) return;
  const corr = idx.map((i) => pins.get(i)! - y[i]);
  let k = 0;
  for (let i = 0; i < y.length; i++) {
    while (k < idx.length - 1 && idx[k + 1] <= i) k++;
    let c: number;
    if (i <= idx[0]) c = corr[0];
    else if (i >= idx[idx.length - 1]) c = corr[corr.length - 1];
    else {
      const i0 = idx[k];
      const i1 = idx[k + 1];
      const u = s[i1] > s[i0] ? (s[i] - s[i0]) / (s[i1] - s[i0]) : 0;
      c = corr[k] + (corr[k + 1] - corr[k]) * u;
    }
    y[i] += c;
  }
}

export function profileWays(ways: OsmWay[], env: ProfileEnv): ProfiledWay[] {
  const { origin } = env;
  const mPerDegLat = origin.mPerDegLat;
  const mPerDegLon = origin.mPerDegLon;
  const seaFloor = env.seaRel + 0.3;

  const groundAt = (lat: number, lon: number): number => {
    const h = env.heightAt(lat, lon);
    return Math.max(Number.isFinite(h) ? h : 0, seaFloor);
  };
  /** Disc-averaged DEM: deterministic junction height, identical from any tile. */
  const junctionAt = (lat: number, lon: number): number => {
    const r = 8;
    const dLat = r / mPerDegLat;
    const dLon = r / mPerDegLon;
    let acc = groundAt(lat, lon) * 2;
    let w = 2;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      acc += groundAt(lat + Math.sin(a) * dLat, lon + Math.cos(a) * dLon);
      w++;
    }
    return acc / w;
  };

  // ---- pass 1: densify, classify, count shared nodes -------------------------
  const dense: Dense[][] = [];
  const structures: RoadStructure[] = [];
  const keyUse = new Map<string, { ground: number; structure: number }>();
  for (const way of ways) {
    const pts = densify(way, origin);
    dense.push(pts);
    const st = structureOf(way.tags);
    structures.push(st);
    for (const p of pts) {
      if (!p.key) continue;
      let u = keyUse.get(p.key);
      if (!u) {
        u = { ground: 0, structure: 0 };
        keyUse.set(p.key, u);
      }
      if (st === 'ground') u.ground++;
      else u.structure++;
    }
  }

  const pinCache = new Map<string, number>();
  const pinHeight = (key: string, lat: number, lon: number): number => {
    const cached = pinCache.get(key);
    if (cached !== undefined) return cached;
    const reg = env.registry.get(key);
    const y = reg && !reg.provisional ? reg.y : junctionAt(lat, lon);
    pinCache.set(key, y);
    return y;
  };

  /** Abutment height for a structure end that has no ground road in this tile. */
  const openEndHeight = (key: string, lat: number, lon: number, st: RoadStructure): number => {
    const reg = env.registry.get(key);
    if (reg && !reg.provisional) return reg.y;
    const g = junctionAt(lat, lon);
    if (st === 'bridge' && g < env.seaRel + 1) return env.seaRel + 9; // over water: keep a deck clearance
    return g;
  };

  const results: ProfiledWay[] = new Array(ways.length);

  // ---- pass 2: ground ways ---------------------------------------------------
  for (let w = 0; w < ways.length; w++) {
    if (structures[w] !== 'ground') continue;
    const way = ways[w];
    const pts = dense[w];
    if (pts.length < 2) {
      results[w] = { way, points: [], structure: 'ground', layer: 0 };
      continue;
    }
    const provBefore = env.provisionalCounter();
    const s = arcLengths(pts);
    const raw = pts.map((p) => groundAt(p.lat, p.lon));
    const hw = way.tags.highway ?? 'residential';
    const y = gaussianSmooth(raw, s, smoothSigma(hw));
    clampGrade(y, s, maxGradeFor(hw));
    const pins = new Map<number, number>();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const isEnd = i === 0 || i === pts.length - 1;
      if (!p.key) continue;
      const u = keyUse.get(p.key);
      const shared = u ? u.ground + u.structure > 1 : false;
      if (isEnd || shared) pins.set(i, pinHeight(p.key, p.lat, p.lon));
    }
    applyPins(y, s, pins);
    const provisional = env.provisionalCounter() > provBefore;
    for (const [i] of pins) {
      const k = pts[i].key!;
      const prev = env.registry.get(k);
      if (!prev || prev.provisional || !provisional) env.registry.set(k, { y: y[i], provisional });
    }
    results[w] = {
      way,
      points: pts.map((p, i) => ({ x: p.x, y: y[i], z: p.z })),
      structure: 'ground',
      layer: parseLayer(way.tags.layer),
    };
  }

  // ---- pass 3: bridge / tunnel chains -----------------------------------------
  const structIdx = ways.map((_, i) => i).filter((i) => structures[i] !== 'ground' && dense[i].length >= 2);
  const endKeys = (i: number): [string, string] => {
    const p = dense[i];
    return [p[0].key ?? `s${i}`, p[p.length - 1].key ?? `e${i}`];
  };
  const endHeight = (i: number, which: 0 | 1): number => {
    const p = dense[i][which === 0 ? 0 : dense[i].length - 1];
    const key = p.key ?? '';
    const u = key ? keyUse.get(key) : undefined;
    if (u && u.ground > 0) return pinHeight(key, p.lat, p.lon);
    return openEndHeight(key, p.lat, p.lon, structures[i]);
  };

  // Connected components of structure ways via shared end keys
  const byKey = new Map<string, number[]>();
  for (const i of structIdx) {
    for (const k of endKeys(i)) {
      const l = byKey.get(k) ?? [];
      l.push(i);
      byKey.set(k, l);
    }
  }
  const seen = new Set<number>();
  for (const start of structIdx) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (const k of endKeys(i)) {
        // only chain through joints that no ground road touches
        const u = keyUse.get(k);
        if (u && u.ground > 0) continue;
        for (const j of byKey.get(k) ?? []) {
          if (!seen.has(j) && structures[j] === structures[i]) {
            seen.add(j);
            stack.push(j);
          }
        }
      }
    }

    const ordered = orderChain(comp, endKeys, keyUse);
    if (ordered) {
      // One linear run: interpolate from first abutment to last by cumulative length
      const lens = ordered.map(({ i }) => {
        const s = arcLengths(dense[i]);
        return s[s.length - 1];
      });
      const total = lens.reduce((a, b) => a + b, 0) || 1;
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const y0 = endHeight(first.i, first.reversed ? 1 : 0);
      const y1 = endHeight(last.i, last.reversed ? 0 : 1);
      let acc = 0;
      for (let n = 0; n < ordered.length; n++) {
        const { i, reversed } = ordered[n];
        const pts = dense[i];
        const s = arcLengths(pts);
        const L = s[s.length - 1] || 1;
        const ys = pts.map((_, k) => {
          const along = reversed ? L - s[k] : s[k];
          return y0 + (y1 - y0) * ((acc + along) / total);
        });
        acc += lens[n];
        results[i] = makeStructure(ways[i], pts, ys, structures[i]);
      }
      registerEnds(env, dense, ordered.map((o) => o.i), results);
    } else {
      for (const i of comp) {
        const pts = dense[i];
        const s = arcLengths(pts);
        const L = s[s.length - 1] || 1;
        const y0 = endHeight(i, 0);
        const y1 = endHeight(i, 1);
        results[i] = makeStructure(ways[i], pts, s.map((v) => y0 + (y1 - y0) * (v / L)), structures[i]);
      }
      registerEnds(env, dense, comp, results);
    }
  }

  for (let w = 0; w < ways.length; w++) {
    if (!results[w]) results[w] = { way: ways[w], points: [], structure: structures[w], layer: 0 };
  }
  return results;
}

function makeStructure(way: OsmWay, pts: Dense[], ys: number[], st: RoadStructure): ProfiledWay {
  return {
    way,
    points: pts.map((p, k) => ({ x: p.x, y: ys[k], z: p.z })),
    structure: st,
    layer: parseLayer(way.tags.layer),
  };
}

function registerEnds(env: ProfileEnv, dense: Dense[][], idx: number[], results: ProfiledWay[]): void {
  for (const i of idx) {
    const pts = dense[i];
    const r = results[i];
    if (!r || r.points.length < 2) continue;
    for (const k of [0, pts.length - 1]) {
      const key = pts[k].key;
      if (!key) continue;
      if (!env.registry.has(key)) env.registry.set(key, { y: r.points[k].y, provisional: false });
    }
  }
}

/** If the component is a simple path, return its ways in order (with direction). */
function orderChain(
  comp: number[],
  endKeys: (i: number) => [string, string],
  keyUse: Map<string, { ground: number; structure: number }>,
): Array<{ i: number; reversed: boolean }> | null {
  if (comp.length === 1) return [{ i: comp[0], reversed: false }];
  const deg = new Map<string, number[]>();
  for (const i of comp) {
    for (const k of endKeys(i)) {
      const l = deg.get(k) ?? [];
      l.push(i);
      deg.set(k, l);
    }
  }
  const ends = [...deg.entries()].filter(([, l]) => l.length === 1).map(([k]) => k);
  if (ends.length !== 2) return null;
  for (const [k, l] of deg) {
    if (l.length > 2) return null;
    const u = keyUse.get(k);
    if (l.length === 2 && u && u.ground > 0) return null;
  }
  const out: Array<{ i: number; reversed: boolean }> = [];
  const used = new Set<number>();
  let key = ends[0];
  while (out.length < comp.length) {
    const next = (deg.get(key) ?? []).find((i) => !used.has(i));
    if (next === undefined) return null;
    used.add(next);
    const [a, b] = endKeys(next);
    const reversed = b === key;
    out.push({ i: next, reversed });
    key = reversed ? a : b;
  }
  return out;
}

function parseLayer(raw: string | undefined): number {
  if (!raw) return 0;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? Math.max(-5, Math.min(5, v)) : 0;
}
