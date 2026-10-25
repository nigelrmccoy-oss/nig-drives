/**
 * v1.4.0 driver aids, working on the real tyre state like the production systems:
 *  - ABS: per-wheel brake pressure release when a wheel's slip ratio passes the tyre peak
 *  - TCS: throttle cut when a driven wheel spins past the peak
 *  - Stability: yaw-rate error against a steady-state bicycle-model reference; brakes one wheel
 *    and cuts throttle, but only once the car is really sliding (v1.4.1)
 */
import type { AssistDefaults, PhysicsSpec } from './PhysicsSpec';
import { shapeB } from './Tire';
import type { VehicleSim } from './VehicleSim';

export interface AssistResult {
  throttle: number;
  abs: boolean;
  tcs: boolean;
  esc: boolean;
}

const MIN_SPEED = 2; // m/s; below this the aids stand down (launches, parking)
const G = 9.81;

/**
 * v1.4.1: linear understeer gradient K (rad of steer per m/s² of lateral acceleration) from the
 * tyre and chassis spec, using the same cornering stiffness the tyre model produces at small slip:
 * per unit axle load an axle gives μ·C·B / (tan(peakAngle)·√(load ratio)) per radian.
 * K = 1/(g·kFront) − 1/(g·kRear). Floored at 0: the reference never asks for oversteer.
 */
export function understeerGradient(s: PhysicsSpec): number {
  const t = s.tire;
  const B = shapeB(t.C);
  const axle = (share: number, tyresPerHub = 1): number => {
    const ratio = Math.min(2, Math.max(0.3, (share * 2) / tyresPerHub)); // tyre load / nominal (fzNominal = m·g/4)
    const mu = t.mu * Math.max(0.6, 1 - t.loadSensitivity * (ratio - 1));
    return (mu * t.C * B) / (Math.tan(t.peakAngle) * Math.sqrt(ratio));
  };
  const fw = s.chassis.frontWeight;
  return Math.max(0, (1 / axle(fw) - 1 / axle(1 - fw, s.chassis.rearDualTyres ? 2 : 1)) / G);
}

export class Assists {
  readonly enabled: AssistDefaults;
  private readonly absMul = [1, 1, 1, 1];
  private tcsMul = 1;
  private escCut = 1;
  private readonly result: AssistResult = { throttle: 0, abs: false, tcs: false, esc: false };

  private readonly spec: PhysicsSpec;
  /** Understeer gradient for the steady-state yaw reference (rad per m/s²). */
  private readonly kUs: number;
  /** Last yaw-rate reference (rad/s), for telemetry / benches. */
  yawRef = 0;

  constructor(spec: PhysicsSpec) {
    this.spec = spec;
    this.enabled = { ...spec.assists };
    this.kUs = understeerGradient(spec);
  }

  reset(): void {
    this.absMul.fill(1);
    this.tcsMul = 1;
    this.escCut = 1;
  }

