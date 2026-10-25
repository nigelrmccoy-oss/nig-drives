/**
 * v1.4.0 physics spec: everything the drivetrain / tyre / chassis model needs for one car,
 * in SI units. Hand-written for the headline cars (Golf 1.9 TDI), derived from the
 * legacy VehicleSpec for every other generated vehicle (see deriveSpec.ts).
 */

export type DriveLayout = 'fwd' | 'rwd' | 'awd';

export interface TorquePoint {
  rpm: number;
  nm: number;
}

export interface TurboSpec {
  /** Peak boost (bar over ambient). Display only; torque comes from boostShare. */
  maxBoostBar: number;
  /** Exhaust flow starts spinning the turbo here… */
  spoolStartRpm: number;
  /** …and can hold full boost from here. */
  fullBoostRpm: number;
  /** First-order spool lag (s). */
  lagS: number;
  /** Fraction of the full-load curve that needs boost (rest is available off-boost). */
  boostShare: number;
}

export interface EngineSpec {
  fuel: 'diesel' | 'petrol';
  /** Full-load torque (with full boost if turbocharged), ascending rpm. */
  torqueCurve: TorquePoint[];
  idleRpm: number;
  /** Where the tacho goes red / the auto box upshifts at full throttle. */
  redlineRpm: number;
  /** Fuel cut. */
  limiterRpm: number;
  /** Crank + flywheel + clutch disc (kg·m²). */
  inertia: number;
  /** Closed-throttle drag torque: frictionNm + frictionPerKrpm × rpm/1000. */
  frictionNm: number;
  frictionPerKrpm: number;
  turbo?: TurboSpec;
}

export interface GearboxSpec {
  /** Forward ratios, 1st first. */
  ratios: number[];
  reverse: number;
  finalDrive: number;
  /** Mechanical efficiency engine → wheels. */
  efficiency: number;
  /** Clutch-open time of a shift (s). */
  shiftTimeS: number;
  /** Auto box: full-throttle upshift rpm (light throttle shifts earlier). */
  upshiftRpm: number;
  /** Auto box: downshift below this rpm. */
  downshiftRpm: number;
}

export interface ClutchSpec {
  /** Torque the clutch can carry fully engaged (Nm). */
  maxTorqueNm: number;
}

export interface DiffSpec {
  type: 'open' | 'lsd';
  preloadNm: number;
  /** LSD: locking torque per Nm of input torque. */
  lockCoef: number;
}

export interface BrakeSpec {
  /** Max brake torque per wheel at full pedal (Nm). */
  frontNm: number;
  rearNm: number;
  handbrakeNm: number;
}

export interface TireSpec {
  radius: number;
  widthM: number;
  /** Peak friction coefficient on dry asphalt at nominal load. */
  mu: number;
  /** Magic-formula shape factor (higher = sharper peak, less grip once sliding). */
  C: number;
  /** Slip ratio at peak longitudinal force. */
  peakSlip: number;
  /** Slip angle at peak lateral force (rad). */
  peakAngle: number;
  /** Grip loss per unit of load above nominal (μ = mu × (1 − k × (Fz/Fz0 − 1))). */
  loadSensitivity: number;
  /** Rolling resistance coefficient. */
  rollingRes: number;
  /** Lateral relaxation length (m): slip angle builds over this rolling distance. */
  relaxLength: number;
  /** Wheel + tyre + brake disc (kg·m²). */
  inertia: number;
}

export interface ChassisSpec {
  mass: number;
  wheelbase: number;
  /** Static fraction of weight on the front axle. */
  frontWeight: number;
  cgHeight: number;
  trackFront: number;
  trackRear: number;
  /** Yaw moment of inertia (kg·m²). */
  yawInertia: number;
  /** Drag area Cd × A (m²). */
  cdA: number;
  /** Front share of roll stiffness (more = more understeer). */
  rollStiffnessFront: number;
  /** Body roll per g of lateral acceleration (rad). */
  rollGradient: number;
  /** Body pitch per g of longitudinal acceleration (rad). */
  pitchGradient: number;
  /** Sprung-mass natural frequency (Hz) and damping ratio for roll / pitch. */
  bodyFreqHz: number;
  bodyDamping: number;
}

export interface SteeringSpec {
  /** Road-wheel angle at full lock (rad). */
  maxAngle: number;
  /** Speed (m/s) at which the speed-sensitive lock limit has halved (keyboard / pad). */
  halfLockSpeed: number;
}

export interface AssistDefaults {
  abs: boolean;
  tcs: boolean;
  stability: boolean;
}

export interface RegenSpec {
  /** Coast regen as a deceleration (m/s²) at speed, faded out below ~2 m/s. */
  coastDecel: number;
  /** Extra stopping force from the pedal (multiplier on friction brakes). */
  brakeMul: number;
}

export interface PhysicsSpec {
  id: string;
  /** Where the numbers came from (shown in docs / future telemetry). */
  source: string;
  drive: DriveLayout;
  chassis: ChassisSpec;
  tire: TireSpec;
  engine: EngineSpec;
  gearbox: GearboxSpec;
  clutch: ClutchSpec;
  diff: DiffSpec;
  brakes: BrakeSpec;
  steering: SteeringSpec;
  assists: AssistDefaults;
  regen?: RegenSpec;
}

/** Linear interpolation in a torque table (clamped at the ends). */
export function torqueAt(curve: TorquePoint[], rpm: number): number {
  if (curve.length === 0) return 0;
  if (rpm <= curve[0].rpm) return curve[0].nm;
  for (let i = 1; i < curve.length; i++) {
    const b = curve[i];
    if (rpm <= b.rpm) {
      const a = curve[i - 1];
      return a.nm + ((b.nm - a.nm) * (rpm - a.rpm)) / Math.max(1, b.rpm - a.rpm);
    }
  }
  return curve[curve.length - 1].nm;
}

/** Peak power (W) and the rpm it occurs at, scanning the curve. */
export function peakPower(curve: TorquePoint[], maxRpm: number): { watts: number; rpm: number } {
  let best = { watts: 0, rpm: 0 };
  for (let rpm = 500; rpm <= maxRpm; rpm += 25) {
    const w = (torqueAt(curve, rpm) * rpm * Math.PI) / 30;
    if (w > best.watts) best = { watts: w, rpm };
  }
  return best;
}