import { torqueAt, type EvSpec } from './PhysicsSpec';

/**
 * v1.4.0 M7: battery-electric drivetrain. Each motor gives its table torque up to its own
 * power limit (T = min(T_table, P/ω)), the pair shares one battery power limit, response is
 * near-instant, a software limiter holds the top speed, and lifting off gives one-pedal regen
 * (power-capped, faded out at walking pace) that charges the battery.
 */

export interface EvOutput {
  /** Torque at each axle's wheels in total (Nm, + = forward). */
  front: number;
  rear: number;
  /** Rotor inertia felt at each axle's wheels (kg·m²). */
  inertiaFront: number;
  inertiaRear: number;
}

export interface EvInput {
  throttle: number;
  /** +1 drive, −1 reverse, 0 neutral / park. */
  direction: number;
  /** Mean spin of each axle's wheels (rad/s). */
  frontOmega: number;
  rearOmega: number;
  /** Forward speed of the car (m/s). */
  speed: number;
  mass: number;
  wheelRadius: number;
  /** 0–1: the inverter backs regen off when a tyre is sliding (like the real car). */
  regenScale: number;
}

export class EvDrive {
  private readonly spec: EvSpec;
  private readonly cmd: number[];
  private readonly out: EvOutput = { front: 0, rear: 0, inertiaFront: 0, inertiaRear: 0 };
  /** State of charge 0–1. */
  soc: number;
  /** Battery power (W): + = discharging, − = regen charging. */
  batteryPowerW = 0;
  /** Mechanical regen power right now (W, ≥ 0). */
  regenPowerW = 0;
  /** Fastest motor's speed (rpm). */
  motorRpm = 0;

  constructor(spec: EvSpec) {
    this.spec = spec;
    this.cmd = spec.motors.map(() => 0);
    this.soc = spec.startSoc;
  }

  reset(): void {
    this.cmd.fill(0);
    this.batteryPowerW = 0;
    this.regenPowerW = 0;
    this.motorRpm = 0;
  }

  /** Full-pedal torque a motor can give at this motor speed (rad/s). */
  availableTorque(i: number, motorOmega: number): number {
    const m = this.spec.motors[i];
    const rpm = (Math.abs(motorOmega) * 30) / Math.PI;
    if (rpm >= this.spec.maxMotorRpm) return 0;
    const table = torqueAt(m.torqueCurve, rpm);
    return Math.min(table, m.maxPowerW / Math.max(1, Math.abs(motorOmega)));
  }

  update(dt: number, inp: EvInput): EvOutput {
    const s = this.spec;
    const out = this.out;
    out.front = 0;
    out.rear = 0;
    out.inertiaFront = 0;
    out.inertiaRear = 0;
    const omegas = s.motors.map((m) => (m.axle === 'front' ? inp.frontOmega : inp.rearOmega) * s.reduction);
    this.motorRpm = Math.max(0, ...omegas.map((w) => (Math.abs(w) * 30) / Math.PI));
    for (const m of s.motors) {
      const iw = m.inertia * s.reduction * s.reduction;
      if (m.axle === 'front') out.inertiaFront += iw;
      else out.inertiaRear += iw;
    }

    // --- drive demand ---
    const targets = s.motors.map(() => 0);
    const speedKmh = inp.speed * 3.6;
    if (inp.direction !== 0 && inp.throttle > 0.01) {
      // software limiter (and a gentle 30 km/h cap in reverse)
      const vmax = inp.direction > 0 ? s.topSpeedKmh : 30;
      const v = inp.direction > 0 ? speedKmh : -speedKmh;
      const limiter = Math.min(1, Math.max(0, (vmax - v) / 3));
      let total = 0;
      for (let i = 0; i < s.motors.length; i++) {
        targets[i] = inp.throttle * limiter * this.availableTorque(i, omegas[i]);
        total += targets[i] * Math.abs(omegas[i]);
      }
      const cap = inp.direction > 0 ? s.systemPowerW : s.systemPowerW * 0.25;
      if (total > cap) for (let i = 0; i < targets.length; i++) targets[i] *= cap / total;
      for (let i = 0; i < targets.length; i++) targets[i] *= inp.direction;
    }

    // --- one-pedal regen off-throttle (forward only), faded out below ~8 km/h ---
    this.regenPowerW = 0;
    if (inp.direction > 0 && inp.throttle <= 0.01 && inp.speed > 1) {
      const fade = Math.min(1, Math.max(0, (inp.speed - 1) / 1.5));
      let force = inp.mass * s.regenDecel * fade * inp.regenScale;
      force = Math.min(force, s.regenMaxPowerW / Math.max(1, inp.speed));
      const wheelT = force * inp.wheelRadius;
      const hasFront = s.motors.some((m) => m.axle === 'front');
      const hasRear = s.motors.some((m) => m.axle === 'rear');
      const fShare = hasFront && hasRear ? s.regenFrontShare : hasFront ? 1 : 0;
      for (let i = 0; i < s.motors.length; i++) {
        const m = s.motors[i];
        const share = m.axle === 'front' ? fShare : 1 - fShare;
        const nSame = s.motors.filter((x) => x.axle === m.axle).length;
        targets[i] = (-(wheelT * share) / nSame) * (s.efficiency / s.reduction);
      }
      this.regenPowerW = force * inp.speed;
    }

    // --- near-instant torque response ---
    const k = Math.min(1, dt / Math.max(1e-3, s.responseS));
    let mech = 0;
    for (let i = 0; i < s.motors.length; i++) {
      this.cmd[i] += (targets[i] - this.cmd[i]) * k;
      const wheelT = this.cmd[i] * s.reduction * (this.cmd[i] * inp.direction >= 0 ? s.efficiency : 1 / s.efficiency);
      if (s.motors[i].axle === 'front') out.front += wheelT;
      else out.rear += wheelT;
      mech += this.cmd[i] * omegas[i];
    }

    // --- battery ---
    this.batteryPowerW = mech >= 0 ? mech / s.efficiency : mech * s.efficiency;
    this.soc = Math.min(1, Math.max(0, this.soc - (this.batteryPowerW * dt) / (s.batteryKWh * 3.6e6)));
    return out;
  }
}