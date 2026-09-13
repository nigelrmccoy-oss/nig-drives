import * as THREE from 'three';
import type { Input } from '../input/Input';
import type { WeatherPreset } from '../weather/Environment';

/** Selectable drivetrains / transit variants (v1.2). */
export type VehicleId =
  | 'golf_18carb'
  | 'golf_20aba'
  | 'golf_19tdi'
  | 'golf_28vr6'
  | 'bus_diesel'
  | 'bus_hybrid';

export type VehicleClass = 'golf' | 'bus';

export function vehicleClassOf(id: VehicleId): VehicleClass {
  return id.startsWith('bus') ? 'bus' : 'golf';
}

export interface VehicleSpec {
  id: VehicleId;
  name: string;
  class: VehicleClass;
  /** Short label for menus (engine / powertrain). */
  variantLabel: string;
  mass: number;
  /** Peak engine accel force / mass (m/s²) at full throttle on dry. */
  accel: number;
  maxSpeed: number;
  brakeForce: number;
  wheelbase: number;
  track: number;
  gripMu: number;
  steerLock: number;
  steerSpeed: number;
  cgHeight: number;
  frontBias: number;
  cameraHeight: number;
  cameraDistance: number;
  length: number;
  width: number;
  height: number;
  /**
   * Speed fraction (0–1 of maxSpeed) where torque peaks.
   * Lower = stronger low-end (TDI); higher = top-end (VR6).
   */
  torquePeak: number;
  /** Extra force multiplier near torque peak / low-end band. */
  lowEndMul: number;
  /** Exponent for power fade toward redline (higher = falls off sooner). */
  powerFadeExp: number;
  /** Engine note base pitch (1 = ABA reference). */
  soundPitch: number;
  /** Hybrid regen: extra brake force multiplier when braking / lifting. */
  regenBrakeMul: number;
  /** Soft regen when coasting off-throttle (hybrid). */
  coastRegen: number;
}

const GOLF_BASE = {
  class: 'golf' as const,
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
  regenBrakeMul: 1,
  coastRegen: 0,
};

const BUS_BASE = {
  class: 'bus' as const,
  wheelbase: 6.1,
  track: 2.1,
  gripMu: 0.85,
  steerLock: 0.42,
  steerSpeed: 1.6,
  cgHeight: 1.15,
  frontBias: 0.48,
  cameraHeight: 6.5,
  cameraDistance: 16,
  length: 12.2,
  width: 2.55,
  height: 3.2,
};

export const VEHICLE_SPECS: Record<VehicleId, VehicleSpec> = {
  golf_18carb: {
    ...GOLF_BASE,
    id: 'golf_18carb',
    name: 'VW Golf 1.8 carb',
    variantLabel: '1.8 carb',
    mass: 1160,
    accel: 6.2,
    maxSpeed: 41,
    brakeForce: 16,
    torquePeak: 0.35,
    lowEndMul: 1.05,
    powerFadeExp: 1.6,
    soundPitch: 0.88,
  },
  golf_20aba: {
    ...GOLF_BASE,
    id: 'golf_20aba',
    name: 'VW Golf 2.0 ABA',
    variantLabel: '2.0 ABA',
    mass: 1280,
    accel: 9.2,
    maxSpeed: 48,
    brakeForce: 18,
    torquePeak: 0.42,
    lowEndMul: 1.12,
    powerFadeExp: 1.4,
    soundPitch: 1.0,
  },
  golf_19tdi: {
    ...GOLF_BASE,
    id: 'golf_19tdi',
    name: 'VW Golf 1.9 TDI',
    variantLabel: '1.9 TDI',
    mass: 1340,
    accel: 7.8,
    maxSpeed: 44,
    brakeForce: 17.5,
    // Diesel: fat low/mid torque, soft top end
    torquePeak: 0.28,
    lowEndMul: 1.45,
    powerFadeExp: 2.1,
    soundPitch: 0.72,
  },
  golf_28vr6: {
    ...GOLF_BASE,
    id: 'golf_28vr6',
    name: 'VW Golf 2.8 VR6',
    variantLabel: '2.8 VR6',
    mass: 1420,
    accel: 12.2,
    maxSpeed: 56,
    brakeForce: 19,
    frontBias: 0.6,
    // Peakier top-end howl
    torquePeak: 0.55,
    lowEndMul: 1.08,
    powerFadeExp: 1.15,
    soundPitch: 1.18,
  },
  bus_diesel: {
    ...BUS_BASE,
    id: 'bus_diesel',
    name: 'Transit Bus · Diesel',
    variantLabel: 'Diesel',
    mass: 14500,
    accel: 2.55,
    maxSpeed: 22,
    brakeForce: 9.2,
    torquePeak: 0.3,
    lowEndMul: 1.35,
    powerFadeExp: 1.8,
    soundPitch: 0.55,
    regenBrakeMul: 1,
    coastRegen: 0,
  },
  bus_hybrid: {
    ...BUS_BASE,
    id: 'bus_hybrid',
    name: 'Transit Bus · Hybrid',
    variantLabel: 'Hybrid',
    mass: 13800,
    accel: 3.35,
    maxSpeed: 24,
    brakeForce: 11.5,
    torquePeak: 0.25,
    lowEndMul: 1.5,
    powerFadeExp: 1.5,
    soundPitch: 0.95,
    regenBrakeMul: 1.35,
    coastRegen: 1.8,
  },
};

