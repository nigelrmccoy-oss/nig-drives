import type { TireSpec } from './PhysicsSpec';

/**
 * v1.4.0 tyre model: a "Pacejka-lite" magic formula on combined slip.
 * Longitudinal slip ratio and slip angle are each normalised by their peak, so the
 * friction circle falls out naturally: braking or wheelspin eats cornering grip and
 * vice versa. Past the peak the force falls off (C sets how much), which is what makes
 * a slide feel like a slide instead of an invisible wall.
 */

export interface TireOut {
  fx: number;
  fy: number;
  /** Combined normalised slip: < 1 gripping, 1 = peak, > 1 sliding. */
  slip: number;
  /** Secant slope dFx/dκ (N per unit slip ratio), for the implicit wheel-spin update. */
  kLong: number;
  /** Friction available at this load (μ_eff · Fz). */
  limit: number;
}

/** Share of peak grip a fully sliding tyre keeps. */
const SLIDE_FLOOR = 0.8;

/** B such that sin(C·atan(B·s)) peaks exactly at s = 1. */
export function shapeB(C: number): number {
  return Math.tan(Math.PI / (2 * C));
}

export function magic(s: number, C: number, B: number): number {
  return Math.sin(C * Math.atan(B * s));
}

/**
 * Forces in the wheel frame. kappa = slip ratio ((ωr − v)/|v|), tanAlpha = tan(slip angle)
 * (positive when the contact patch slides left), surfaceMu scales μ, surfaceGrip < 1 also
 * flattens the curve (gravel / grass slide more progressively).
 */
export function tireForces(
  t: TireSpec,
  fz: number,
  fzNominal: number,
  kappa: number,
  tanAlpha: number,
  surfaceMu: number,
  surfaceGrip: number,
  out: TireOut,
): TireOut {
  if (fz <= 0) {
    out.fx = 0;
    out.fy = 0;
    out.slip = 0;
    out.kLong = 0;
    out.limit = 0;
    return out;
  }
  const loadRatio = fz / Math.max(1, fzNominal);
  const mu = t.mu * surfaceMu * Math.max(0.6, 1 - t.loadSensitivity * (loadRatio - 1));
  const C = Math.max(1.15, t.C - (1 - Math.min(1, surfaceGrip)) * 0.6);
  const B = shapeB(C);
  const sx = kappa / t.peakSlip;
  // the peak slip angle grows with load (a loaded tyre needs more angle), so a nose-heavy car's
  // front axle saturates first: natural, load-driven understeer instead of a neutral knife edge
  const sy = tanAlpha / (Math.tan(t.peakAngle) * Math.sqrt(Math.min(2, Math.max(0.3, loadRatio))));
  const s = Math.hypot(sx, sy);
  const limit = mu * fz;
  out.limit = limit;
  out.slip = s;
  if (s < 1e-6) {
    out.fx = 0;
    out.fy = 0;
    out.kLong = (limit * C * B) / t.peakSlip;
    return out;
  }
  // past the peak a sliding tyre keeps most of its grip (~80 %), it doesn't fall off a cliff
  const f = limit * (s > 1 ? Math.max(magic(s, C, B), SLIDE_FLOOR) : magic(s, C, B));
  const perS = f / s;
  out.fx = perS * sx;
  out.fy = -perS * sy;
  out.kLong = perS / t.peakSlip;
  return out;
}