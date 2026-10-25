/**
 * v1.4.0 headless physics bench (no browser, no dependencies).
 * Build + run:  npx esbuild scripts/sim-bench.ts --bundle --platform=node --format=esm --outfile=<log dir>/sim-bench.mjs
 *               node <log dir>/sim-bench.mjs [vehicleId ...]
 * Flat dry asphalt, no wind, auto gearbox, assists at their defaults.
 */
import * as THREE from 'three';
import type { Input } from '../src/game/input/Input';
import { Vehicle, VEHICLE_SPECS, type VehicleId } from '../src/game/vehicles/Vehicle';

const FRAME = 1 / 60; // render frame; the vehicle steps itself at 120 Hz inside update()
const KMH = 1 / 3.6;
const G = 9.81;

class BenchInput {
  forward = false;
  back = false;
  left = false;
  right = false;
  brake = false;
  clutch = false;
  /** Analog channels (used from v1.4.0 M1; ignored by older builds). */
  steer = 0;
  throttle = 0;
  brakeAxis = 0;
  analog = false;
  consumeGearUp(): boolean { return false; }
  consumeGearDown(): boolean { return false; }
  consumeAutoSelector(): boolean { return false; }
  consumeHGear(): number | null { return null; }
  consumeCameraToggle(): boolean { return false; }
  consumeWeatherCycle(): boolean { return false; }
  consumeTimeCycle(): boolean { return false; }
  consumeTimePause(): boolean { return false; }
  consumeAssistToggle(): string | null { return null; }
  poll(): void {}
  dispose(): void {}
  setThrottle(t: number): void { this.throttle = t; this.forward = t > 0.5; }
  setBrake(b: number): void { this.brakeAxis = b; this.brake = b > 0.5; }
  setSteer(s: number): void { this.steer = s; this.left = s > 0.25; this.right = s < -0.25; }
}

const WEATHER = { weather: 'clear' as const, gripMul: 1, accelBrakeMul: 1 };
const ASPHALT = { roadFactor: 1, grip: 1, noise: 0 };

function makeCar(id: VehicleId): { v: Vehicle; inp: BenchInput } {
  const v = new Vehicle(VEHICLE_SPECS[id], new THREE.Group(), 'auto');
  v.setPose(0, 0, 0);
  v.setGroundContact(0, 0, 0, FRAME);
  return { v, inp: new BenchInput() };
}

function tick(v: Vehicle, inp: BenchInput): void {
  v.update(FRAME, inp as unknown as Input, WEATHER, ASPHALT);
}

interface AccelResult { t50: number; t100: number; t160: number; quarter: number; top: number; topAt: number; gearAt100: string; }

function accelRun(id: VehicleId): AccelResult {
  const { v, inp } = makeCar(id);
  inp.setThrottle(1);
  let t = 0;
  let dist = 0;
  const r: AccelResult = { t50: NaN, t100: NaN, t160: NaN, quarter: NaN, top: 0, topAt: 0, gearAt100: '-' };
  let lastGainT = 0;
  while (t < 240) {
    tick(v, inp);
    t += FRAME;
    dist += v.speed * FRAME;
    const kmh = v.getSpeedKmh();
    if (Number.isNaN(r.t50) && kmh >= 50) r.t50 = t;
    if (Number.isNaN(r.t100) && kmh >= 100) { r.t100 = t; r.gearAt100 = v.getGearLabel(); }
    if (Number.isNaN(r.t160) && kmh >= 160) r.t160 = t;
    if (Number.isNaN(r.quarter) && dist >= 402.3) r.quarter = t;
    if (kmh > r.top + 0.05) { r.top = kmh; r.topAt = t; lastGainT = t; }
    if (t - lastGainT > 20) break; // no longer gaining: that is the top speed
  }
  return r;
}

function brakeRun(id: VehicleId): { dist: number; time: number } {
  const { v, inp } = makeCar(id);
  inp.setThrottle(1);
  let t = 0;
  while (v.getSpeedKmh() < 103 && t < 120) { tick(v, inp); t += FRAME; }
  if (v.getSpeedKmh() < 103) return { dist: NaN, time: NaN };
  inp.setThrottle(0);
  inp.setBrake(1);
  // start the tape at exactly 100 km/h
  let dist = 0;
  let time = 0;
  let measuring = false;
  for (let i = 0; i < 60 * 30; i++) {
    tick(v, inp);
    if (!measuring && v.getSpeedKmh() <= 100) measuring = true;
    if (measuring) { dist += v.speed * FRAME; time += FRAME; }
    if (measuring && v.speed < 0.3) break;
  }
  return { dist, time };
}

/**
 * Constant-radius skidpad (200 ft / 61 m diameter). A steering controller holds the
 * radius while the target speed creeps up; the result is the highest lateral
 * acceleration held for 2 s with the path still on the circle.
 */
function skidpad(id: VehicleId, radius = 30.5): { g: number; kmh: number } {
  const { v, inp } = makeCar(id);
  let target = 15 * KMH;
  let prevH = v.heading;
  let best = { g: 0, kmh: 0 };
  const win: { ay: number; curv: number; kmh: number }[] = [];
  let steerI = 0;
  let lostFor = 0;
  for (let i = 0; i < 60 * 300; i++) {
    const err = target - v.speed;
    inp.setThrottle(THREE.MathUtils.clamp(err * 0.6 + 0.12, 0, 1));
    inp.setBrake(err < -2 ? 0.3 : 0);
    tick(v, inp);
    let dh = v.heading - prevH;
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    prevH = v.heading;
    const yawRate = dh / FRAME;
    const curv = v.speed > 1 ? yawRate / v.speed : 0;
    const cErr = 1 / radius - curv;
    steerI = THREE.MathUtils.clamp(steerI + cErr * FRAME * 40, -1, 1);
    inp.setSteer(THREE.MathUtils.clamp(cErr * 25 + steerI, -1, 1));
    const ay = v.speed * yawRate;
    win.push({ ay, curv, kmh: v.getSpeedKmh() });
    if (win.length > 120) win.shift();
    // Judge the circle on the 2 s average so on/off keyboard steering (legacy model) also counts.
    const meanCurv = win.reduce((a, w) => a + w.curv, 0) / win.length;
    const ok = win.length === 120 && Math.abs(meanCurv - 1 / radius) < 0.1 / radius;
    if (ok) {
      const mean = win.reduce((a, w) => a + w.ay, 0) / win.length;
      if (mean / G > best.g) best = { g: mean / G, kmh: win[win.length - 1].kmh };
    }
    lostFor = ok ? 0 : lostFor + FRAME;
    target += 0.12 * FRAME; // creep +0.43 km/h per second
    if (lostFor > 6 && target > 30 * KMH && v.speed < target - 3) break;
  }
  return best;
}

const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '--');
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '--');

const ids = (process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VEHICLE_SPECS)) as VehicleId[];
console.log('vehicle        0-50   0-100  0-160  400m   top km/h (at s)  gear@100  100-0 m (s)   skidpad g (km/h)');
for (const id of ids) {
  const a = accelRun(id);
  const b = brakeRun(id);
  const s = skidpad(id);
  console.log(
    `${id.padEnd(13)} ${f1(a.t50).padStart(5)}  ${f1(a.t100).padStart(5)}  ${f1(a.t160).padStart(5)}  ${f1(a.quarter).padStart(5)}  ` +
      `${f1(a.top).padStart(6)} (${f1(a.topAt)})`.padEnd(17) + `  ${a.gearAt100.padEnd(8)}  ${f1(b.dist).padStart(5)} (${f1(b.time)})   ${f2(s.g)} (${f1(s.kmh)})`,
  );
}