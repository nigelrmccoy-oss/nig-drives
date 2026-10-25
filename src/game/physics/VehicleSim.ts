import type { PhysicsSpec } from './PhysicsSpec';
import { tireForces, type TireOut } from './Tire';

/**
 * v1.4.0 chassis model: a rigid body in the ground plane on four tyres.
 * - each wheel has its own spin (ω) and its own load,
 * - load moves front/rear under braking and acceleration and side to side in corners
 *   (split by front/rear roll stiffness), through a sprung-mass response so the body
 *   takes a moment to settle (that lag is what makes weight transfer feel physical),
 * - tyre forces come from Tire.ts (combined slip, load sensitivity, relaxation length),
 * - no yaw clamps or artificial damping: rotation is whatever the tyres produce.
 *
 * Body frame: u = forward speed, v = lateral speed (+ = left), r = yaw rate (+ = left).
 * Wheel order: 0 FL, 1 FR, 2 RL, 3 RR.
 */

const G = 9.81;
const RHO = 1.225;
/** Below this speed slip is measured against a floor speed so it stays finite. */
const V_FLOOR = 3;

export interface WheelState {
  omega: number;
  /** Relaxed tan(slip angle). */
  tanAlpha: number;
  kappa: number;
  fz: number;
  fx: number;
  fy: number;
  slip: number;
  /** Speed of the ground under the wheel along its heading (m/s). */
  vLong: number;
}

export interface SimInputs {
  /** Front road-wheel angle (rad, + = left). */
  steer: number;
  /** Per-wheel drive torque (Nm, + = forward). */
  driveTorque: number[];
  /** Per-wheel brake torque magnitude (Nm). */
  brakeTorque: number[];
  /** Per-wheel extra rotating inertia from the driveline (kg·m²). */
  extraInertia: number[];
  /** Surface friction scale (1 = dry asphalt). */
  mu: number;
  /** 0–1 bumpiness. */
  noise: number;
  /** sin(grade) along the car, + = nose up. */
  gradeSin: number;
  /** Brakes / Park holding at a standstill: no creep down the grade. */
  hold: boolean;
}

export class VehicleSim {
  u = 0;
  v = 0;
  r = 0;
  /** Body-filtered accelerations (m/s²) driving load transfer and body roll / pitch. */
  axBody = 0;
  ayBody = 0;
  private axRate = 0;
  private ayRate = 0;
  readonly wheels: WheelState[];
  /** Wheel positions in the body frame: x lateral (+ left), z forward. */
  readonly px: number[];
  readonly pz: number[];
  private readonly spec: PhysicsSpec;
  private readonly fzNominal: number;
  private readonly bump = [0, 0, 0, 0];
  private readonly tmp: TireOut = { fx: 0, fy: 0, slip: 0, kLong: 0, limit: 0 };

  constructor(spec: PhysicsSpec) {
    this.spec = spec;
    const c = spec.chassis;
    const a = c.wheelbase * (1 - c.frontWeight);
    const b = c.wheelbase * c.frontWeight;
    this.px = [c.trackFront / 2, -c.trackFront / 2, c.trackRear / 2, -c.trackRear / 2];
    this.pz = [a, a, -b, -b];
    this.fzNominal = (c.mass * G) / 4;
    this.wheels = [0, 1, 2, 3].map(() => ({ omega: 0, tanAlpha: 0, kappa: 0, fz: this.fzNominal, fx: 0, fy: 0, slip: 0, vLong: 0 }));
  }

  reset(): void {
    this.u = 0;
    this.v = 0;
    this.r = 0;
    this.axBody = 0;
    this.ayBody = 0;
    this.axRate = 0;
    this.ayRate = 0;
    for (const w of this.wheels) {
      w.omega = 0;
      w.tanAlpha = 0;
      w.kappa = 0;
      w.fx = 0;
      w.fy = 0;
      w.slip = 0;
      w.vLong = 0;
    }
  }

  /** Average ω of the given wheels. */
  meanOmega(idx: readonly number[]): number {
    let s = 0;
    for (const i of idx) s += this.wheels[i].omega;
    return s / Math.max(1, idx.length);
  }

