import * as THREE from 'three';
import type { Input } from '../input/Input';
import type { WeatherPreset } from '../weather/Environment';

export type VehicleId = 'golf' | 'bus';

export interface VehicleSpec {
  id: VehicleId;
  name: string;
  mass: number;
  /** Peak engine accel force / mass (m/s²) at full throttle on dry. */
  accel: number;
  maxSpeed: number;
  brakeForce: number;
  /** Wheelbase meters — longer = slower yaw response. */
  wheelbase: number;
  /** Track width meters. */
  track: number;
  /** Base tire peak mu on dry asphalt. */
  gripMu: number;
  /** Steering lock (radians). */
  steerLock: number;
  /** How quickly steer angle approaches input. */
  steerSpeed: number;
  /** CG height for weight transfer (m). */
  cgHeight: number;
  /** Front weight bias 0–1. */
  frontBias: number;
  cameraHeight: number;
  cameraDistance: number;
  length: number;
  width: number;
  height: number;
}

export const VEHICLE_SPECS: Record<VehicleId, VehicleSpec> = {
  golf: {
    id: 'golf',
    name: 'VW Golf',
    mass: 1320,
    accel: 9.5,
    maxSpeed: 48,
    brakeForce: 18,
    wheelbase: 2.62,
    track: 1.54,
    gripMu: 1.15,
    steerLock: 0.55,
    steerSpeed: 3.2,
    cgHeight: 0.52,
    frontBias: 0.58,
    cameraHeight: 3.2,
    cameraDistance: 8.5,
    length: 4.3,
    width: 1.8,
    height: 1.45,
  },
  bus: {
    id: 'bus',
    name: 'City Bus',
    mass: 12500,
    accel: 2.8,
    maxSpeed: 24,
    brakeForce: 9.5,
    wheelbase: 6.1,
    track: 2.1,
    gripMu: 0.85,
    steerLock: 0.42,
    steerSpeed: 1.6,
    cgHeight: 1.15,
    frontBias: 0.48,
    cameraHeight: 6.5,
    cameraDistance: 16,
    length: 12,
    width: 2.55,
    height: 3.2,
  },
};

export interface SurfaceInfo {
  /** 1 = on asphalt road, <1 off-road / grass. */
  roadFactor: number;
}

export interface WeatherDriveInfo {
  weather: WeatherPreset;
  gripMul: number;
  accelBrakeMul: number;
}

/**
 * Sim-cade tire model (FM4 / GT5 inspired, not a full sim):
 * - Longitudinal accel/brake with weight transfer
 * - Lateral grip from slip angle; combined grip circle tradeoff
 * - Progressive under/oversteer; subtle ABS/TCS
 * - Weather & surface multipliers
 */
export class Vehicle {
  readonly spec: VehicleSpec;
  readonly mesh: THREE.Group;
  position = new THREE.Vector3();
  /** Radians, 0 = +Z (north). */
  heading = 0;
  /** Body-frame velocity: x = lateral (right+), z = longitudinal (forward+). */
  private vx = 0;
  private vz = 0;
  private yawRate = 0;
  private steerAngle = 0;
  /** World speed magnitude for HUD. */
  speed = 0;
  sliding = false;
  private absActive = false;
  private tcsActive = false;

  constructor(spec: VehicleSpec, mesh: THREE.Group) {
    this.spec = spec;
    this.mesh = mesh;
  }

  setPose(x: number, z: number, headingRad: number): void {
    this.position.set(x, 0, z);
    this.heading = headingRad;
    this.vx = 0;
    this.vz = 0;
    this.yawRate = 0;
    this.steerAngle = 0;
    this.speed = 0;
    this.syncMesh();
  }

