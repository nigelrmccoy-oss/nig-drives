import type { PhysicsSpec } from '../PhysicsSpec';

/**
 * Tesla Model 3 Long Range AWD (2024 "Highland"), hand-written spec.
 *
 * Reference numbers only (no assets or code copied): motor torque-curve shapes follow
 * Nigel's BeamNG Model 3 mod; levels, mass, size, tyres and performance follow Tesla's
 * public data (0–100 km/h 4.4 s, 201 km/h, 1830 kg kerb, 2875 mm wheelbase, 235/45 R18).
 * Rear permanent-magnet motor + front induction motor, one 9.03:1 reduction each, no gears.
 */
export const MODEL3_LR_AWD: PhysicsSpec = {
  id: 'model3_lr_awd',
  source: 'Tesla public data + BeamNG Model 3 mod (reference values)',
  drive: 'awd',
  chassis: {
    mass: 1905, // 1830 kg kerb + driver
    wheelbase: 2.875,
    frontWeight: 0.47,
    cgHeight: 0.46, // battery in the floor: low centre of gravity
    trackFront: 1.584,
    trackRear: 1.584,
    yawInertia: 3100,
    cdA: 0.49, // Cd 0.219 × 2.22 m²
    rollStiffnessFront: 0.72, // stiff front bar: safe, mild understeer like the real car
    rollGradient: 0.05,
    pitchGradient: 0.025,
    bodyFreqHz: 1.7,
    bodyDamping: 0.5,
  },
  tire: {
    radius: 0.336, // 235/45 R18
    widthM: 0.235,
    mu: 1.06, // Michelin Primacy All-Season / Pilot Sport EV class
    C: 1.6,
    peakSlip: 0.1,
    peakAngle: 0.12,
    loadSensitivity: 0.08,
    rollingRes: 0.009,
    relaxLength: 0.35,
    inertia: 1.3,
  },
  // Placeholder engine / gearbox: the EV block below drives the car. The curve is the
  // rear motor's so the Dyno and generic readouts still have something sensible.
  engine: {
    fuel: 'electric',
    torqueCurve: [
      { rpm: 0, nm: 430 },
      { rpm: 5000, nm: 430 },
      { rpm: 16000, nm: 100 },
    ],
    idleRpm: 0,
    redlineRpm: 16000,
    limiterRpm: 16000,
    inertia: 0.06,
    frictionNm: 0,
    frictionPerKrpm: 0,
  },
  gearbox: {
    ratios: [1],
    reverse: 1,
    finalDrive: 9.03,
    efficiency: 0.95,
    shiftTimeS: 0,
    upshiftRpm: 16000,
    downshiftRpm: 0,
  },
  clutch: { maxTorqueNm: 10000 },
  diff: { type: 'open', preloadNm: 0, lockCoef: 0 },
  brakes: { frontNm: 3000, rearNm: 1300, handbrakeNm: 1200 },
  steering: { maxAngle: 0.5, halfLockSpeed: 30 }, // 11.7 m turning circle
  assists: { abs: true, tcs: true, stability: true },
  ev: {
    reduction: 9.03,
    maxMotorRpm: 16000,
    motors: [
      {
        axle: 'rear', // permanent-magnet synchronous reluctance
        torqueCurve: [
          { rpm: 0, nm: 430 },
          { rpm: 5000, nm: 430 },
          { rpm: 6000, nm: 390 },
          { rpm: 7000, nm: 332 },
          { rpm: 9000, nm: 290 },
          { rpm: 10000, nm: 250 },
          { rpm: 12000, nm: 185 },
          { rpm: 14000, nm: 125 },
          { rpm: 16000, nm: 100 },
        ],
        maxPowerW: 235000,
        inertia: 0.055,
      },
      {
        axle: 'front', // induction
        torqueCurve: [
          { rpm: 0, nm: 270 },
          { rpm: 6000, nm: 270 },
          { rpm: 7000, nm: 250 },
          { rpm: 8000, nm: 230 },
          { rpm: 9000, nm: 207 },
          { rpm: 10000, nm: 180 },
          { rpm: 13000, nm: 135 },
          { rpm: 16000, nm: 101 },
        ],
        maxPowerW: 175000,
        inertia: 0.045,
      },
    ],
    systemPowerW: 350000, // 366 kW nameplate; ~350 kW at the wheels-side inverter limit
    topSpeedKmh: 201,
    responseS: 0.03,
    regenDecel: 1.96, // ≈ 0.2 g lift-off
    regenMaxPowerW: 110000,
    regenFrontShare: 0.45,
    batteryKWh: 75,
    startSoc: 0.8,
    efficiency: 0.92,
  },
};