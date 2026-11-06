/**
 * Pure build compiler: base PhysicsSpec + CarBuild → effective PhysicsSpec.
 * Never mutates base. Called on garage/tune changes, not per frame.
 */
import type { PhysicsSpec } from '../physics/PhysicsSpec';
import type { CarBuild } from './CarBuild';
import { COMPOUNDS } from './compounds';

function cloneSpec(base: PhysicsSpec): PhysicsSpec {
  return structuredClone(base);
}

function applyCompound(spec: PhysicsSpec, axle: 'front' | 'rear', compoundId: CarBuild['tyres']['front']): void {
  const c = COMPOUNDS[compoundId] ?? COMPOUNDS.all_season;
  // Shared tire block today — apply front compound as the effective set when F=R;
  // when mixed, average mu/peaks (full per-axle tire specs come with suspension work).
  void axle;
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
}

export function compileBuild(base: PhysicsSpec, build: CarBuild): PhysicsSpec {
  const out = cloneSpec(base);
  out.source = `${base.source} + build`;

  // Tyres: if F==R apply once; if mixed, average the two compound multipliers.
  if (build.tyres.front === build.tyres.rear) {
    applyCompound(out, 'front', build.tyres.front);
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
  }

  // Setup sheet (only fields present)
  const s = build.setup;
  if (s.finalDrive != null && s.finalDrive > 0) out.gearbox.finalDrive = s.finalDrive;
  if (s.gearRatios && s.gearRatios.length >= 2) out.gearbox.ratios = s.gearRatios.slice();
  if (s.brakeBiasFrontPct != null) {
    const total = out.brakes.frontNm * 2 + out.brakes.rearNm * 2;
    const frontShare = Math.max(0.3, Math.min(0.8, s.brakeBiasFrontPct / 100));
    out.brakes.frontNm = (total * frontShare) / 2;
    out.brakes.rearNm = (total * (1 - frontShare)) / 2;
  }
  if (build.ballastKg != null && build.ballastKg !== 0) {
    out.chassis.mass = Math.max(600, out.chassis.mass + build.ballastKg);
  }

  // Parts / conversions: applied in later 1.5.0d pass (data-driven stages).
  return out;
}