export const GOLF_ENGINE_IDS: VehicleId[] = [
  'golf_18carb',
  'golf_20aba',
  'golf_19tdi',
  'golf_28vr6',
];

export const BUS_VARIANT_IDS: VehicleId[] = ['bus_diesel', 'bus_hybrid'];

export interface SurfaceInfo {
  roadFactor: number;
  /** Absolute grip mul from OSM surface × weather retain (already includes roadFactor). */
  grip?: number;
  /** Surface bumpiness 0–1. */
  noise?: number;
}

export interface WeatherDriveInfo {
  weather: WeatherPreset;
  gripMul: number;
  accelBrakeMul: number;
}

/**
 * Sim-cade tire model (FM4 / GT5 inspired):
 * weight transfer, grip circle, ABS/TCS, weather & surface.
 * v1.2: engine torque curves + hybrid regen.
 */
export class Vehicle {
  readonly spec: VehicleSpec;
  readonly mesh: THREE.Group;
  position = new THREE.Vector3();
  heading = 0;
  private vx = 0;
  private vz = 0;
  private yawRate = 0;
  private steerAngle = 0;
  speed = 0;
  sliding = false;
  private absActive = false;
  private tcsActive = false;
  /** 0–1 normalized load for engine sound. */
  throttleLoad = 0;
  private _prevVz = 0;
  private wheelPivots: THREE.Group[] = [];
  private spinMeshes: THREE.Object3D[] = [];
  private headlightMats: THREE.MeshStandardMaterial[] = [];
  private headSpots: THREE.SpotLight[] = [];
  private wheelSpin = 0;

  constructor(spec: VehicleSpec, mesh: THREE.Group) {
    this.spec = spec;
    this.mesh = mesh;
    this.collectVisuals();
  }

  private collectVisuals(): void {
    const mats = new Set<THREE.MeshStandardMaterial>();
    this.mesh.traverse((obj) => {
      if (obj instanceof THREE.Group && obj.userData.wheelPivot) {
        this.wheelPivots.push(obj);
      }
      if (obj.userData.spinMesh) this.spinMeshes.push(obj);
      if (obj instanceof THREE.Mesh && obj.userData.headlight) {
        const mat = obj.material;
        if (mat instanceof THREE.MeshStandardMaterial) mats.add(mat);
      }
      if (obj instanceof THREE.SpotLight && obj.userData.headSpot) {
        this.headSpots.push(obj);
      }
    });
    this.headlightMats = [...mats];
  }

  /** Night headlights + rolling wheels. Call after physics update. */
  updateVisuals(dt: number, night: number): void {
    const n = THREE.MathUtils.clamp(night, 0, 1);
    const glow = 0.28 + n * 2.4;
    for (const mat of this.headlightMats) {
      mat.emissiveIntensity = glow;
    }
    const spotI = n * (this.spec.class === 'bus' ? 7.5 : 5.5);
    for (const s of this.headSpots) {
      s.intensity = spotI;
    }

    const r = (this.wheelPivots[0]?.userData.wheelRadius as number | undefined) ?? 0.32;
    this.wheelSpin += (this.vz / Math.max(0.2, r)) * dt;
    for (const m of this.spinMeshes) {
      m.rotation.x = this.wheelSpin;
    }
    for (const p of this.wheelPivots) {
      p.rotation.y = p.userData.frontSteer ? this.steerAngle : 0;
    }
  }

  setPose(x: number, z: number, headingRad: number): void {
    this.position.set(x, 0, z);
    this.heading = headingRad;
    this.vx = 0;
    this.vz = 0;
    this.yawRate = 0;
    this.steerAngle = 0;
    this.speed = 0;
    this.throttleLoad = 0;
    this.syncMesh();
  }

