/**
 * Pure build compiler: base PhysicsSpec + CarBuild → effective PhysicsSpec.
 * Never mutates base. Called on garage/tune changes, not per frame.
 */
import type { PhysicsSpec } from '../physics/PhysicsSpec';
import type { CarBuild } from './CarBuild';
import { COMPOUNDS } from './compounds';
import { stageOf } from './parts';
import type { PartSlot } from '../save/types';

function cloneSpec(base: PhysicsSpec): PhysicsSpec {
  return structuredClone(base);
}

function applyCompound(spec: PhysicsSpec, compoundId: CarBuild['tyres']['front']): void {
  const c = COMPOUNDS[compoundId] ?? COMPOUNDS.all_season;
  const t = spec.tire;
  t.mu = Math.min(1.6, t.mu * c.mu);
  t.peakSlip *= c.peakSlip;
  t.peakAngle *= c.peakAngle;
  if (t.peakAngleRear != null) t.peakAngleRear *= c.peakAngle;
  t.C = Math.max(0.8, t.C + c.C);
  t.slideFloor = c.slideFloor;
  t.loadSensitivity = (t.loadSensitivity ?? 0) + c.loadSens;
  t.rollingRes *= c.rollRes;
  t.relaxLength *= c.relax;
  t.widthM *= c.widthM;
  t.inertia *= c.inertia;
  // Heat window follows compound family
  if (c.family === 'race') {
    t.optTempC = 95;
    t.tempWindowC = 18;
  } else if (c.family === 'sport') {
    t.optTempC = 88;
    t.tempWindowC = 22;
  } else if (c.family === 'winter') {
    t.optTempC = 45;
    t.tempWindowC = 25;
  } else if (c.family === 'rally') {
    t.optTempC = 70;
    t.tempWindowC = 28;
  } else {
    t.optTempC = 75;
    t.tempWindowC = 28;
  }
}

const PART_ORDER: PartSlot[] = [
  'ecu', 'intake', 'exhaust', 'na_tune', 'turbo', 'intercooler',
  'flywheel', 'clutch', 'transmission', 'diff', 'driveshaft',
  'brakes', 'suspension', 'weight', 'body_rigidity', 'aero',
];

