import * as THREE from 'three';
import type { DriverInput } from '../input/Input';
import type { WeatherPreset } from '../weather/Environment';
import { Transmission, type TransmissionMode } from './Transmission';
import { MAX_SUBSTEPS, PHYS_DT } from '../physics/FixedStep';
import type { PhysicsSpec } from '../physics/PhysicsSpec';
import { physicsSpecFor } from '../physics/deriveSpec';
import { Powertrain } from '../physics/Powertrain';
import { VehicleSim } from '../physics/VehicleSim';

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

/** One frame of driver controls, read once per rendered frame (v1.4.0 M1). */
export interface DriveControls {
  /** +1 = full left. */
  steer: number;
  throttle: number;
  brake: number;
  /** Gamepad / analog: skip the keyboard ramps. */
  analog: boolean;
  back: boolean;
  clutch: boolean;
  upshift: boolean;
  downshift: boolean;
  setGear: number | null;
  autoCycle: boolean;
}

/**
 * Sim-cade tire model (FM4 / GT5 inspired):
 * weight transfer, grip circle, ABS/TCS, weather & surface.
 * v1.2: engine torque curves + hybrid regen.
 */
export class Vehicle {
  readonly spec: VehicleSpec;
  /** v1.4.0: physical parameters (hand-written for the TDI, derived for the rest). */
  readonly phys: PhysicsSpec;
  readonly mesh: THREE.Group;
  position = new THREE.Vector3();
  /**
   * Physics yaw (radians) in Three.js terms: world forward = (sin yaw, 0, cos yaw),
   * positive = turning left. Not a compass bearing; use getCompassHeading() /
   * Vehicle.compassToYaw() to convert (world is X east, Z south since v1.3.2).
   */
  heading = 0;
  /** v1.4.0: the chassis / tyre simulation (owns the body velocities). */
  readonly sim: VehicleSim;
  /** v1.4.0 M4: engine, turbo and clutch. */
  readonly powertrain: Powertrain;
  private get vx(): number {
    return this.sim.v;
  }
  private set vx(x: number) {
    this.sim.v = x;
  }
  private get vz(): number {
    return this.sim.u;
  }
  private set vz(x: number) {
    this.sim.u = x;
  }
  private get yawRate(): number {
    return this.sim.r;
  }
  private set yawRate(x: number) {
    this.sim.r = x;
  }
  private steerAngle = 0;
  /** Real engine speed (rpm) behind the 0–1 engineRpm used by the sound. */
  private engineRpmActual = 850;
  /** Wheels that receive drive torque. */
  private readonly drivenIdx: number[];
  private readonly driveTorque = [0, 0, 0, 0];
  private readonly brakeTorque = [0, 0, 0, 0];
  private readonly extraInertia = [0, 0, 0, 0];
  speed = 0;
  sliding = false;
  private absActive = false;
  private tcsActive = false;
  /** 0–1 normalized load for engine sound. */
  throttleLoad = 0;
  /** Raw throttle / brake for telemetry (0–1). */
  throttleInput = 0;
  brakeInput = 0;
  /** Engine RPM normalized 0–1 (gear-aware). */
  engineRpm = 0.15;
  /** Fake turbo/boost 0–1 for TDI / VR6. */
  boost = 0;
  /** Simple coolant 0–1 (warms with load). */
  coolant = 0.35;
  transmission: Transmission;

  /** v1.3.2 ground contact: sin(grade) along the car (+ = nose up), body pitch/roll from the 4 wheels. */
  private gradeSin = 0;
  private groundPitch = 0;
  private groundRoll = 0;
  /** Vertical speed for the light suspension / airtime model (m/s). */
  vy = 0;
  /** Gravity along the grade on/off (Nigel's default: on). */
  gradeGravity = true;
  /** Handbrake-style hold after spawn/teleport until the driver touches a control. */
  private spawnHold = true;
  private wheelPivots: THREE.Group[] = [];
  private spinMeshes: THREE.Object3D[] = [];
  private headlightMats: THREE.MeshStandardMaterial[] = [];
  private headSpots: THREE.SpotLight[] = [];
  private wheelSpin = 0;
  /** v1.4.0 M0 fixed-step accumulator + pose of the previous step (render interpolation). */
  private stepAcc = 0;
  private prevStepX = 0;
  private prevStepZ = 0;
  private prevStepHeading = 0;
  /** v1.4.0 M1: driver inputs after keyboard ramps / pad smoothing. */
  private steerIn = 0;
  private throttleIn = 0;
  private brakeIn = 0;

