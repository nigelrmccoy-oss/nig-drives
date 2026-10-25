/**
 * v1.4.0 driver aids, working on the real tyre state like the production systems:
 *  - ABS: per-wheel brake pressure release when a wheel's slip ratio passes the tyre peak
 *  - TCS: throttle cut when a driven wheel spins past the peak
 *  - Stability: yaw-rate error against a bicycle-model reference; brakes one wheel and cuts throttle
 */
import type { AssistDefaults, PhysicsSpec } from './PhysicsSpec';
import type { VehicleSim } from './VehicleSim';

export interface AssistResult {
  throttle: number;
  abs: boolean;
  tcs: boolean;
  esc: boolean;
}

const MIN_SPEED = 2; // m/s; below this the aids stand down (launches, parking)

export class Assists {
  readonly enabled: AssistDefaults;
  private readonly absMul = [1, 1, 1, 1];
  private tcsMul = 1;
  private escCut = 1;
  private readonly result: AssistResult = { throttle: 0, abs: false, tcs: false, esc: false };

  private readonly spec: PhysicsSpec;

  constructor(spec: PhysicsSpec) {
    this.spec = spec;
    this.enabled = { ...spec.assists };
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
  update(dt: number, sim: VehicleSim, steerAngle: number, throttle: number, brakeTorque: number[], drivenIdx: readonly number[]): AssistResult {
    const s = this.spec;
    const peak = s.tire.peakSlip;
    const res = this.result;
    res.abs = false;
    res.tcs = false;
    res.esc = false;

    // --- stability control: yaw-rate reference from a bicycle model ---
    const u = sim.u;
    let escThrottle = 1;
    if (this.enabled.stability && u > 5) {
      const L = s.chassis.wheelbase;
      const vch = 22; // characteristic speed of a mildly understeering hatchback, m/s
      let rRef = (u * steerAngle) / (L * (1 + (u / vch) ** 2));
      const rMax = (0.85 * s.tire.mu * 9.81) / u;
      rRef = Math.max(-rMax, Math.min(rMax, rRef));
      const r = sim.r;
      const beta = Math.atan2(sim.v, u);
      const over = Math.abs(r) - Math.abs(rRef);
      const sameSide = r * rRef >= 0;
      // oversteer: yawing more than asked (or sliding sideways) -> brake the outer front
      const overErr = sameSide ? over - 0.06 : Math.abs(r) - 0.04;
      const slideErr = Math.abs(beta) - 0.12;
      const err = Math.max(overErr, slideErr * 2);
      if (err > 0 && Math.abs(r) > 0.05) {
        const outer = r > 0 ? 1 : 0; // yawing left -> right front is the outer wheel
        brakeTorque[outer] += Math.min(1, err * 3) * s.brakes.frontNm * 0.7;
        escThrottle = Math.max(0.2, 1 - err * 4);
        res.esc = true;
      } else if (sameSide && -over > 0.1 && Math.abs(rRef) > 0.08) {
        // understeer: nudge the inner rear and back off the power
        const inner = rRef > 0 ? 2 : 3;
        const e = -over - 0.1;
        brakeTorque[inner] += Math.min(1, e * 3) * s.brakes.rearNm * 0.5;
        escThrottle = Math.max(0.4, 1 - e * 3);
        res.esc = true;
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

    // --- TCS: driven-wheel spin past the peak cuts the throttle ---
    let spin = 0;
    for (const i of drivenIdx) {
      const w = sim.wheels[i];
      spin = Math.max(spin, w.kappa * (w.vLong < -0.5 ? -1 : 1));
    }
    if (this.enabled.tcs && throttle > 0.05 && spin > peak * 1.3) this.tcsMul = Math.max(0.15, this.tcsMul - dt * 6);
    else this.tcsMul = Math.min(1, this.tcsMul + dt * 2.5);
    if (this.tcsMul < 0.97 && throttle > 0.05) res.tcs = true;

    res.throttle = throttle * this.tcsMul * this.escCut;
    return res;
  }
}