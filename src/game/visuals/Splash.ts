import * as THREE from 'three';

const N = 90;
const LIFE_S = 1.3;

/** v1.3.4: one-shot spray burst when the car hits water (re-triggerable). */
export class Splash {
  readonly points: THREE.Points;
  private pos = new Float32Array(N * 3);
  private vel = new Float32Array(N * 3);
  private age = LIFE_S;
  private mat: THREE.PointsMaterial;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      color: 0xe8f2f8,
      size: 0.32,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.name = 'water-splash';
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  get active(): boolean {
    return this.age < LIFE_S;
  }

  trigger(x: number, y: number, z: number, speed: number, fx: number, fz: number): void {
    const s = Math.min(1.6, 0.5 + speed / 18);
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.4;
      this.pos[i * 3] = x + Math.cos(a) * r + fx * 1.6;
      this.pos[i * 3 + 1] = y + 0.1;
      this.pos[i * 3 + 2] = z + Math.sin(a) * r + fz * 1.6;
      const out = (1.5 + Math.random() * 3) * s;
      this.vel[i * 3] = Math.cos(a) * out + fx * speed * 0.25;
      this.vel[i * 3 + 1] = (3 + Math.random() * 4.5) * s;
      this.vel[i * 3 + 2] = Math.sin(a) * out + fz * speed * 0.25;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.age = 0;
    this.points.visible = true;
  }

  update(dt: number): void {
    if (this.age >= LIFE_S) return;
    this.age += dt;
    for (let i = 0; i < N; i++) {
      this.vel[i * 3 + 1] -= 9.81 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.mat.opacity = Math.max(0, 0.85 * (1 - this.age / LIFE_S));
    if (this.age >= LIFE_S) this.points.visible = false;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}