  update(dt: number, input: Input, weather: WeatherDriveInfo, surface: SurfaceInfo): void {
    const s = this.spec;
    const g = 9.81;
    // Prefer surface-aware grip (OSM surface × weather); fall back to roadFactor × weather.
    const surfaceGrip =
      surface.grip !== undefined && Number.isFinite(surface.grip)
        ? THREE.MathUtils.clamp(surface.grip, 0.1, 1.2)
        : weather.gripMul * THREE.MathUtils.clamp(surface.roadFactor, 0.25, 1.0);
    const mu = s.gripMu * surfaceGrip;
    const noise = THREE.MathUtils.clamp(surface.noise ?? 0, 0, 1);

    const steerTarget =
      ((input.left ? 1 : 0) + (input.right ? -1 : 0)) * s.steerLock;
    const steerRate =
      s.steerSpeed *
      (0.55 + 0.45 * (1 - THREE.MathUtils.clamp(Math.abs(this.vz) / s.maxSpeed, 0, 1)));
    this.steerAngle = approach(this.steerAngle, steerTarget, steerRate * s.steerLock * dt);

    const axApprox = (this.vz - this._prevVz) / Math.max(dt, 1e-4);
    this._prevVz = this.vz;
    const transfer = THREE.MathUtils.clamp(
      (s.mass * axApprox * s.cgHeight) / (s.wheelbase * s.mass * g),
      -0.28,
      0.28,
    );
    let wFront = THREE.MathUtils.clamp(s.frontBias - transfer, 0.28, 0.78);
    let wRear = 1 - wFront;
    if (s.class === 'bus') {
      wRear = Math.min(0.62, wRear + 0.02);
      wFront = 1 - wRear;
    }

    const FzFront = s.mass * g * wFront;
    const FzRear = s.mass * g * wRear;
    const maxFxFront = mu * FzFront;
    const maxFxRear = mu * FzRear;
    const maxFyFront = mu * FzFront * 1.05;
    const maxFyRear = mu * FzRear * 1.05;

    let throttle = input.forward ? 1 : 0;
    let brake = input.back || input.brake ? (input.brake ? 1 : 0.55) : 0;
    if (input.back && this.vz < 0.8) {
      throttle = 0;
    }
    this.throttleLoad = throttle;

    const spdFrac = THREE.MathUtils.clamp(Math.abs(this.vz) / s.maxSpeed, 0, 1);
    // Torque band around torquePeak
    const bandDist = Math.abs(spdFrac - s.torquePeak);
    const band = 1 + (s.lowEndMul - 1) * Math.max(0, 1 - bandDist / 0.45);
    let engAx = throttle * s.accel * weather.accelBrakeMul * band;
    engAx *= 1 - spdFrac ** s.powerFadeExp;

    let brakeAx = 0;
    if (brake > 0 && this.vz > 0.15) {
      brakeAx = -brake * s.brakeForce * s.regenBrakeMul * weather.accelBrakeMul;
    } else if (input.back && this.vz <= 0.15) {
      engAx = -s.accel * 0.35 * weather.accelBrakeMul;
    } else if (throttle === 0 && brake === 0 && this.vz > 0.5 && s.coastRegen > 0) {
      // Hybrid lift-off regen
      brakeAx = -s.coastRegen * weather.accelBrakeMul;
    }

    const drag = 0.012 * g * Math.sign(this.vz) + 0.00045 * this.vz * Math.abs(this.vz);
    let longDemand = engAx - drag + brakeAx;

    this.tcsActive = false;
    if (longDemand > 0) {
      const driveCap = (maxFxRear * 0.92) / s.mass;
      if (longDemand > driveCap) {
        longDemand = driveCap;
        this.tcsActive = throttle > 0.2;
      }
    }

    this.absActive = false;
    if (longDemand < 0) {
      const brakeCap = -((maxFxFront + maxFxRear) * 0.9) / s.mass;
      if (longDemand < brakeCap) {
        longDemand = brakeCap;
        this.absActive = brake > 0.3;
      }
    }

    const vSafe = Math.max(Math.abs(this.vz), 1.2);
    const yaw = this.yawRate;
    const aFront = Math.atan2(this.vx + yaw * (s.wheelbase * wRear), vSafe) - this.steerAngle;
    const aRear = Math.atan2(this.vx - yaw * (s.wheelbase * wFront), vSafe);

    const Cf = (FzFront / (s.mass * g)) * 9.5 * mu * s.mass * g;
    const Cr = (FzRear / (s.mass * g)) * 10.5 * mu * s.mass * g;

    let FyFront = -Cf * Math.tan(THREE.MathUtils.clamp(aFront, -0.6, 0.6));
    let FyRear = -Cr * Math.tan(THREE.MathUtils.clamp(aRear, -0.6, 0.6));

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

    const cos = Math.cos(this.steerAngle);
    const sin = Math.sin(this.steerAngle);
    const Fx = FxRear + FxFront * cos - FyFront * sin;
    const Fy = FyRear + FyFront * cos + FxFront * sin;

    const ax = Fy / s.mass + this.vz * yaw;
    const az = Fx / s.mass - this.vx * yaw;

    this.vx += ax * dt;
    this.vz += az * dt;

    const yawMoment =
      FyFront * cos * (s.wheelbase * wRear) -
      FyRear * (s.wheelbase * wFront) +
      FxFront * sin * (s.wheelbase * wRear) * 0.35;
    const Iz = s.mass * (s.wheelbase * 0.5) ** 2 * (s.class === 'bus' ? 1.35 : 0.95);
    this.yawRate += (yawMoment / Iz) * dt;

    const yawDamp = 1.8 + mu * 1.2;
    this.yawRate *= Math.exp(-yawDamp * dt * (0.4 + 0.6 * Math.min(1, vSafe / 12)));

    const worldYaw = this.heading;
    const c = Math.cos(worldYaw);
    const sn = Math.sin(worldYaw);
    const wx = sn * this.vz + c * this.vx;
    const wz = c * this.vz - sn * this.vx;
    this.position.x += wx * dt;
    this.position.z += wz * dt;
    this.heading += this.yawRate * dt;

    // Surface noise: small lateral jitter on rough surfaces (gravel/dirt/cobble)
    if (noise > 0.1 && Math.abs(this.vz) > 2) {
      this.vx += (Math.random() - 0.5) * noise * 0.35 * dt * Math.min(Math.abs(this.vz), 20);
    }

    this.speed = Math.hypot(this.vx, this.vz);

    // Hard clamps — prevent runaway / NaN cascade
    if (this.vz < -s.maxSpeed * 0.28) this.vz = -s.maxSpeed * 0.28;
    if (this.vz > s.maxSpeed * 1.05) this.vz = s.maxSpeed * 1.05;
    const maxLat = s.maxSpeed * 0.55;
    if (this.vx > maxLat) this.vx = maxLat;
    if (this.vx < -maxLat) this.vx = -maxLat;
    if (this.yawRate > 3.5) this.yawRate = 3.5;
    if (this.yawRate < -3.5) this.yawRate = -3.5;

    if (!Number.isFinite(this.vx)) this.vx = 0;
    if (!Number.isFinite(this.vz)) this.vz = 0;
    if (!Number.isFinite(this.yawRate)) this.yawRate = 0;
    if (!Number.isFinite(this.heading)) this.heading = 0;
    if (!Number.isFinite(this.position.x) || !Number.isFinite(this.position.z)) {
      this.position.x = 0;
      this.position.z = 0;
      this.vx = 0;
      this.vz = 0;
    }
    this.speed = Math.hypot(this.vx, this.vz);

    this.syncMesh();
  }