  step(dt: number, inp: SimInputs): void {
    const p = this.spec;
    const c = p.chassis;
    const t = p.tire;
    const m = c.mass;
    const rad = t.radius;

    // --- loads: static + longitudinal + lateral transfer (from the sprung-mass response) ---
    const W = m * G;
    const dLong = (m * this.axBody * c.cgHeight) / c.wheelbase;
    const dLatF = ((m * this.ayBody * c.cgHeight) / c.trackFront) * c.rollStiffnessFront;
    const dLatR = ((m * this.ayBody * c.cgHeight) / c.trackRear) * (1 - c.rollStiffnessFront);
    const fzStatic = [(W * c.frontWeight) / 2, (W * c.frontWeight) / 2, (W * (1 - c.frontWeight)) / 2, (W * (1 - c.frontWeight)) / 2];
    const bumpAmp = Math.min(1, Math.abs(this.u) / 8) * inp.noise * 0.22;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const left = i % 2 === 0;
      let fz = fzStatic[i] + (front ? -dLong / 2 : dLong / 2) + (left ? -1 : 1) * (front ? dLatF : dLatR);
      if (bumpAmp > 0) {
        this.bump[i] += (Math.abs(this.u) * dt * Math.PI * 2) / (1.3 + i * 0.17);
        fz *= 1 + bumpAmp * Math.sin(this.bump[i]);
      }
      this.wheels[i].fz = Math.max(0, fz);
    }

    // --- tyres + wheel spin ---
    let fLat = 0;
    let fFwd = 0;
    let yawMoment = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const d = i < 2 ? inp.steer : 0;
      const cd = Math.cos(d);
      const sd = Math.sin(d);
      const lat = this.v + this.r * this.pz[i];
      const fwd = this.u - this.r * this.px[i];
      const vLong = fwd * cd + lat * sd;
      const vLat = lat * cd - fwd * sd;
      w.vLong = vLong;
      const vDen = Math.max(Math.abs(vLong), V_FLOOR);
      const tanSS = vLat / vDen;
      const relax = Math.min(1, ((Math.abs(vLong) + 1.5) * dt) / t.relaxLength);
      w.tanAlpha += (tanSS - w.tanAlpha) * relax;
      w.kappa = (w.omega * rad - vLong) / vDen;
      const f = tireForces(t, w.fz, this.fzNominal, w.kappa, w.tanAlpha, inp.mu, inp.mu, this.tmp);
      w.fx = f.fx;
      w.fy = f.fy;
      w.slip = f.slip;

      // Implicit wheel-spin update (tyre force linearised in ω) so stiff tyres stay stable at 120 Hz.
      const I = t.inertia + inp.extraInertia[i];
      const kw = (f.kLong * rad * rad) / vDen;
      const denom = 1 + (dt * kw) / I;
      const roll = t.rollingRes * w.fz * rad * Math.tanh(w.omega * 2);
      let om = w.omega + (dt * (inp.driveTorque[i] - f.fx * rad - roll)) / (I * denom);
      const brakeStep = (dt * inp.brakeTorque[i]) / (I * denom);
      if (brakeStep > 0) {
        if (Math.abs(om) <= brakeStep) om = 0;
        else om -= Math.sign(om) * brakeStep;
      }
      w.omega = Number.isFinite(om) ? om : vLong / rad;

      const bx = f.fx * sd + f.fy * cd;
      const bz = f.fx * cd - f.fy * sd;
      fLat += bx;
      fFwd += bz;
      yawMoment += this.pz[i] * bx - this.px[i] * bz;
    }

    // --- body ---
    const drag = -0.5 * RHO * c.cdA * this.u * Math.abs(this.u);
    fFwd += drag;
    const axBody = fFwd / m;
    const ayBody = fLat / m;
    let grade = -G * inp.gradeSin;
    if (inp.hold) grade = 0;
    this.u += (axBody + this.v * this.r + grade) * dt;
    this.v += (ayBody - this.u * this.r) * dt;
    this.r += (yawMoment / c.yawInertia) * dt;
    if (inp.hold) {
      const k = Math.exp(-10 * dt);
      this.u *= k;
      this.v *= k;
      this.r *= k;
    }

    // --- sprung mass: 2nd-order response of the felt accelerations (body pitch / roll) ---
    const w0 = 2 * Math.PI * c.bodyFreqHz;
    const z = c.bodyDamping;
    this.axRate += (w0 * w0 * (axBody - this.axBody) - 2 * z * w0 * this.axRate) * dt;
    this.axBody += this.axRate * dt;
    this.ayRate += (w0 * w0 * (ayBody - this.ayBody) - 2 * z * w0 * this.ayRate) * dt;
    this.ayBody += this.ayRate * dt;
    // keep transfer physical even if something upstream spikes
    const cap = 1.6 * G;
    this.axBody = Math.max(-cap, Math.min(cap, this.axBody));
    this.ayBody = Math.max(-cap, Math.min(cap, this.ayBody));

    if (!Number.isFinite(this.u) || !Number.isFinite(this.v) || !Number.isFinite(this.r)) this.reset();
  }

  /** Body roll (rad, + = right side down, matching Three rotation.z) and pitch (+ = nose down). */
  bodyRoll(): number {
    return (this.ayBody / G) * this.spec.chassis.rollGradient;
  }

  bodyPitch(): number {
    return (-this.axBody / G) * this.spec.chassis.pitchGradient;
  }
}