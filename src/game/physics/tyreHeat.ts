/**
 * Per-wheel tyre core temperature (°C) and grip multiplier vs optimum window.
 * Heat from slip work + rolling; cool from ambient + airflow.
 */
import type { CompoundId } from '../save/types';
import { COMPOUNDS } from '../tuning/compounds';

export interface HeatParams {
  optTempC: number;
  windowC: number;
  heatGain: number;
  coolGain: number;
  ambientC: number;
}

export function heatParamsForCompound(id: CompoundId | string | undefined, ambientC = 22): HeatParams {
  const c = COMPOUNDS[(id as CompoundId) || 'all_season'] ?? COMPOUNDS.all_season;
  // Race rubber wants hotter; winter cooler
  let opt = 85;
  if (c.family === 'race') opt = 95;
  else if (c.family === 'sport') opt = 88;
  else if (c.family === 'winter') opt = 45;
  else if (c.family === 'rally') opt = 70;
  else opt = 75;
  return {
    optTempC: opt,
    windowC: c.family === 'race' ? 18 : 28,
    heatGain: c.family === 'race' ? 1.35 : c.family === 'sport' ? 1.15 : 1.0,
    coolGain: 1.0,
    ambientC,
  };
}

/** Grip scale 0.55–1.05 from |T − opt| / window. */
export function gripFromTemp(tempC: number, opt: number, window: number): number {
  const x = Math.abs(tempC - opt) / Math.max(5, window);
  if (x <= 0.35) return 1.02 - x * 0.05;
  if (x <= 1) return 1.0 - (x - 0.35) * 0.35;
  return Math.max(0.55, 0.75 - (x - 1) * 0.2);
}

/**
 * Advance core temp. slip = combined normalised slip; speed m/s; fz N.
 * Returns new temp °C.
 */
export function stepTyreTemp(
  tempC: number,
  dt: number,
  slip: number,
  speedMs: number,
  fz: number,
  p: HeatParams,
): number {
  const work = Math.min(4, Math.abs(slip)) * (fz / 4000) * p.heatGain;
  const roll = (Math.abs(speedMs) / 40) * 0.35 * p.heatGain;
  const heat = (work + roll) * 18; // °C/s scale
  const air = 0.15 + Math.min(1.2, Math.abs(speedMs) / 35) * p.coolGain;
  const cool = (tempC - p.ambientC) * air * 0.55;
  let next = tempC + (heat - cool) * dt;
  if (!Number.isFinite(next)) next = p.ambientC;
  return Math.max(p.ambientC - 5, Math.min(140, next));
}
