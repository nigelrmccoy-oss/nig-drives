import type { SuspensionSpec } from './PhysicsSpec';
import type { VehicleSpec } from '../vehicles/Vehicle';

/** Derive a plausible stock suspension from mass / wheelbase when no sheet exists. */
export function suspensionFromMass(
  massKg: number,
  wheelbaseM: number,
  frontBias = 0.55,
  provenance: 'sourced' | 'estimated' = 'estimated',
): SuspensionSpec {
  // Target ~1.3–1.6 Hz heave; k = (2πf)² · m_corner
  const f = 1.35;
  const omega = 2 * Math.PI * f;
  const mF = (massKg * frontBias) / 2;
  const mR = (massKg * (1 - frontBias)) / 2;
  const springFront = Math.round(mF * omega * omega);
  const springRear = Math.round(mR * omega * omega);
  const dampF = Math.round(2 * 0.35 * Math.sqrt(springFront * mF));
  const dampR = Math.round(2 * 0.35 * Math.sqrt(springRear * mR));
  const ride = Math.round(120 + Math.min(80, wheelbaseM * 25));
  return {
    rideHeightMm: ride,
    springFront,
    springRear,
    damperBumpFront: dampF,
    damperBumpRear: dampR,
    damperReboundFront: Math.round(dampF * 1.15),
    damperReboundRear: Math.round(dampR * 1.15),
    arbFront: Math.round(springFront * 0.55),
    arbRear: Math.round(springRear * 0.45),
    provenance,
  };
}

export function suspensionForVehicleSpec(vs: VehicleSpec): SuspensionSpec {
  return suspensionFromMass(vs.mass, vs.wheelbase, vs.frontBias, 'estimated');
}