  getSpeedKmh(): number {
    return this.speed * 3.6;
  }

  getForward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  getAssistFlags(): { abs: boolean; tcs: boolean; slide: boolean } {
    return { abs: this.absActive, tcs: this.tcsActive, slide: this.sliding };
  }

  /** RPM-ish 0–1 for audio. */
  getEngineRpmNorm(): number {
    const s = this.spec;
    const spd = THREE.MathUtils.clamp(Math.abs(this.vz) / s.maxSpeed, 0, 1);
    return THREE.MathUtils.clamp(0.15 + spd * 0.75 + this.throttleLoad * 0.2, 0, 1);
  }

  private syncMesh(): void {
    this.mesh.position.copy(this.position);
    this.mesh.rotation.order = 'YXZ';
    this.mesh.rotation.y = this.heading;
    const roll = THREE.MathUtils.clamp(-this.vx * 0.015, -0.08, 0.08);
    const pitch = THREE.MathUtils.clamp(
      -this.vz * 0.002 + (this._prevVz - this.vz) * 0.01,
      -0.06,
      0.06,
    );
    this.mesh.rotation.z = roll;
    this.mesh.rotation.x = pitch;
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

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
  const scale = (1 / mag) * (0.92 + 0.08 / mag);
  return { fx: fx * scale, fy: fy * scale, sliding: true };
}