  update(dt: number, input: Input, weather: WeatherDriveInfo, surface: SurfaceInfo): void {
    const s = this.spec;
    const g = 9.81;
    const mu =
      s.gripMu * weather.gripMul * THREE.MathUtils.clamp(surface.roadFactor, 0.25, 1.0);

    // --- Steering ---
    const steerTarget =
      ((input.left ? 1 : 0) + (input.right ? -1 : 0)) * s.steerLock;
    const steerRate = s.steerSpeed * (0.55 + 0.45 * (1 - THREE.MathUtils.clamp(Math.abs(this.vz) / s.maxSpeed, 0, 1)));
    this.steerAngle = approach(this.steerAngle, steerTarget, steerRate * s.steerLock * dt);

    // --- Weight transfer (longitudinal) ---
    const axApprox = (this.vz - (this._prevVz ?? this.vz)) / Math.max(dt, 1e-4);
    this._prevVz = this.vz;
    const transfer = THREE.MathUtils.clamp(
      (s.mass * axApprox * s.cgHeight) / (s.wheelbase * s.mass * g),
      -0.28,
      0.28,
    );
    let wFront = THREE.MathUtils.clamp(s.frontBias - transfer, 0.28, 0.78);
    let wRear = 1 - wFront;
    // Speed-based aero-ish slight rear stability for bus
    if (s.id === 'bus') {
      wRear = Math.min(0.62, wRear + 0.02);
      wFront = 1 - wRear;
    }

    const FzFront = s.mass * g * wFront;
    const FzRear = s.mass * g * wRear;
    const maxFxFront = mu * FzFront;
    const maxFxRear = mu * FzRear;
    const maxFyFront = mu * FzFront * 1.05;
    const maxFyRear = mu * FzRear * 1.05;

    // --- Longitudinal demand ---
    let throttle = input.forward ? 1 : 0;
    let brake = input.back || input.brake ? (input.brake ? 1 : 0.55) : 0;
    if (input.back && this.vz < 0.8) {
      // reverse when nearly stopped
      throttle = 0;
    }

    let engAx = throttle * s.accel * weather.accelBrakeMul;
    // Engine force fades near top speed
    engAx *= 1 - THREE.MathUtils.clamp(Math.abs(this.vz) / s.maxSpeed, 0, 1) ** 1.4;

    let brakeAx = 0;
    if (brake > 0 && this.vz > 0.15) {
      brakeAx = -brake * s.brakeForce * weather.accelBrakeMul;
    } else if (input.back && this.vz <= 0.15) {
      engAx = -s.accel * 0.35 * weather.accelBrakeMul;
    }

    // Rolling resistance + drag
    const drag = 0.012 * g * Math.sign(this.vz) + 0.00045 * this.vz * Math.abs(this.vz);
    let longDemand = engAx - drag + brakeAx;

    // TCS: limit drive force if rear would exceed grip
    this.tcsActive = false;
    if (longDemand > 0) {
      const driveCap = (maxFxRear * 0.92) / s.mass;
      if (longDemand > driveCap) {
        longDemand = driveCap;
        this.tcsActive = throttle > 0.2;
      }
    }

    // ABS: limit brake so fronts don't lock entirely
    this.absActive = false;
    if (longDemand < 0) {
      const brakeCap = -((maxFxFront + maxFxRear) * 0.9) / s.mass;
      if (longDemand < brakeCap) {
        longDemand = brakeCap;
        this.absActive = brake > 0.3;
      }
    }

    // --- Slip angles (bicycle model) ---
    const vSafe = Math.max(Math.abs(this.vz), 1.2);
    const yaw = this.yawRate;
    const aFront = Math.atan2(this.vx + yaw * (s.wheelbase * wRear), vSafe) - this.steerAngle;
    const aRear = Math.atan2(this.vx - yaw * (s.wheelbase * wFront), vSafe);

    // Pacejka-ish cornering stiffness scaled by load & mu
    const Cf = (FzFront / (s.mass * g)) * 9.5 * mu * s.mass * g;
    const Cr = (FzRear / (s.mass * g)) * 10.5 * mu * s.mass * g;

    let FyFront = -Cf * Math.tan(THREE.MathUtils.clamp(aFront, -0.6, 0.6));
    let FyRear = -Cr * Math.tan(THREE.MathUtils.clamp(aRear, -0.6, 0.6));

    // --- Combined grip circle (front / rear) ---
    // Allocate longitudinal: drive on rear, brake split by bias
    let FxFront = 0;
    let FxRear = 0;
    const Flong = longDemand * s.mass;
    if (Flong >= 0) {
      FxRear = Flong;
    } else {
      FxFront = Flong * wFront;
      FxRear = Flong * wRear;
    }

    const frontCombo = combineGrip(FxFront, FyFront, maxFxFront, maxFyFront);
    FxFront = frontCombo.fx;
    FyFront = frontCombo.fy;
    const rearCombo = combineGrip(FxRear, FyRear, maxFxRear, maxFyRear);
    FxRear = rearCombo.fx;
    FyRear = rearCombo.fy;

    this.sliding = frontCombo.sliding || rearCombo.sliding;

    // Resolve body accel from tire forces (steer rotates front force into body frame)
    const cos = Math.cos(this.steerAngle);
    const sin = Math.sin(this.steerAngle);
    const Fx =
      FxRear + FxFront * cos - FyFront * sin;
    const Fy =
      FyRear + FyFront * cos + FxFront * sin;

    const ax = Fy / s.mass + this.vz * yaw; // coriolis in body frame
    const az = Fx / s.mass - this.vx * yaw;

    this.vx += ax * dt;
    this.vz += az * dt;

    // Yaw moment from tire lateral (+ front longitudinal with lever if steered — simplified)
    const yawMoment =
      FyFront * cos * (s.wheelbase * wRear) -
      FyRear * (s.wheelbase * wFront) +
      FxFront * sin * (s.wheelbase * wRear) * 0.35;
    // Inertia scales with mass * wheelbase²
    const Iz = s.mass * (s.wheelbase * 0.5) ** 2 * (s.id === 'bus' ? 1.35 : 0.95);
    this.yawRate += (yawMoment / Iz) * dt;

    // Damper yaw when grip is high / low speed for stability
    const yawDamp = 1.8 + mu * 1.2;
    this.yawRate *= Math.exp(-yawDamp * dt * (0.4 + 0.6 * Math.min(1, vSafe / 12)));

    // Integrate pose
    const worldYaw = this.heading;
    const c = Math.cos(worldYaw);
    const sn = Math.sin(worldYaw);
    // body z forward, x right → world
    const wx = sn * this.vz + c * this.vx;
    const wz = c * this.vz - sn * this.vx;
    this.position.x += wx * dt;
    this.position.z += wz * dt;
    this.heading += this.yawRate * dt;

    this.speed = Math.hypot(this.vx, this.vz);

    // Soft clamp reverse speed
    if (this.vz < -s.maxSpeed * 0.28) this.vz = -s.maxSpeed * 0.28;
    if (this.vz > s.maxSpeed * 1.05) this.vz = s.maxSpeed * 1.05;

    this.syncMesh();
  }

