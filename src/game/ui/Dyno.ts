import { Group } from 'three';
import type { DriverInput } from '../input/Input';
import { physicsSpecFor } from '../physics/deriveSpec';
import { EvDrive } from '../physics/Motor';
import { torqueAt, type PhysicsSpec } from '../physics/PhysicsSpec';
import { Vehicle, VEHICLE_SPECS, type VehicleId } from '../vehicles/Vehicle';

/**
 * v1.4.0 M10: Dyno page. Left: the engine (or motors) on a brake dyno: torque and power
 * against rpm, with boost for turbo diesels and battery power for EVs. Right: a virtual
 * roller pull of the real car model (same physics as the game, flat dry road, full throttle):
 * power at the wheels against road speed, gear changes and all.
 */

interface Series {
  ys: number[];
  color: string;
  label: string;
  axis: 'left' | 'right';
  dashed?: boolean;
}

interface CurveData {
  xs: number[];
  xLabel: string;
  leftLabel: string;
  rightLabel: string;
  series: Series[];
  notes: string[];
}

const KW = 1 / 1000;

function engineCurves(p: PhysicsSpec): CurveData {
  if (p.ev) return motorCurves(p);
  const e = p.engine;
  const xs: number[] = [];
  const tq: number[] = [];
  const kw: number[] = [];
  const tqNoBoost: number[] = [];
  const boost: number[] = [];
  const top = e.limiterRpm;
  for (let rpm = e.idleRpm; rpm <= top; rpm += 50) {
    const full = torqueAt(e.torqueCurve, rpm);
    xs.push(rpm);
    tq.push(full);
    kw.push((full * rpm * Math.PI) / 30 * KW);
    if (e.turbo) {
      const tb = e.turbo;
      const x = Math.min(1, Math.max(0, (rpm - tb.spoolStartRpm) / Math.max(1, tb.fullBoostRpm - tb.spoolStartRpm)));
      boost.push(tb.maxBoostBar * x * x * (3 - 2 * x) * 100); // shown ×100 so it shares the kW axis
      tqNoBoost.push(full * (1 - tb.boostShare));
    }
  }
  let peakKw = 0;
  let peakKwRpm = 0;
  let peakNm = 0;
  let peakNmRpm = 0;
  kw.forEach((v, i) => {
    if (v > peakKw) {
      peakKw = v;
      peakKwRpm = xs[i];
    }
    if (tq[i] > peakNm) {
      peakNm = tq[i];
      peakNmRpm = xs[i];
    }
  });
  const series: Series[] = [
    { ys: tq, color: '#4fc3f7', label: 'Torque (Nm)', axis: 'left' },
    { ys: kw, color: '#ffb74d', label: 'Power (kW)', axis: 'right' },
  ];
  if (e.turbo) {
    series.push({ ys: tqNoBoost, color: '#4fc3f7', label: 'Torque, no boost', axis: 'left', dashed: true });
    series.push({ ys: boost, color: '#aed581', label: 'Boost (bar ×100)', axis: 'right', dashed: true });
  }
  return {
    xs,
    xLabel: 'engine rpm',
    leftLabel: 'Nm',
    rightLabel: 'kW',
    series,
    notes: [
      `${Math.round(peakNm)} Nm @ ${Math.round(peakNmRpm / 50) * 50} rpm`,
      `${Math.round(peakKw)} kW (${Math.round(peakKw * 1.36)} PS) @ ${Math.round(peakKwRpm / 50) * 50} rpm`,
      e.turbo ? `turbo ${e.turbo.maxBoostBar.toFixed(2)} bar, full from ${e.turbo.fullBoostRpm} rpm` : 'naturally aspirated',
    ],
  };
}

