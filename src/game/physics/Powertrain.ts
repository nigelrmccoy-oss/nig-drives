import { torqueAt, type PhysicsSpec } from './PhysicsSpec';

/**
 * v1.4.0 M4 powertrain: engine (torque table, friction, idle governor, limiter),
 * turbo with spool lag, and a clutch that either slips (launches, shifts) or locks
 * the engine to the gearbox (engine braking, reflected inertia). The auto-clutch
 * opens below idle so the car never stalls; the player's clutch key opens it fully.
 */

export interface PowertrainInput {
  throttle: number;
  /** Overall ratio (gear × final drive); 0 = neutral / park. */
  ratio: number;
  /** Gearbox input direction: +1 forward gears, −1 reverse. */
  direction: number;
  /** Mean spin of the driven wheels (rad/s). */
  wheelOmega: number;
  /** Clutch key held (fully open). */
  clutchPedal: boolean;
  /** A gear change is in progress (clutch open, throttle cut). */
  shifting: boolean;
}

export interface PowertrainOutput {
  /** Total torque at the driven wheels (Nm, + = forward). */
  wheelTorque: number;
  /** Driveline inertia felt at the driven wheels in total (kg·m²). */
  wheelInertia: number;
}

export class Powertrain {
  /** Engine speed (rad/s). */
  private omega: number;
  /** Turbo boost as a fraction of full boost (0–1). */
  boost = 0;
  /** Clutch engagement 0–1 and whether it is locked solid. */
  private engage = 1;
  private locked = false;
  private readonly spec: PhysicsSpec;
  private readonly out: PowertrainOutput = { wheelTorque: 0, wheelInertia: 0 };

  constructor(spec: PhysicsSpec) {
    this.spec = spec;
    this.omega = (spec.engine.idleRpm * Math.PI) / 30;
  }

  get rpm(): number {
    return (this.omega * 30) / Math.PI;
  }

  /** Clutch torque that would bring engine and gearbox to the same speed in one step. */
  private syncTorque(dw: number, tEng: number, ratio: number, dt: number): number {
    const s = this.spec;
    const rr = Math.max(0.5, Math.abs(ratio));
    // gearbox-side inertia: driven wheels plus roughly the car's mass through the tyres
    const iShaft = (2 * s.tire.inertia + 0.5 * s.chassis.mass * s.tire.radius * s.tire.radius) / (rr * rr);
    return (dw / dt + tEng / s.engine.inertia) / (1 / s.engine.inertia + 1 / iShaft);
  }

  get clutchLocked(): boolean {
    return this.locked;
  }

  reset(): void {
    this.omega = (this.spec.engine.idleRpm * Math.PI) / 30;
    this.boost = 0;
    this.engage = 1;
    this.locked = false;
  }

  /** Net engine torque at the crank for this throttle and rpm (Nm). */
  engineTorque(throttle: number, rpm: number): number {
    const e = this.spec.engine;
    const friction = e.frictionNm + (e.frictionPerKrpm * rpm) / 1000;
    if (rpm >= e.limiterRpm) return -friction; // fuel cut
    let full = torqueAt(e.torqueCurve, rpm);
    if (e.turbo) full *= 1 - e.turbo.boostShare * (1 - this.boost);
    let t = throttle * full - (1 - throttle) * friction;
    // idle governor: fuel the engine back up to idle
    if (rpm < e.idleRpm) {
      const idleT = Math.min((e.idleRpm - rpm) * 0.25, torqueAt(e.torqueCurve, e.idleRpm) * 0.7);
      t = Math.max(t, idleT);
    }
    return t;
  }

  update(dt: number, inp: PowertrainInput): PowertrainOutput {
    const e = this.spec.engine;
    const eff = this.spec.gearbox.efficiency;
    const throttle = inp.shifting ? Math.min(inp.throttle, 0.1) : inp.throttle;
    const rpm = this.rpm;

    // turbo spool (fast blow-off, slower build)
    if (e.turbo) {
      const tb = e.turbo;
      const x = Math.min(1, Math.max(0, (rpm - tb.spoolStartRpm) / Math.max(1, tb.fullBoostRpm - tb.spoolStartRpm)));
      // v1.4.0 M11: the driver's foot stays down through a quick shift, so the VNT keeps spinning
      const target = inp.throttle * x * x * (3 - 2 * x);
      const lag = target > this.boost ? tb.lagS : tb.lagS * 1.2; // VNT holds most of the boost through a quick shift
      this.boost += (target - this.boost) * Math.min(1, dt / lag);
    }

    const tEng = this.engineTorque(throttle, rpm);
    const out = this.out;
    out.wheelTorque = 0;
    out.wheelInertia = 0;

    const inGear = inp.ratio > 0;
    const shaftOmega = inGear ? inp.wheelOmega * inp.ratio * inp.direction : 0; // clutch output side
    const shaftRpm = (shaftOmega * 30) / Math.PI;

    // auto-clutch: like a driver's left foot. Launches slip the clutch around the launch rpm
    // (≈ 2000 for the TDI) until the gearbox side catches up; then it closes fully.
    const launch = Math.max(e.idleRpm + 700, e.redlineRpm * 0.45);
    const closeRpm = e.idleRpm * 1.05 + Math.min(1, throttle * 1.5) * (launch * 0.8 - e.idleRpm * 1.05);
    let target = 0;
    if (inGear && !inp.clutchPedal && !inp.shifting) {
      if (shaftRpm > closeRpm && Math.abs(rpm - shaftRpm) < 350) target = 1;
      else if (throttle > 0.02) {
        const x = Math.min(1, Math.max(0, (rpm - (launch - 300)) / 600));
        target = Math.min(1, throttle * 1.5) * x * x * (3 - 2 * x);
      }
    }
    // engage smoothly (≈0.15 s), release instantly
    this.engage = target < this.engage ? target : Math.min(target, this.engage + dt / 0.1);
    const cap = this.engage * this.spec.clutch.maxTorqueNm;

    if (this.locked) {
      // unlock when the clutch opens, can't carry the torque, or the engine would stall
      if (!inGear || this.engage < 0.98 || Math.abs(tEng) > cap || shaftRpm < e.idleRpm * 0.9) this.locked = false;
    }

    if (this.locked) {
      this.omega = shaftOmega;
      out.wheelTorque = tEng * inp.ratio * eff * inp.direction;
      out.wheelInertia = e.inertia * inp.ratio * inp.ratio;
    } else {
      let tClutch = 0;
      if (inGear && cap > 0) {
        const dw = this.omega - shaftOmega;
        // friction torque, capped at what would close the slip in this step (implicit: no chatter)
        tClutch = Math.max(-cap, Math.min(cap, this.syncTorque(dw, tEng, inp.ratio, dt)));
      }
      this.omega += (dt * (tEng - tClutch)) / e.inertia;
      if (this.omega < 0) this.omega = 0;
      out.wheelTorque = tClutch * inp.ratio * eff * inp.direction;
      if (inGear && this.engage > 0.98 && Math.abs(this.omega - shaftOmega) < 2.5 && Math.abs(tEng) < cap && shaftRpm >= closeRpm * 0.97) {
        this.locked = true;
        this.omega = shaftOmega;
      }
    }
    if (!Number.isFinite(this.omega)) this.omega = (e.idleRpm * Math.PI) / 30;
    return out;
  }
}