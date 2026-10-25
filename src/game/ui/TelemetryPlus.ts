import type { Vehicle } from '../vehicles/Vehicle';

/**
 * v1.4.0 M10: Telemetry+ overlay (F2). Four tyres (load bar, slip ratio, slip angle, how much
 * of the grip they use), a friction circle with the car's g, the pedals and the steering.
 * Drawn on one small canvas at ~20 Hz so it costs next to nothing.
 */
export class TelemetryPlus {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private visible = false;
  private acc = 0;
  private trail: Array<[number, number]> = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'telemetry-plus';
    this.root.hidden = true;
    this.root.innerHTML = `<div class="tp-title">Telemetry+ <span>(F2)</span></div><canvas width="340" height="236"></canvas>`;
    this.canvas = this.root.querySelector('canvas')!;
    parent.appendChild(this.root);
  }

  toggle(): boolean {
    this.setVisible(!this.visible);
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.root.hidden = !v;
    this.trail = [];
  }

  isVisible(): boolean {
    return this.visible;
  }

  update(dt: number, v: Vehicle): void {
    if (!this.visible) return;
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;
    const c = this.canvas.getContext('2d');
    if (!c) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    c.clearRect(0, 0, W, H);
    c.font = '10px system-ui, sans-serif';
    const sim = v.sim;
    const fzRef = (v.phys.chassis.mass * 9.81) / 4;

    // --- four tyres, laid out like the car seen from above (front at the top) ---
    const pos: Array<[number, number]> = [
      [8, 8],
      [118, 8],
      [8, 120],
      [118, 120],
    ];
    const names = ['FL', 'FR', 'RL', 'RR'];
    sim.wheels.forEach((w, i) => {
      const [x, y] = pos[i];
      const use = Math.min(1.5, w.slip);
      c.fillStyle = use > 1 ? 'rgba(244,67,54,0.35)' : use > 0.8 ? 'rgba(255,193,7,0.28)' : 'rgba(255,255,255,0.07)';
      c.fillRect(x, y, 100, 104);
      c.strokeStyle = 'rgba(255,255,255,0.2)';
      c.strokeRect(x + 0.5, y + 0.5, 100, 104);
      c.fillStyle = '#fff';
      c.fillText(names[i], x + 5, y + 13);
      // load bar
      const load = Math.min(2, w.fz / fzRef);
      c.fillStyle = 'rgba(255,255,255,0.15)';
      c.fillRect(x + 84, y + 6, 10, 92);
      c.fillStyle = '#4fc3f7';
      c.fillRect(x + 84, y + 6 + 92 * (1 - load / 2), 10, (92 * load) / 2);
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.fillText(`Fz ${(w.fz / 1000).toFixed(1)} kN`, x + 5, y + 30);
      c.fillText(`κ ${(w.kappa * 100).toFixed(0)}%`, x + 5, y + 46);
      c.fillText(`α ${((Math.atan(w.tanAlpha) * 180) / Math.PI).toFixed(1)}°`, x + 5, y + 62);
      c.fillText(`grip ${(use * 100).toFixed(0)}%`, x + 5, y + 78);
      // grip-use bar
      c.fillStyle = 'rgba(255,255,255,0.15)';
      c.fillRect(x + 5, y + 88, 72, 6);
      c.fillStyle = use > 1 ? '#f44336' : use > 0.8 ? '#ffc107' : '#8bc34a';
      c.fillRect(x + 5, y + 88, Math.min(72, 72 * use), 6);
    });

    // --- friction circle (1.2 g at the rim) ---
    const cx = 284;
    const cy = 64;
    const rad = 48;
    c.strokeStyle = 'rgba(255,255,255,0.25)';
    for (const f of [0.5, 1]) {
      c.beginPath();
      c.arc(cx, cy, (rad * f) / 1.2, 0, Math.PI * 2);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(cx - rad, cy);
    c.lineTo(cx + rad, cy);
    c.moveTo(cx, cy - rad);
    c.lineTo(cx, cy + rad);
    c.stroke();
    const gx = -sim.ayBody / 9.81; // right turn → dot to the right
    const gy = sim.axBody / 9.81; // braking (ax < 0) → dot up, towards the front
    const dx = cx + (Math.max(-1.2, Math.min(1.2, gx)) / 1.2) * rad;
    const dy = cy + (Math.max(-1.2, Math.min(1.2, gy)) / 1.2) * rad;
    this.trail.push([dx, dy]);
    if (this.trail.length > 30) this.trail.shift();
    c.fillStyle = 'rgba(255,183,77,0.25)';
    for (const [tx, ty] of this.trail) c.fillRect(tx - 1, ty - 1, 2, 2);
    c.fillStyle = '#ffb74d';
    c.beginPath();
    c.arc(dx, dy, 4, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.textAlign = 'center';
    c.fillText(`${Math.hypot(gx, gy).toFixed(2)} g`, cx, cy + rad + 12);
    c.textAlign = 'left';

    // --- pedals + steering ---
    const px = 236;
    const py = 140;
    const bar = (label: string, val: number, color: string, x: number): void => {
      c.fillStyle = 'rgba(255,255,255,0.15)';
      c.fillRect(x, py, 14, 72);
      c.fillStyle = color;
      c.fillRect(x, py + 72 * (1 - val), 14, 72 * val);
      c.fillStyle = 'rgba(255,255,255,0.85)';
      c.fillText(label, x, py + 86);
    };
    bar('T', v.throttleInput, '#8bc34a', px);
    bar('B', v.brakeInput, '#f44336', px + 22);
    const steer = v.getSteerNorm();
    c.fillStyle = 'rgba(255,255,255,0.15)';
    c.fillRect(px + 46, py + 30, 54, 8);
    c.fillStyle = '#4fc3f7';
    const mid = px + 73;
    c.fillRect(Math.min(mid, mid - steer * 27), py + 30, Math.abs(steer * 27), 8);
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.fillText('steer', px + 58, py + 52);
  }
}