function motorCurves(p: PhysicsSpec): CurveData {
  const ev = p.ev!;
  const drive = new EvDrive(ev);
  const xs: number[] = [];
  const tq: number[] = [];
  const kw: number[] = [];
  const batt: number[] = [];
  const perMotor: number[][] = ev.motors.map(() => []);
  let peakKw = 0;
  for (let rpm = 0; rpm <= ev.maxMotorRpm; rpm += 100) {
    const w = Math.max(1, (rpm * Math.PI) / 30);
    const each = ev.motors.map((_, i) => drive.availableTorque(i, w));
    let total = each.reduce((a, b) => a + b, 0);
    const cap = ev.systemPowerW / w;
    const scale = total > cap ? cap / total : 1;
    total *= scale;
    xs.push(rpm);
    tq.push(total);
    each.forEach((t, i) => perMotor[i].push(t * scale));
    const pw = total * w * KW;
    kw.push(pw);
    batt.push(pw / ev.efficiency);
    peakKw = Math.max(peakKw, pw);
  }
  const series: Series[] = [
    { ys: tq, color: '#4fc3f7', label: 'Motor torque, both (Nm)', axis: 'left' },
    { ys: kw, color: '#ffb74d', label: 'Power (kW)', axis: 'right' },
    { ys: batt, color: '#aed581', label: 'Battery power (kW)', axis: 'right', dashed: true },
  ];
  ev.motors.forEach((m, i) =>
    series.push({ ys: perMotor[i], color: m.axle === 'rear' ? '#9575cd' : '#4db6ac', label: `${m.axle} motor (Nm)`, axis: 'left', dashed: true }),
  );
  const kmhAtMax = ((ev.maxMotorRpm * Math.PI) / 30 / ev.reduction) * p.tire.radius * 3.6;
  return {
    xs,
    xLabel: `motor rpm (${Math.round(kmhAtMax / (ev.maxMotorRpm / 1000))} km/h per 1000)`,
    leftLabel: 'Nm',
    rightLabel: 'kW',
    series,
    notes: [
      `${Math.round(tq[0])} Nm from 0 rpm (${Math.round((tq[0] * ev.reduction) / p.tire.radius / 1000)} kN at the tyres)`,
      `${Math.round(peakKw)} kW (${Math.round(peakKw * 1.36)} PS) system limit`,
      `${ev.reduction.toFixed(2)}:1 single speed · ${ev.batteryKWh} kWh · regen ${(ev.regenDecel / 9.81).toFixed(2)} g`,
    ],
  };
}

class RollerInput implements DriverInput {
  forward = true;
  back = false;
  left = false;
  right = false;
  brake = false;
  clutch = false;
  steer = 0;
  throttle = 1;
  brakeAxis = 0;
  analog = true;
  consumeGearUp(): boolean {
    return false;
  }
  consumeGearDown(): boolean {
    return false;
  }
  consumeAutoSelector(): boolean {
    return false;
  }
  consumeHGear(): number | null {
    return null;
  }
}

/** Full-throttle pull of the real car model; samples every 0.1 s. */
function rollerPull(id: VehicleId): { curve: CurveData; t100: number } {
  const v = new Vehicle(VEHICLE_SPECS[id], new Group(), 'auto');
  v.setPose(0, 0, 0);
  const frame = 1 / 60;
  v.setGroundContact(0, 0, 0, frame);
  const inp = new RollerInput();
  const weather = { weather: 'clear' as const, gripMul: 1, accelBrakeMul: 1 };
  const road = { roadFactor: 1, grip: 1, noise: 0 };
  const xs: number[] = [];
  const kw: number[] = [];
  const kn: number[] = [];
  const rpm: number[] = [];
  let t = 0;
  let t100 = NaN;
  let best = 0;
  let lastGain = 0;
  while (t < 60) {
    v.update(frame, inp, weather, road);
    t += frame;
    const kmh = v.getSpeedKmh();
    if (Number.isNaN(t100) && kmh >= 100) t100 = t;
    if (kmh > best + 0.2) {
      best = kmh;
      lastGain = t;
    }
    if (t - lastGain > 3) break;
    if (Math.round(t * 60) % 6 === 0 && kmh > 1) {
      const fx = v.sim.wheels.reduce((a, w) => a + w.fx, 0);
      xs.push(kmh);
      kw.push(Math.max(0, fx * v.sim.u * KW));
      kn.push(Math.max(0, fx / 1000));
      rpm.push(v.getEngineRpmDisplay() / 1000);
    }
  }
  return {
    t100,
    curve: {
      xs,
      xLabel: 'road speed (km/h)',
      leftLabel: 'kW',
      rightLabel: 'kN · krpm',
      series: [
        { ys: kw, color: '#ffb74d', label: 'Power at the wheels (kW)', axis: 'left' },
        { ys: kn, color: '#4fc3f7', label: 'Tractive force (kN)', axis: 'right' },
        { ys: rpm, color: '#e0e0e0', label: 'rpm ÷ 1000', axis: 'right', dashed: true },
      ],
      notes: [
        `peak ${Math.round(Math.max(...kw))} kW at the wheels`,
        `0–100 km/h ${Number.isNaN(t100) ? '—' : t100.toFixed(1) + ' s'} on this roller`,
        `top ${Math.round(best)} km/h`,
      ],
    },
  };
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function drawChart(canvas: HTMLCanvasElement, d: CurveData, title: string): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth || 520;
  const H = canvas.clientHeight || 280;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const c = canvas.getContext('2d');
  if (!c) return;
  c.scale(dpr, dpr);
  c.fillStyle = '#0f1318';
  c.fillRect(0, 0, W, H);
  const L = 48;
  const R = W - 48;
  const T = 28;
  const B = H - 34;
  const xMax = niceMax(Math.max(...d.xs));
  const leftMax = niceMax(Math.max(1, ...d.series.filter((s) => s.axis === 'left').flatMap((s) => s.ys)));
  const rightMax = niceMax(Math.max(1, ...d.series.filter((s) => s.axis === 'right').flatMap((s) => s.ys)));
  const X = (x: number): number => L + (x / xMax) * (R - L);
  c.strokeStyle = 'rgba(255,255,255,0.08)';
  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.font = '11px system-ui, sans-serif';
  c.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = B - ((B - T) * i) / 5;
    c.beginPath();
    c.moveTo(L, y);
    c.lineTo(R, y);
    c.stroke();
    c.textAlign = 'right';
    c.fillText(String(Math.round((leftMax * i) / 5)), L - 6, y + 4);
    c.textAlign = 'left';
    c.fillText(String(Math.round((rightMax * i) / 5)), R + 6, y + 4);
    const x = L + ((R - L) * i) / 5;
    c.textAlign = 'center';
    c.fillText(String(Math.round((xMax * i) / 5)), x, B + 14);
  }
  c.fillText(d.xLabel, (L + R) / 2, H - 4);
  c.textAlign = 'left';
  c.fillText(d.leftLabel, 6, T - 10);
  c.textAlign = 'right';
  c.fillText(d.rightLabel, W - 6, T - 10);
  c.textAlign = 'left';
  c.fillStyle = '#fff';
  c.font = '600 12px system-ui, sans-serif';
  c.fillText(title, L, 16);
  for (const s of d.series) {
    const max = s.axis === 'left' ? leftMax : rightMax;
    c.strokeStyle = s.color;
    c.lineWidth = s.dashed ? 1.3 : 2.2;
    c.setLineDash(s.dashed ? [5, 4] : []);
    c.beginPath();
    s.ys.forEach((y, i) => {
      const px = X(d.xs[i]);
      const py = B - (Math.min(y, max) / max) * (B - T);
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    });
    c.stroke();
  }
  c.setLineDash([]);
}