  constructor(spec: VehicleSpec, mesh: THREE.Group, transmissionMode: TransmissionMode = 'auto') {
    this.spec = spec;
    this.phys = physicsSpecFor(spec);
    this.sim = new VehicleSim(this.phys);
    this.powertrain = new Powertrain(this.phys);
    this.drivenIdx = this.phys.drive === 'fwd' ? [0, 1] : this.phys.drive === 'rwd' ? [2, 3] : [0, 1, 2, 3];
    this.engineRpmActual = this.phys.engine.idleRpm;
    this.mesh = mesh;
    const gb = this.phys.gearbox;
    this.transmission = new Transmission({
      mode: transmissionMode,
      forwardGears: gb.ratios.length,
      ratios: gb.ratios,
      reverseRatio: gb.reverse,
      finalDrive: gb.finalDrive,
      upshiftRpm: gb.upshiftRpm,
      downshiftRpm: gb.downshiftRpm,
      shiftTimeS: gb.shiftTimeS,
    });
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

    // v1.4.0: the visible wheels turn at the front tyres' real spin (shows wheelspin and lock-ups)
    const fw = this.sim.wheels;
    this.wheelSpin += ((fw[0].omega + fw[1].omega) / 2) * dt;
    for (const m of this.spinMeshes) {
      m.rotation.x = this.wheelSpin;
    }
    for (const p of this.wheelPivots) {
      p.rotation.y = p.userData.frontSteer ? this.steerAngle : 0;
    }
  }

  /**
   * Feed the ground under the four wheels (called by Game each frame before update).
   * pitch/roll in radians for the body; gradeSin = sin(slope) along the heading.
   */
  setGroundContact(pitch: number, roll: number, gradeSin: number, dt: number): void {
    const k = 1 - Math.exp(-dt * 12);
    const p = THREE.MathUtils.clamp(Number.isFinite(pitch) ? pitch : 0, -0.55, 0.55);
    const r = THREE.MathUtils.clamp(Number.isFinite(roll) ? roll : 0, -0.45, 0.45);
    this.groundPitch += (p - this.groundPitch) * k;
    this.groundRoll += (r - this.groundRoll) * k;
    this.gradeSin = THREE.MathUtils.clamp(Number.isFinite(gradeSin) ? gradeSin : 0, -0.6, 0.6);
  }

  getGradeSin(): number {
    return this.gradeSin;
  }

  setPose(x: number, z: number, headingRad: number): void {
    this.spawnHold = true;
    this.vy = 0;
    this.gradeSin = 0;
    this.groundPitch = 0;
    this.groundRoll = 0;
    this.position.set(x, 0, z);
    this.heading = headingRad;
    this.sim.reset();
    this.powertrain.reset();
    this.steerAngle = 0;
    this.speed = 0;
    this.throttleLoad = 0;
    this.stepAcc = 0;
    this.prevStepX = x;
    this.prevStepZ = z;
    this.prevStepHeading = headingRad;
    this.syncMesh();
  }

  /**
   * v1.4.0 M0: advance the physics by whole 1/120 s steps. The frame dt only feeds
   * the accumulator, so handling no longer depends on the frame rate.
   */
  update(dt: number, input: DriverInput, weather: WeatherDriveInfo, surface: SurfaceInfo): void {
    const frameDt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
    this.stepAcc += frameDt;
    let steps = 0;
    let ctl = Vehicle.readControls(input);
    while (this.stepAcc >= PHYS_DT && steps < MAX_SUBSTEPS) {
      this.prevStepX = this.position.x;
      this.prevStepZ = this.position.z;
      this.prevStepHeading = this.heading;
      this.step(PHYS_DT, ctl, weather, surface);
      // shift requests are one-shot: only the first step of the frame sees them
      if (steps === 0) ctl = { ...ctl, upshift: false, downshift: false, setGear: null, autoCycle: false };
      this.stepAcc -= PHYS_DT;
      steps++;
    }
    // Too far behind (tab was hidden, long hitch): drop the backlog instead of fast-forwarding.
    if (this.stepAcc >= PHYS_DT) this.stepAcc = 0;
    this.syncMesh();
  }

