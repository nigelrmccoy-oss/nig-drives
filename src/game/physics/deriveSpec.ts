import type { VehicleSpec } from '../vehicles/Vehicle';
import { peakPower, type PhysicsSpec, type TorquePoint } from './PhysicsSpec';
import { GOLF_19TDI } from './specs/golf19tdi';
import { MODEL3_LR_AWD } from './specs/model3LrAwd';

const G = 9.81;
const RHO = 1.225;

/** Hand-written specs win; everything else is derived so all generated vehicles keep driving. */
const HAND_SPECS: Record<string, PhysicsSpec> = {
  golf_19tdi: GOLF_19TDI,
  model3_lr_awd: MODEL3_LR_AWD,
};

export function physicsSpecFor(spec: VehicleSpec): PhysicsSpec {
  return HAND_SPECS[spec.id] ?? derivePhysicsSpec(spec);
}

/**
 * Build a physical spec from a legacy arcade VehicleSpec so the generated Golfs and buses
 * keep their character (relative power, grip, size, brakes) on the new model.
 * Power ≈ 7 W per (kg · legacy accel); gearing is chosen so top gear meets peak power
 * at the drag-limited top speed (buses: at their legacy governed speed).
 */
export function derivePhysicsSpec(spec: VehicleSpec): PhysicsSpec {
  const bus = spec.class === 'bus';
  const diesel = bus || spec.id.includes('tdi');
  const radius = bus ? 0.48 : 0.315;
  const idleRpm = bus ? 650 : 850;
  const redlineRpm = bus ? 2400 : diesel ? 4500 : spec.id.includes('vr6') ? 6800 : 6200;
  const cdA = bus ? 0.62 * spec.width * spec.height : 0.33 * spec.width * spec.height * 0.85;
  const crr = bus ? 0.009 : 0.012;
  const efficiency = bus ? 0.88 : 0.91;

  const powerW = 7 * spec.mass * spec.accel;

  // Torque curve: a shape per fuel type over rpm / redline, scaled to the target peak power.
  const shape: [number, number][] = diesel
    ? [[0, 0], [idleRpm / redlineRpm, 0.55], [0.3, 0.9], [0.4 + spec.torquePeak * 0.2, 1], [0.65, 0.95], [0.88, 0.76], [1, 0.62], [1.1, 0.3]]
    : [[0, 0], [idleRpm / redlineRpm, 0.62], [0.3, 0.84], [0.35 + spec.torquePeak * 0.5, 1], [0.7, 0.97], [0.88, 0.86], [1, 0.74], [1.08, 0.4]];
  const unit: TorquePoint[] = shape.map(([x, k]) => ({ rpm: Math.round(x * redlineRpm), nm: k }));
  const unitPeak = peakPower(unit, redlineRpm);
  const scale = powerW / Math.max(1, unitPeak.watts);
  const torqueCurve = unit.map((p) => ({ rpm: p.rpm, nm: Math.round(p.nm * scale * 10) / 10 }));
  const peakTorque = Math.max(...torqueCurve.map((p) => p.nm));

  const ratios = bus
    ? spec.id.includes('hybrid')
      ? [3.49, 1.86, 1.41, 1.0, 0.75, 0.65]
      : [3.49, 1.86, 1.41, 1.0, 0.75]
    : spec.id.includes('vr6')
      ? [3.78, 2.12, 1.36, 1.03, 0.84, 0.68]
      : [3.78, 2.12, 1.36, 0.97, 0.76];

  // Drag-limited top speed for this power (bisection), then gear top to peak power there.
  const wheelPower = powerW * efficiency;
  let lo = 5;
  let hi = 120;
  for (let i = 0; i < 40; i++) {
    const v = (lo + hi) / 2;
    const need = 0.5 * RHO * cdA * v * v * v + crr * spec.mass * G * v;
    if (need > wheelPower) hi = v;
    else lo = v;
  }
  const vTop = bus ? Math.min(lo, spec.maxSpeed * 1.15) : lo;
  const matchRpm = bus ? redlineRpm * 0.95 : unitPeak.rpm;
  const finalDrive = ((matchRpm * Math.PI) / 30) * radius / (vTop * ratios[ratios.length - 1]);

  // Brakes: legacy brakeForce (m/s² at full pedal) → torque, front-biased.
  const brakeTotal = spec.mass * spec.brakeForce * radius * 0.62;
  const frontShare = bus ? 0.55 : Math.min(0.78, spec.frontBias + 0.12);

  const regen =
    spec.coastRegen > 0 || spec.regenBrakeMul > 1
      ? { coastDecel: spec.coastRegen * 0.45, brakeMul: spec.regenBrakeMul }
      : undefined;

  return {
    id: spec.id,
    source: 'derived from legacy VehicleSpec (derivePhysicsSpec)',
    drive: bus ? 'rwd' : 'fwd',
    chassis: {
      mass: spec.mass,
      wheelbase: spec.wheelbase,
      frontWeight: bus ? 0.38 : spec.frontBias,
      cgHeight: spec.cgHeight,
      trackFront: spec.track,
      trackRear: spec.track,
      yawInertia: (spec.mass * (spec.length * spec.length + spec.width * spec.width)) / 12 * 0.9,
      cdA,
      rollStiffnessFront: bus ? 0.55 : 0.68,
      rollGradient: bus ? 0.05 : 0.07,
      pitchGradient: bus ? 0.02 : 0.035,
      bodyFreqHz: bus ? 1.1 : 1.45,
      bodyDamping: bus ? 0.5 : 0.45,
      rearDualTyres: bus,
    },
    tire: {
      radius,
      widthM: bus ? 0.3 : 0.195,
      mu: spec.gripMu * 0.87,
      C: bus ? 1.45 : 1.6,
      peakSlip: bus ? 0.14 : 0.11,
      peakAngle: bus ? 0.16 : 0.14,
      loadSensitivity: bus ? 0.05 : 0.08,
      rollingRes: crr,
      relaxLength: bus ? 0.6 : 0.35,
      inertia: bus ? 14 : 1.1,
    },
    engine: {
      fuel: diesel ? 'diesel' : 'petrol',
      torqueCurve,
      idleRpm,
      redlineRpm,
      limiterRpm: Math.round(redlineRpm * (diesel ? 1.08 : 1.04)),
      inertia: bus ? 3.0 : 0.2,
      frictionNm: bus ? 60 : 12,
      frictionPerKrpm: bus ? 40 : 4,
    },
    gearbox: {
      ratios,
      reverse: bus ? 4.0 : 3.6,
      finalDrive,
      efficiency,
      shiftTimeS: bus ? 0.5 : 0.3,
      upshiftRpm: Math.round(redlineRpm * 0.93),
      downshiftRpm: Math.round(Math.max(idleRpm * 1.5, redlineRpm * 0.32)),
    },
    clutch: { maxTorqueNm: peakTorque * 1.6 },
    diff: { type: 'open', preloadNm: 0, lockCoef: 0 },
    brakes: {
      frontNm: (brakeTotal * frontShare) / 2,
      rearNm: (brakeTotal * (1 - frontShare)) / 2,
      handbrakeNm: bus ? 0 : 900,
    },
    steering: { maxAngle: spec.steerLock * (bus ? 1 : 0.82), halfLockSpeed: bus ? 16 : 28 },
    assists: { abs: true, tcs: true, stability: true },
    regen,
  };
}