function legend(d: CurveData): string {
  return d.series
    .map((s) => `<span class="dyno-key"><i style="border-color:${s.color};border-style:${s.dashed ? 'dashed' : 'solid'}"></i>${s.label}</span>`)
    .join('');
}

/** Opens the Dyno page over the start menu for one car. */
export function openDyno(parent: HTMLElement, id: VehicleId): void {
  parent.querySelector('.dyno-overlay')?.remove();
  const spec = VEHICLE_SPECS[id];
  const phys = physicsSpecFor(spec);
  const engine = engineCurves(phys);
  const roller = rollerPull(id);
  const el = document.createElement('div');
  el.className = 'dyno-overlay';
  el.innerHTML = `
    <div class="dyno-card" role="dialog" aria-label="Dyno">
      <div class="dyno-head">
        <h2>Dyno · ${spec.name}</h2>
        <button type="button" class="hud-btn dyno-close">Close (Esc)</button>
      </div>
      <div class="dyno-grid">
        <div>
          <canvas class="dyno-canvas" id="dyno-engine"></canvas>
          <div class="dyno-legend">${legend(engine)}</div>
          <ul class="dyno-notes">${engine.notes.map((n) => `<li>${n}</li>`).join('')}</ul>
        </div>
        <div>
          <canvas class="dyno-canvas" id="dyno-roller"></canvas>
          <div class="dyno-legend">${legend(roller.curve)}</div>
          <ul class="dyno-notes">${roller.curve.notes.map((n) => `<li>${n}</li>`).join('')}</ul>
        </div>
      </div>
      <p class="dyno-foot">${phys.source}. Roller: the game's own physics, flat dry asphalt, full throttle, auto box, assists on.</p>
    </div>`;
  parent.appendChild(el);
  drawChart(el.querySelector<HTMLCanvasElement>('#dyno-engine')!, engine, phys.ev ? 'Motors (brake dyno)' : 'Engine (brake dyno)');
  drawChart(el.querySelector<HTMLCanvasElement>('#dyno-roller')!, roller.curve, 'Roller pull (at the wheels)');
  const close = (): void => {
    el.remove();
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Escape') close();
  };
  window.addEventListener('keydown', onKey);
  el.querySelector('.dyno-close')!.addEventListener('click', close);
  el.addEventListener('click', (e) => {
    if (e.target === el) close();
  });
}