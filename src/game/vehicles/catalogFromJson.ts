/**
 * Map a checked catalog car JSON into VehicleSpec + PhysicsSpec using real
 * gearing / redline / torque curve / mass. Does not invent Golf-style defaults.
 */
import type { CatalogCar } from '../../data/cars';
import type { VehicleSpec } from './Vehicle';
import type { DriveLayout, PhysicsSpec, TorquePoint } from '../physics/PhysicsSpec';

function tyreRadiusM(sizes: string[] | null | undefined): number {
  const list = sizes ?? [];
  let best: number | null = null;
  for (const t of list) {
    const m = t.match(/(\d{3})\s*\/\s*(\d{2})\s*[A-Z]*R?\s*(\d{2})/i);
    if (m) {
      const w = +m[1], a = +m[2], r = +m[3];
      best = (r * 25.4) / 2 / 1000 + (w * a) / 100 / 1000;
      continue;
    }
    const m2 = t.match(/(\d{3})\s*[A-Z]*R?\s*(\d{2})\b/i);
    if (m2) {
      const w = +m2[1], r = +m2[2];
      best = (r * 25.4) / 2 / 1000 + (w * 0.8) / 1000;
    }
  }
  return best ?? 0.31;
}

function tyreWidthM(sizes: string[] | null | undefined): number {
  for (const t of sizes ?? []) {
    const m = t.match(/(\d{3})\s*\//);
    if (m) return +m[1] / 1000;
  }
  return 0.205;
}

function driveLayout(dt: string): DriveLayout {
  const d = dt.toUpperCase();
  if (d.includes('4WD') || d.includes('AWD') || d === '4X4') return 'awd';
  if (d === 'FF' || d === 'FWD' || d.includes('FRONT')) return 'fwd';
  return 'rwd'; // FR, RR, MR, etc.
}

function fuelOf(car: CatalogCar): 'diesel' | 'petrol' {
  const asp = (car.engine?.aspiration || '').toLowerCase();
  const model = `${car.make} ${car.model} ${car.trim || ''}`.toLowerCase();
  if (asp.includes('diesel') || model.includes('tdci') || model.includes('tdi') || model.includes('diesel')) return 'diesel';
  return 'petrol';
}

function turboish(car: CatalogCar): boolean {
  const a = (car.engine?.aspiration || '').toLowerCase();
  return a.includes('turbo') || a.includes('charg');
}

export function catalogDisplayName(car: CatalogCar): string {
  const trim = car.trim && !car.model.includes(car.trim) ? ` ${car.trim}` : '';
  return `${car.make} ${car.model}${trim}`.trim();
}

export function vehicleSpecFromCatalog(slug: string, car: CatalogCar): VehicleSpec {
  const length = (car.length_mm ?? 4200) / 1000;
  const width = (car.width_mm ?? 1750) / 1000;
  const height = (car.height_mm ?? 1400) / 1000;
  const wheelbase = (car.wheelbase_mm ?? Math.round(length * 0.58 * 1000)) / 1000;
  const track =
    ((car.track_front_mm ?? car.track_rear_mm ?? Math.round(width * 0.85 * 1000)) as number) / 1000;
  const frontBias = car.weight_dist_front_pct != null ? car.weight_dist_front_pct / 100 : 0.52;
  const topMs = car.top_speed_kmh != null ? car.top_speed_kmh / 3.6 : Math.max(40, (car.peak_power_kw / car.curb_mass_kg) * 180);
  const est = !!car.redline_estimated;
  return {
    id: slug,
    name: catalogDisplayName(car) + (est ? ' · est. redline' : ''),
    class: 'pack',
    variantLabel: `${car.year} · ${Math.round(car.peak_power_kw)} kW${est ? ' · est.' : ''}`,
    mass: car.curb_mass_kg + 75, // kerb + driver
    accel: Math.max(2, (car.peak_power_kw * 1000) / ((car.curb_mass_kg + 75) * 12)),
    ratedPowerKw: car.peak_power_kw,
    maxSpeed: topMs,
    brakeForce: 16 + Math.min(6, car.peak_power_kw / 80),
    wheelbase,
    track,
    gripMu: 1.05 + Math.min(0.2, car.peak_power_kw / 1500),
    steerLock: 0.52,
    steerSpeed: 3.0,
    cgHeight: Math.min(0.7, height * 0.38),
    frontBias,
    cameraHeight: 2.8 + height * 0.4,
    cameraDistance: 6.5 + length * 0.55,
    length,
    width,
    height,
    torquePeak: Math.min(0.7, car.peak_torque_rpm / Math.max(1, car.redline_rpm)),
    lowEndMul: turboish(car) ? 1.25 : 1.08,
    powerFadeExp: turboish(car) ? 1.5 : 1.3,
    soundPitch: fuelOf(car) === 'diesel' ? 0.7 : 0.95 + Math.min(0.3, car.redline_rpm / 20000),
    regenBrakeMul: 1,
    coastRegen: 0,
  };
}

export function physicsSpecFromCatalog(slug: string, car: CatalogCar): PhysicsSpec {
  const vs = vehicleSpecFromCatalog(slug, car);
  const radius = tyreRadiusM(car.tyre_sizes);
  const redlineRpm = car.redline_rpm;
  const idleRpm = fuelOf(car) === 'diesel' ? 750 : 850;
  const curve: TorquePoint[] =
    car.torque_curve && car.torque_curve.length >= 2
      ? car.torque_curve.map(([rpm, nm]) => ({ rpm, nm }))
      : [
          { rpm: idleRpm, nm: car.peak_torque_nm * 0.55 },
          { rpm: car.peak_torque_rpm, nm: car.peak_torque_nm },
          { rpm: car.peak_power_rpm, nm: (car.peak_power_kw * 9549) / car.peak_power_rpm },
          { rpm: redlineRpm, nm: ((car.peak_power_kw * 9549) / car.peak_power_rpm) * 0.75 },
        ];
  const peakTorque = Math.max(...curve.map((p) => p.nm));
  const ratios = car.gear_ratios.slice();
  const finalDrive = car.final_drive;
  const cdA = 0.32 * vs.width * vs.height;
  const crr = 0.012;
  const drive = driveLayout(car.drivetrain);
  const trackF = (car.track_front_mm ?? vs.track * 1000) / 1000;
  const trackR = (car.track_rear_mm ?? trackF * 1000) / 1000;
  const brakeTotal = vs.mass * vs.brakeForce * radius * 0.62;
  const frontShare = Math.min(0.75, vs.frontBias + 0.1);
  const diesel = fuelOf(car) === 'diesel';
  const est = !!car.redline_estimated;

  return {
    id: slug,
    source: est
      ? `catalog ${slug} (redline estimated; peaks/gearing sourced)`
      : `catalog ${slug} (sourced checked data)`,
    drive,
    chassis: {
      mass: vs.mass,
      wheelbase: vs.wheelbase,
      frontWeight: vs.frontBias,
      cgHeight: vs.cgHeight,
      trackFront: trackF,
      trackRear: trackR,
      yawInertia: (vs.mass * (vs.length * vs.length + vs.width * vs.width)) / 12 * 0.9,
      cdA,
      rollStiffnessFront: drive === 'fwd' ? 0.7 : 0.62,
      rollGradient: 0.065,
      pitchGradient: 0.035,
      bodyFreqHz: 1.4,
      bodyDamping: 0.45,
    },
    tire: {
      radius,
      widthM: tyreWidthM(car.tyre_sizes),
      mu: vs.gripMu * 0.87,
      C: 1.55,
      peakSlip: 0.11,
      peakAngle: 0.135,
      loadSensitivity: 0.08,
      rollingRes: crr,
      relaxLength: 0.35,
      inertia: 1.15,
    },
    engine: {
      fuel: diesel ? 'diesel' : 'petrol',
      torqueCurve: curve,
      idleRpm,
      redlineRpm,
      limiterRpm: Math.round(redlineRpm * (diesel ? 1.06 : 1.03)),
      inertia: 0.22,
      frictionNm: diesel ? 18 : 12,
      frictionPerKrpm: diesel ? 6 : 4,
      turbo: turboish(car)
        ? {
            maxBoostBar: 0.9,
            spoolStartRpm: Math.max(1200, Math.round(car.peak_torque_rpm * 0.35)),
            fullBoostRpm: Math.round(car.peak_torque_rpm * 0.85),
            lagS: 0.45,
            boostShare: 0.45,
          }
        : undefined,
    },
    gearbox: {
      ratios,
      reverse: Math.max(ratios[0] * 0.95, 3.2),
      finalDrive,
      efficiency: 0.91,
      shiftTimeS: 0.28,
      upshiftRpm: Math.round(redlineRpm * 0.93),
      downshiftRpm: Math.round(Math.max(idleRpm * 1.6, redlineRpm * 0.32)),
    },
    clutch: { maxTorqueNm: peakTorque * 1.7 },
    diff: { type: drive === 'awd' ? 'lsd' : 'open', preloadNm: drive === 'awd' ? 40 : 0, lockCoef: drive === 'awd' ? 0.3 : 0 },
    brakes: {
      frontNm: (brakeTotal * frontShare) / 2,
      rearNm: (brakeTotal * (1 - frontShare)) / 2,
      handbrakeNm: 900,
    },
    steering: { maxAngle: vs.steerLock * 0.85, halfLockSpeed: 28 },
    assists: { abs: true, tcs: true, stability: true },
  };
}
