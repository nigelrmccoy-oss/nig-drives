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
    heatGain: c.family === 'race' ? 1.35 : c.family === 'sport' ? 1.15 : c.family === 'winter' ? 0.55 : c.family === 'rally' ? 0.9 : 1.0,
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
 * Advance core temperature from dissipated contact-patch slip power (watts), not normalised slip.
 * speed m/s; fz N.
 * Returns new temp °C.
 */
export function stepTyreTemp(
  tempC: number,
  dt: number,
  slipPowerW: number,
  speedMs: number,
  fz: number,
  p: HeatParams,
): number {
  // Effective heated tread/belt: 3 kJ/K (~2 kg rubber at 1.5 kJ/kg/K).
  // 60% of slip work enters the tyre; conduction into the core is limited by
  // surface heat rejection (20 kW transfer knee), rather than instantly depositing
  // every burnout watt in the core. Rolling hysteresis: Crr=0.012, 75% retained.
  // Loss conductance: 18 W/K still-air + 1.5 W/K per m/s of airflow.
  // These are sandbox estimates, not measured OEM thermal parameters.
  const power = Math.max(0, slipPowerW);
  const slipHeatW = 0.6 * p.heatGain * power / (1 + power / 20_000);
  const rollHeatW = 0.75 * 0.012 * Math.max(0, fz) * Math.abs(speedMs);
  const conductance = (18 + 1.5 * Math.abs(speedMs)) * p.coolGain;
  // Exact first-order update stays stable even on a long frame.
  const equilibrium = p.ambientC + (slipHeatW + rollHeatW) / conductance;
  let next = equilibrium + (tempC - equilibrium) * Math.exp(-conductance * Math.max(0, dt) / 3000);
  if (!Number.isFinite(next)) next = p.ambientC;
  return Math.max(p.ambientC - 5, Math.min(140, next));
}
