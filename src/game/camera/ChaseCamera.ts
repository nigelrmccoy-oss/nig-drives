import * as THREE from 'three';
import type { Vehicle } from '../vehicles/Vehicle';

export type CameraMode = 'chase' | 'first';

export class ChaseCamera {
  mode: CameraMode = 'chase';
  private camera: THREE.PerspectiveCamera;
  private currentPos = new THREE.Vector3();
  private currentLook = new THREE.Vector3();
  private initialized = false;
  /** Optional ground height sampler to keep the lens above terrain. */
  private groundAt: ((x: number, z: number) => number) | null = null;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  setGroundSampler(fn: ((x: number, z: number) => number) | null): void {
    this.groundAt = fn;
  }

  toggle(): void {
    this.mode = this.mode === 'chase' ? 'first' : 'chase';
  }

  update(dt: number, vehicle: Vehicle): void {
    const forward = vehicle.getForward();
    const spec = vehicle.spec;

    let desiredPos: THREE.Vector3;
    let desiredLook: THREE.Vector3;

    if (this.mode === 'chase') {
      desiredPos = vehicle.position
        .clone()
        .addScaledVector(forward, -spec.cameraDistance)
        .add(new THREE.Vector3(0, spec.cameraHeight, 0));
      desiredLook = vehicle.position.clone().add(new THREE.Vector3(0, spec.height * 0.55, 0));
    } else {
      const eyeHeight = spec.id === 'bus' ? 2.4 : 1.25;
      const eyeForward = spec.id === 'bus' ? 5.2 : 0.9;
      desiredPos = vehicle.position
        .clone()
        .addScaledVector(forward, eyeForward)
        .add(new THREE.Vector3(0, eyeHeight, 0));
      desiredLook = desiredPos.clone().addScaledVector(forward, 20);
    }

    // Keep camera from clipping into hills / ground
    if (this.groundAt) {
      const minY = this.groundAt(desiredPos.x, desiredPos.z) + (this.mode === 'chase' ? 1.8 : 1.0);
      if (desiredPos.y < minY) desiredPos.y = minY;
    } else {
      const minY = vehicle.position.y + (this.mode === 'chase' ? 1.5 : 0.8);
      if (desiredPos.y < minY) desiredPos.y = minY;
    }

    if (!this.initialized) {
      this.currentPos.copy(desiredPos);
      this.currentLook.copy(desiredLook);
      this.initialized = true;
    } else {
      const lerp = 1 - Math.exp(-dt * (this.mode === 'chase' ? 6 : 14));
      this.currentPos.lerp(desiredPos, lerp);
      this.currentLook.lerp(desiredLook, lerp);
    }

    // Soft clamp smoothed position too (after hills)
    if (this.groundAt) {
      const minY = this.groundAt(this.currentPos.x, this.currentPos.z) + 1.2;
      if (this.currentPos.y < minY) this.currentPos.y = minY;
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLook);
  }

  reset(): void {
    this.initialized = false;
  }
}