  /** Read the input device once per frame (shift requests are consumed here). */
  static readControls(input: DriverInput): DriveControls {
    const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
    return {
      steer: input.analog
        ? THREE.MathUtils.clamp(Number.isFinite(input.steer) ? input.steer : 0, -1, 1)
        : (input.left ? 1 : 0) - (input.right ? 1 : 0),
      throttle: input.analog ? clamp01(input.throttle) : input.forward ? 1 : 0,
      brake: input.analog ? clamp01(input.brakeAxis) : input.brake ? 1 : 0,
      analog: input.analog,
      back: input.back,
      clutch: input.clutch,
      upshift: input.consumeGearUp(),
      downshift: input.consumeGearDown(),
      setGear: input.consumeHGear(),
      autoCycle: input.consumeAutoSelector(),
    };
  }

  /**
   * v1.4.0 M1: keyboard keys ramp like a real pedal / wheel instead of snapping;
   * steering winds on more slowly at speed and returns to centre faster than it winds on.
   * A gamepad goes straight through with light smoothing.
   */
  private filterDriverInputs(c: DriveControls, dt: number): void {
    if (c.analog) {
      this.steerIn = approach(this.steerIn, c.steer, dt * 10);
      this.throttleIn = c.throttle;
      this.brakeIn = c.brake;
      return;
    }
    const speedK = 1 / (1 + Math.abs(this.vz) / 22);
    const returning = c.steer === 0 || Math.sign(c.steer) !== Math.sign(this.steerIn);
    const rate = returning ? 4.5 : 1.4 + 2.6 * speedK;
    this.steerIn = approach(this.steerIn, c.steer, rate * dt);
    this.throttleIn = approach(this.throttleIn, c.throttle, (c.throttle > this.throttleIn ? 6 : 12) * dt);
    this.brakeIn = approach(this.brakeIn, c.brake, (c.brake > this.brakeIn ? 7 : 14) * dt);
  }