  private _prevVz = 0;

  getSpeedKmh(): number {
    return this.speed * 3.6;
  }

  getForward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  getAssistFlags(): { abs: boolean; tcs: boolean; slide: boolean } {
    return { abs: this.absActive, tcs: this.tcsActive, slide: this.sliding };
  }

  private syncMesh(): void {
    this.mesh.position.copy(this.position);
    this.mesh.rotation.order = 'YXZ';
    this.mesh.rotation.y = this.heading;
    // Subtle body roll / pitch for weight transfer feel
    const roll = THREE.MathUtils.clamp(-this.vx * 0.015, -0.08, 0.08);
    const pitch = THREE.MathUtils.clamp(-this.vz * 0.002 + (this._prevVz - this.vz) * 0.01, -0.06, 0.06);
    this.mesh.rotation.z = roll;
    this.mesh.rotation.x = pitch;
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

/** Elliptical grip circle: scale Fx/Fy if outside friction ellipse. */
function combineGrip(
  fx: number,
  fy: number,
  maxFx: number,
  maxFy: number,
): { fx: number; fy: number; sliding: boolean } {
  const nx = maxFx > 1e-3 ? fx / maxFx : 0;
  const ny = maxFy > 1e-3 ? fy / maxFy : 0;
  const mag = Math.hypot(nx, ny);
  if (mag <= 1) return { fx, fy, sliding: mag > 0.92 };
  // Progressive slide: soften beyond limit instead of hard clamp only
  const scale = (1 / mag) * (0.92 + 0.08 / mag);
  return { fx: fx * scale, fy: fy * scale, sliding: true };
}