  /**
   * Adjusts brakeTorque in place (ABS release, stability braking) and returns the throttle
   * the engine should see.
   */
  update(
    dt: number,
    sim: VehicleSim,
    steerAngle: number,
    throttle: number,
    brakeTorque: number[],
    drivenIdx: readonly number[],
    surfaceMu = 1,
  ): AssistResult {
    const s = this.spec;
    const peak = s.tire.peakSlip;
    const res = this.result;
    res.abs = false;
    res.tcs = false;
    res.esc = false;

    // --- stability control (v1.4.1) ---
    // Reference: the steady-state yaw rate of a linear bicycle model, r = u·δ / (L + K·u²), with the
    // car's own understeer gradient K, capped at what the grip allows (μ·g/u). A car cornering
    // normally yaws a little *less* than this (the tyres get progressively softer near the limit),
    // so a normal corner never reads as oversteer. Interventions also need evidence of a slide:
    // the rear tyres past their peak or real body sideslip, not just a yaw error.
    const u = sim.u;
    let escThrottle = 1;
    this.yawRef = 0;
    if (this.enabled.stability && u > 5) {
      const L = s.chassis.wheelbase;
      const muG = s.tire.mu * Math.max(0.3, surfaceMu) * G;
      const rMax = muG / u;
      const rLin = (u * steerAngle) / (L + this.kUs * u * u);
      const rRef = Math.max(-rMax, Math.min(rMax, rLin));
      this.yawRef = rRef;
      const r = sim.r;
      const beta = Math.atan2(sim.v, u);
      const w = sim.wheels;
      const rearSlip = Math.max(w[2].slip, w[3].slip);
      const frontSlip = Math.max(w[0].slip, w[1].slip);
      // rear stepping out: body slip points against the yaw (tail swinging wide)
      const tailOut = beta * r < 0 ? Math.abs(beta) : 0;
      const sliding = rearSlip > 0.95 || tailOut > 0.06;
      const sameSide = r * rRef >= 0;
      // deadband grows with the reference so a noisy steering hand doesn't trip it
      const deadband = 0.03 + 0.08 * Math.abs(rRef);
      // oversteer: yawing more than the reference (or against the steering) while sliding
      const yawErr = sameSide ? Math.abs(r) - Math.abs(rRef) - deadband : Math.abs(r) - 0.05 - deadband;
      // without slip evidence it takes a clearly bigger yaw error (a flick that overshoots)
      const overErr = sliding ? yawErr : yawErr - 0.1;
      // pure sideslip: well past anything a car on the skidpad limit carries (~5°)
      const slideErr = (Math.max(tailOut, Math.abs(beta) * 0.5) - 0.13) * 2;
      const err = Math.max(overErr, slideErr);
      if (err > 0 && Math.abs(r) > 0.05) {
        const outer = r > 0 ? 1 : 0; // yawing left -> right front is the outer wheel
        brakeTorque[outer] += Math.min(1, err * 3) * s.brakes.frontNm * 0.7;
        escThrottle = Math.max(0.2, 1 - err * 4);
        res.esc = true;
      } else if (sameSide && frontSlip > 1.1 && u > 8) {
        // understeer: only when the front tyres are past their peak and the car turns far less
        // than it could; nudge the inner rear and ease the power a little
        const e = Math.abs(rRef) - Math.abs(r) - (0.1 + 0.25 * Math.abs(rRef));
        if (e > 0) {
          const inner = rRef > 0 ? 2 : 3;
          brakeTorque[inner] += Math.min(1, e * 3) * s.brakes.rearNm * 0.5;
          escThrottle = Math.max(0.6, 1 - e * 2);
          res.esc = true;
        }
      }
    }
    this.escCut += ((res.esc ? escThrottle : 1) - this.escCut) * Math.min(1, dt * (res.esc ? 20 : 4));

    // --- ABS: release a wheel's pressure past the peak, rebuild once it recovers ---
    for (let i = 0; i < 4; i++) {
      const w = sim.wheels[i];
      if (!this.enabled.abs || brakeTorque[i] <= 0 || Math.abs(w.vLong) < MIN_SPEED) {
        this.absMul[i] = 1;
        continue;
      }
      const k = w.kappa * Math.sign(w.vLong);
      if (k < -peak * 1.15) this.absMul[i] = Math.max(0.1, this.absMul[i] - dt * 14);
      else if (k > -peak * 0.85) this.absMul[i] = Math.min(1, this.absMul[i] + dt * 5);
      if (this.absMul[i] < 0.97) res.abs = true;
      brakeTorque[i] *= this.absMul[i];
    }

    // --- TCS: driven-wheel spin past the peak ---
    // v1.4.1: like VW's EDL, a single wheel spinning on an axle (the unloaded inner wheel in a tight
    // turn) is braked on its own so the open diff keeps driving the other one; the engine is only
    // cut when the whole axle spins. Throttle-cutting for one light inner wheel used to hold the
    // cars at walking pace at full lock.
    const lim = peak * 1.3;
    const spinOf = (i: number): number => {
      const w = sim.wheels[i];
      return w.kappa * (w.vLong < -0.5 ? -1 : 1);
    };
    let spin = 0;
    for (let a = 0; a < drivenIdx.length; a += 2) {
      const i = drivenIdx[a];
      const j = drivenIdx[a + 1] ?? i;
      const si = spinOf(i);
      const sj = spinOf(j);
      spin = Math.max(spin, Math.min(si, sj));
      if (this.enabled.tcs && throttle > 0.05 && i !== j && Math.abs(sim.u) > MIN_SPEED) {
        const one = si > sj ? i : j;
        const excess = Math.max(si, sj) - peak * 1.8;
        if (excess > 0 && Math.min(si, sj) < lim) {
          brakeTorque[one] += Math.min(1, excess / peak) * (one < 2 ? s.brakes.frontNm : s.brakes.rearNm) * 0.35;
          res.tcs = true;
        }
      }
    }
    if (this.enabled.tcs && throttle > 0.05 && spin > lim) this.tcsMul = Math.max(0.15, this.tcsMul - dt * 6);
    else this.tcsMul = Math.min(1, this.tcsMul + dt * 2.5);
    if (this.tcsMul < 0.97 && throttle > 0.05) res.tcs = true;

    res.throttle = throttle * this.tcsMul * this.escCut;
    return res;
  }
}