  private step(dt: number, ctl: DriveControls, weather: WeatherDriveInfo, surface: SurfaceInfo): void {
    const p = this.phys;
    const g = 9.81;
    this.filterDriverInputs(ctl, dt);
    // Prefer surface-aware grip (OSM surface × weather); fall back to roadFactor × weather.
    const surfaceGrip =
      surface.grip !== undefined && Number.isFinite(surface.grip)
        ? THREE.MathUtils.clamp(surface.grip, 0.1, 1.2)
        : weather.gripMul * THREE.MathUtils.clamp(surface.roadFactor, 0.25, 1.0);
    const noise = THREE.MathUtils.clamp(surface.noise ?? 0, 0, 1);

    // --- steering (road-wheel angle) ---
    const steerTarget = this.steerIn * p.steering.maxAngle;
    this.steerAngle = approach(this.steerAngle, steerTarget, p.steering.maxAngle * 6 * dt);

    // --- transmission ---
    this.transmission.update(dt, this.vz, this.throttleIn, {
      upshift: ctl.upshift,
      downshift: ctl.downshift,
      setGear: ctl.setGear,
      clutch: ctl.clutch,
      autoCycle: ctl.autoCycle,
    }, this.sim.meanOmega(this.drivenIdx));
    const drive = this.transmission.getDriveRatio();

    let throttle = this.throttleIn;
    let brake = this.brakeIn;
    // S: brake when moving forward; only drive when already in reverse gear/selector
    if (ctl.back) {
      if (this.vz > 0.6 && !drive.reverse) brake = Math.max(brake, 0.7);
      else if (drive.reverse) throttle = Math.max(throttle, 0.85);
      else if (Math.abs(this.vz) <= 0.6) brake = Math.max(brake, 0.55);
    }
    if (this.transmission.mode === 'auto' && this.transmission.autoSelector === 0 && ctl.back) {
      // In R: W goes reverse, S brakes
      throttle = 0;
      brake = Math.max(brake, 0.7);
    }
    const parked = this.transmission.mode === 'auto' && this.transmission.autoSelector === -1;
    if (parked) throttle = 0;
    if (this.spawnHold && (throttle > 0 || brake > 0 || ctl.steer !== 0 || ctl.back)) {
      this.spawnHold = false;
    }
    this.throttleInput = throttle;
    this.brakeInput = brake;
    this.throttleLoad = throttle;

    // --- engine → wheels ---
    this.computeDrive(dt, throttle, drive.engaged ? drive.ratio : 0, drive.reverse);

    // --- brakes (Park / spawn hold lock the wheels like a parking pawl + handbrake) ---
    const regenMul = p.regen?.brakeMul ?? 1;
    for (let i = 0; i < 4; i++) {
      const base = i < 2 ? p.brakes.frontNm : p.brakes.rearNm;
      this.brakeTorque[i] = brake * base * regenMul;
      if (parked || this.spawnHold) this.brakeTorque[i] = Math.max(this.brakeTorque[i], base * 3);
    }

    // --- chassis + tyres ---
    const gradeSin = this.gradeGravity ? this.gradeSin : 0;
    const hold =
      (brake > 0.2 || parked || this.spawnHold) &&
      Math.abs(this.vz) < 0.8 &&
      Math.abs(g * gradeSin) < p.tire.mu * surfaceGrip * g * 0.9;
    this.sim.step(dt, {
      steer: this.steerAngle,
      driveTorque: this.driveTorque,
      brakeTorque: this.brakeTorque,
      extraInertia: this.extraInertia,
      mu: surfaceGrip,
      noise,
      gradeSin,
      hold,
    });

    const c = Math.cos(this.heading);
    const sn = Math.sin(this.heading);
    const wx = sn * this.vz + c * this.vx;
    const wz = c * this.vz - sn * this.vx;
    this.position.x += wx * dt;
    this.position.z += wz * dt;
    this.heading += this.yawRate * dt;

    this.sliding = this.speed > 3 && this.sim.wheels.some((w) => w.slip > 1.25);
    this.coolant = approach(
      this.coolant,
      THREE.MathUtils.clamp(0.3 + this.engineRpm * 0.35 + throttle * 0.2, 0.3, 0.95),
      dt * 0.05,
    );

    if (!Number.isFinite(this.heading)) this.heading = 0;
    if (!Number.isFinite(this.position.x) || !Number.isFinite(this.position.z)) {
      this.position.x = 0;
      this.position.z = 0;
      this.sim.reset();
    }
    this.speed = Math.hypot(this.vx, this.vz);
  }

  /** Engine → clutch → gearbox → open differential (equal torque to each driven wheel). */
  private computeDrive(dt: number, throttle: number, ratio: number, reverse: boolean): void {
    const e = this.phys.engine;
    const n = this.drivenIdx.length;
    const out = this.powertrain.update(dt, {
      throttle,
      ratio,
      direction: reverse ? -1 : 1,
      wheelOmega: this.sim.meanOmega(this.drivenIdx),
      clutchPedal: this.transmission.clutchIn,
      shifting: this.transmission.shiftTimer > 0,
    });
    this.driveTorque.fill(0);
    this.extraInertia.fill(0);
    for (const i of this.drivenIdx) {
      this.driveTorque[i] = out.wheelTorque / n;
      this.extraInertia[i] = out.wheelInertia / n;
    }
    // hybrid / regen: coast regen on the driven wheels with the throttle closed
    const regen = this.phys.regen;
    if (regen && throttle < 0.05 && this.vz > 2) {
      const fade = Math.min(1, (this.vz - 2) / 4);
      const t = (regen.coastDecel * this.phys.chassis.mass * this.phys.tire.radius * fade) / n;
      for (const i of this.drivenIdx) this.driveTorque[i] -= t;
    }
    const rpm = this.powertrain.rpm;
    this.engineRpmActual = rpm;
    this.engineRpm = THREE.MathUtils.clamp((rpm - e.idleRpm * 0.9) / (e.redlineRpm - e.idleRpm * 0.9), 0, 1);
    this.boost = this.powertrain.boost;
  }
  /** v1.3.4: water — heavy drag on every axis (no traction comes from the 0.1 grip). */
  applyWaterDrag(dt: number, k = 3.2): void {
    const f = Math.exp(-k * dt);
    this.vx *= f;
    this.vz *= f;
    this.yawRate *= f;
    this.speed = Math.hypot(this.vx, this.vz);
  }

