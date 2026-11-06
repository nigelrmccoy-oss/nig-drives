/**
 * D→R performance index from the compiled PhysicsSpec (not GT/Forza tables).
 * Uses peak power, mass, tyre μ, and a rough top-speed proxy.
 */
import type { PhysicsSpec } from '../physics/PhysicsSpec';
import { peakPower } from '../physics/PhysicsSpec';

export type PiClass = 'D' | 'C' | 'B' | 'A' | 'S' | 'R';

export interface PiResult {
  score: number;
  class: PiClass;
  powerKw: number;
  powerWeight: number;
}

const BANDS: { c: PiClass; min: number }[] = [
  { c: 'R', min: 900 },
  { c: 'S', min: 750 },
  { c: 'A', min: 600 },
  { c: 'B', min: 450 },
  { c: 'C', min: 300 },
  { c: 'D', min: 0 },
];

export function ratePi(spec: PhysicsSpec): PiResult {
  const powerW = peakPower(spec.engine.torqueCurve, spec.engine.limiterRpm).watts;
  const powerKw = powerW / 1000;
  const mass = Math.max(500, spec.chassis.mass);
  const pw = powerKw / (mass / 1000); // kW per tonne
  const mu = spec.tire.mu;
  const topProxy = Math.pow((2 * powerW) / (1.225 * Math.max(0.3, spec.chassis.cdA)), 1 / 3); // m/s drag-limited-ish
  // Weighted score ~ Forza-ish 100–999 band
  const score = Math.round(
    Math.min(998, Math.max(100, pw * 2.8 + mu * 180 + topProxy * 3.2 + (spec.engine.redlineRpm / 100) * 0.4)),
  );
  const cls = BANDS.find((b) => score >= b.min)!.c;
  return { score, class: cls, powerKw, powerWeight: pw };
}

export function piBadge(r: PiResult): string {
  return `${r.class} ${r.score}`;
}