export function compileBuild(base: PhysicsSpec, build: CarBuild): PhysicsSpec {
  const out = cloneSpec(base);
  out.source = `${base.source} + build`;

  // --- tyres ---
  if (build.tyres.front === build.tyres.rear) {
    applyCompound(out, build.tyres.front);
  } else {
    const a = COMPOUNDS[build.tyres.front];
    const b = COMPOUNDS[build.tyres.rear];
    const avg = (x: number, y: number) => (x + y) / 2;
    const t = out.tire;
    t.mu = Math.min(1.6, t.mu * avg(a.mu, b.mu));
    t.peakSlip *= avg(a.peakSlip, b.peakSlip);
    t.peakAngle *= avg(a.peakAngle, b.peakAngle);
    if (t.peakAngleRear != null) t.peakAngleRear *= avg(a.peakAngle, b.peakAngle);
    t.C = Math.max(0.8, t.C + avg(a.C, b.C));
    t.slideFloor = avg(a.slideFloor, b.slideFloor);
    t.rollingRes *= avg(a.rollRes, b.rollRes);
    t.relaxLength *= avg(a.relax, b.relax);
    t.widthM *= avg(a.widthM, b.widthM);
    t.inertia *= avg(a.inertia, b.inertia);
    t.optTempC = avg(a.family === 'race' ? 95 : 75, b.family === 'race' ? 95 : 75);
    t.tempWindowC = 24;
  }

  // --- parts (GT stages) ---
  for (const slot of PART_ORDER) {
    const installed = build.parts[slot];
    if (!installed) continue;
    const st = stageOf(slot, installed.stage);
    if (!st) continue;
    const e = st.effects;
    if (e.torqueMul && e.torqueMul !== 1) {
      out.engine.torqueCurve = out.engine.torqueCurve.map((p) => ({ rpm: p.rpm, nm: p.nm * e.torqueMul! }));
    }
    if (e.redlineMul && e.redlineMul !== 1) {
      out.engine.redlineRpm = Math.round(out.engine.redlineRpm * e.redlineMul);
      out.engine.limiterRpm = Math.round(out.engine.limiterRpm * e.redlineMul);
    }
    if (e.inertiaMul) out.engine.inertia *= e.inertiaMul;
    if (e.clutchMul) out.clutch.maxTorqueNm *= e.clutchMul;
    if (e.massMul) out.chassis.mass = Math.max(500, out.chassis.mass * e.massMul);
    if (e.cdAMul) out.chassis.cdA *= e.cdAMul;
    if (e.brakeMul) {
      out.brakes.frontNm *= e.brakeMul;
      out.brakes.rearNm *= e.brakeMul;
    }
    if (e.rollStiffFrontAdd) {
      out.chassis.rollStiffnessFront = Math.min(0.85, out.chassis.rollStiffnessFront + e.rollStiffFrontAdd);
    }
    if (e.bodyFreqMul) out.chassis.bodyFreqHz *= e.bodyFreqMul;
    if (e.efficiencyAdd) out.gearbox.efficiency = Math.min(0.98, out.gearbox.efficiency + e.efficiencyAdd);
    if (slot === 'diff' && installed.stage >= 1) {
      out.diff.type = 'lsd';
      out.diff.preloadNm = 40 + installed.stage * 20;
      out.diff.lockCoef = 0.2 + installed.stage * 0.1;
    }
    if (slot === 'transmission' && installed.stage >= 1) {
      // Close-ratio: pull ratios toward geometric mean spacing
      const r = out.gearbox.ratios.slice();
      if (r.length >= 3) {
        const first = r[0], last = r[r.length - 1];
        const span = Math.log(first / last);
        for (let i = 0; i < r.length; i++) {
          const t = i / (r.length - 1);
          const geo = first * Math.exp(-span * t);
          r[i] = installed.stage >= 2 ? geo : (r[i] * 0.45 + geo * 0.55);
        }
        out.gearbox.ratios = r;
      }
    }
    if (slot === 'suspension' && installed.stage >= 1) {
      const mul = 1 + installed.stage * 0.12;
      out.suspension.springFront *= mul;
      out.suspension.springRear *= mul;
      out.suspension.damperBumpFront *= mul;
      out.suspension.damperBumpRear *= mul;
      out.suspension.damperReboundFront *= mul;
      out.suspension.damperReboundRear *= mul;
      out.suspension.arbFront *= mul;
      out.suspension.arbRear *= mul;
    }
  }

  // --- conversions (only when donor modelId provided and resolved upstream) ---
  if (build.conversions?.engine && build.donorEngine) {
    out.engine = structuredClone(build.donorEngine);
    out.source += ` + engine swap ${build.conversions.engine}`;
  }
  if (build.conversions?.drivetrain === 'awd' || build.conversions?.drivetrain === 'rwd' || build.conversions?.drivetrain === 'fwd') {
    out.drive = build.conversions.drivetrain;
  }

  // --- setup sheet ---
  const s = build.setup;
  if (s.finalDrive != null && s.finalDrive > 0) out.gearbox.finalDrive = s.finalDrive;
  if (s.gearRatios && s.gearRatios.length >= 2) out.gearbox.ratios = s.gearRatios.slice();
  if (s.brakeBiasFrontPct != null) {
    const total = out.brakes.frontNm * 2 + out.brakes.rearNm * 2;
    const frontShare = Math.max(0.3, Math.min(0.8, s.brakeBiasFrontPct / 100));
    out.brakes.frontNm = (total * frontShare) / 2;
    out.brakes.rearNm = (total * (1 - frontShare)) / 2;
  }
  if (s.rideHeightMm != null) {
    const dh = (s.rideHeightMm - out.suspension.rideHeightMm) / 1000;
    out.suspension.rideHeightMm = s.rideHeightMm;
    out.chassis.cgHeight = Math.max(0.25, out.chassis.cgHeight + dh * 0.35);
  }
  if (s.springRateFront != null) out.suspension.springFront = s.springRateFront;
  if (s.springRateRear != null) out.suspension.springRear = s.springRateRear;
  if (s.damperBumpFront != null) out.suspension.damperBumpFront = s.damperBumpFront;
  if (s.damperBumpRear != null) out.suspension.damperBumpRear = s.damperBumpRear;
  if (s.damperReboundFront != null) out.suspension.damperReboundFront = s.damperReboundFront;
  if (s.damperReboundRear != null) out.suspension.damperReboundRear = s.damperReboundRear;
  if (s.antiRollFront != null) out.suspension.arbFront = s.antiRollFront;
  if (s.antiRollRear != null) out.suspension.arbRear = s.antiRollRear;
  // ARB → roll stiffness split
  const arbT = out.suspension.arbFront + out.suspension.arbRear;
  if (arbT > 0) {
    out.chassis.rollStiffnessFront = Math.min(0.85, Math.max(0.4, out.suspension.arbFront / arbT));
  }
  if (build.ballastKg != null && build.ballastKg !== 0) {
    out.chassis.mass = Math.max(600, out.chassis.mass + build.ballastKg);
  }

  return out;
}