  /** v1.3.4: wall contact — remove the velocity into the wall (world normal points out of it). */
  blockAlong(nx: number, nz: number): void {
    const c = Math.cos(this.heading);
    const sn = Math.sin(this.heading);
    let wx = sn * this.vz + c * this.vx;
    let wz = c * this.vz - sn * this.vx;
    const into = wx * nx + wz * nz;
    if (into < 0) {
      wx -= into * nx * 1.15;
      wz -= into * nz * 1.15;
      // scrub some speed along the wall too
      wx *= 0.9;
      wz *= 0.9;
      this.vz = sn * wx + c * wz;
      this.vx = c * wx - sn * wz;
      this.speed = Math.hypot(this.vx, this.vz);
    }
  }

  getSpeedKmh(): number {
    return this.speed * 3.6;
  }

  /** Compass bearing (0 = north, clockwise, radians) → physics yaw. */
  static compassToYaw(compassRad: number): number {
    return Math.PI - compassRad;
  }

  /** Physics yaw → compass bearing in [0, 2π). */
  static yawToCompass(yaw: number): number {
    const c = Math.PI - yaw;
    const twoPi = Math.PI * 2;
    return ((c % twoPi) + twoPi) % twoPi;
  }

  /** Current compass bearing (0 = north, clockwise, radians). */
  getCompassHeading(): number {
    return Vehicle.yawToCompass(this.heading);
  }

  getForward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  getAssistFlags(): { abs: boolean; tcs: boolean; slide: boolean } {
    return { abs: this.absActive, tcs: this.tcsActive, slide: this.sliding };
  }

  /** RPM-ish 0–1 for audio / HUD. */
  getEngineRpmNorm(): number {
    return THREE.MathUtils.clamp(this.engineRpm, 0, 1);
  }

  getGearLabel(): string {
    return this.transmission.mode === 'auto'
      ? this.transmission.getAutoSelectorLabel()
      : this.transmission.getLabel();
  }

  /** v1.4.0: the engine's real rpm. */
  getEngineRpmDisplay(): number {
    return Math.round(this.engineRpmActual);
  }

  private syncMesh(): void {
    // Draw between the last two physics steps so 60/144 Hz displays both look smooth.
    const a = Math.min(1, this.stepAcc / PHYS_DT);
    if (!Number.isFinite(this.prevStepX) || !Number.isFinite(this.prevStepZ) || !Number.isFinite(this.prevStepHeading)) {
      this.prevStepX = this.position.x;
      this.prevStepZ = this.position.z;
      this.prevStepHeading = this.heading;
    }
    this.mesh.position.copy(this.position);
    this.mesh.position.x = this.prevStepX + (this.position.x - this.prevStepX) * a;
    this.mesh.position.z = this.prevStepZ + (this.position.z - this.prevStepZ) * a;
    this.mesh.rotation.order = 'YXZ';
    this.mesh.rotation.y = this.prevStepHeading + (this.heading - this.prevStepHeading) * a;
    // v1.4.0: body roll / pitch from the sprung-mass response (same signal that moves the load)
    const roll = THREE.MathUtils.clamp(this.sim.bodyRoll(), -0.12, 0.12);
    const pitch = THREE.MathUtils.clamp(this.sim.bodyPitch(), -0.08, 0.08);
    // Ground pitch: rotation.x > 0 tips the nose (+Z) down, so nose-up = negative.
    this.mesh.rotation.z = roll + this.groundRoll;
    this.mesh.rotation.x = pitch + this.groundPitch;
  }
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}
