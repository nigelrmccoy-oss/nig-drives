import type { PhysicsSpec } from '../PhysicsSpec';

/**
 * VW Golf Mk4 1.9 TDI (ALH, 90 PS, 5-speed 02J), hand-written spec.
 *
 * Reference numbers only (no assets or code copied): the shape of the torque curve,
 * engine inertia / friction, turbo wastegate, brake torques and tyre size follow
 * Nigel's BeamNG "MIRROR Golf MK4 1.9TDI 3.0" mod; the level is calibrated to the
 * real ALH (≈210 Nm at 1900 rpm, 66 kW at 4000 rpm) and the real 02J ratios.
 * Targets: 0–100 km/h ≈ 11–12 s, top speed ≈ 180 km/h.
 */
export const GOLF_19TDI: PhysicsSpec = {
  id: 'golf_19tdi',
  source: 'VW ALH / 02J public data + BeamNG MIRROR Golf MK4 1.9TDI mod (reference values)',
  drive: 'fwd',
  chassis: {
    mass: 1275, // 1200 kg kerb (VW data, 90 PS) + driver; VW quotes 0-100 12.0-12.4 s, 180 km/h
    wheelbase: 2.51,
    frontWeight: 0.61,
    cgHeight: 0.52,
    trackFront: 1.513,
    trackRear: 1.494,
    yawInertia: 1900,
    cdA: 0.63, // Cd 0.315 × 2.0 m²
    rollStiffnessFront: 0.7, // front anti-roll bar, soft rear twist beam: stable FWD hatch
    rollGradient: 0.07, // ≈ 4° per g
    pitchGradient: 0.035,
    bodyFreqHz: 1.5,
    bodyDamping: 0.45,
  },
  tire: {
    radius: 0.314, // 205/60 R15
    widthM: 0.205,
    mu: 1.0,
    C: 1.6,
    peakSlip: 0.11,
    peakAngle: 0.14,
    loadSensitivity: 0.08,
    rollingRes: 0.012,
    relaxLength: 0.35,
    inertia: 0.95,
  },
  engine: {
    fuel: 'diesel',
    // Mod curve shape (big mid-range hump, falls away after the peak), real ALH level.
    torqueCurve: [
      { rpm: 0, nm: 0 },
      { rpm: 600, nm: 80 },
      { rpm: 850, nm: 105 },
      { rpm: 1250, nm: 140 },
      { rpm: 1600, nm: 185 },
      { rpm: 1900, nm: 210 },
      { rpm: 2500, nm: 205 },
      { rpm: 3000, nm: 202 },
      { rpm: 3500, nm: 182 },
      { rpm: 4000, nm: 158 },
      { rpm: 4500, nm: 128 },
      { rpm: 5000, nm: 70 },
    ],
    idleRpm: 850,
    redlineRpm: 4500,
    limiterRpm: 5000,
    inertia: 0.18, // mod engine inertia
    frictionNm: 14,
    frictionPerKrpm: 5,
    turbo: { maxBoostBar: 0.91, spoolStartRpm: 1250, fullBoostRpm: 1900, lagS: 0.45, boostShare: 0.35 },
  },
  gearbox: {
    ratios: [3.78, 2.12, 1.36, 0.97, 0.76],
    reverse: 3.6,
    finalDrive: 3.39,
    efficiency: 0.92,
    shiftTimeS: 0.25,
    upshiftRpm: 4600,
    downshiftRpm: 1350,
  },
  clutch: { maxTorqueNm: 330 },
  diff: { type: 'open', preloadNm: 0, lockCoef: 0 },
  brakes: { frontNm: 1500, rearNm: 520, handbrakeNm: 900 },
  steering: { maxAngle: 0.45, halfLockSpeed: 28 },
  assists: { abs: true, tcs: true, stability: true },
};