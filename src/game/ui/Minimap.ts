import type { RoadCenterline } from '../map/RoadBuilder';

/**
 * Corner minimap — click to expand a semi-transparent corner panel (not a
 * full-screen takeover). Click again or press Escape to dismiss.
 */
export class Minimap {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private expanded = false;
  private size = 132;
  /** Keep expanded map as a corner overlay so most of the 3D view stays visible. */
  private expandedSize = 220;
  private range = 160;
  private expandedRange = 320;
  private onKey: (e: KeyboardEvent) => void;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'minimap';
    this.root.title = 'Click to expand / collapse map (Esc dismisses)';
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size;
    this.canvas.height = this.size;
    this.root.appendChild(this.canvas);
    const hint = document.createElement('div');
    hint.className = 'minimap-hint';
    hint.textContent = 'MAP';
    this.root.appendChild(hint);
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'minimap-dismiss';
    dismiss.textContent = '✕';
    dismiss.title = 'Collapse map';
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.expanded) this.toggle();
    });
    this.root.appendChild(dismiss);
    parent.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;

    this.root.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && this.expanded) {
        e.preventDefault();
        this.toggle();
      }
    };
    window.addEventListener('keydown', this.onKey);
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.root.classList.toggle('expanded', this.expanded);
    const s = this.expanded ? this.expandedSize : this.size;
    this.canvas.width = s;
    this.canvas.height = s;
    const hint = this.root.querySelector('.minimap-hint');
    if (hint) hint.textContent = this.expanded ? 'MAP · Esc' : 'MAP';
  }

  collapse(): void {
    if (this.expanded) this.toggle();
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? 'block' : 'none';
    if (!v) this.collapse();
  }

  draw(
    lines: RoadCenterline[],
    px: number,
    pz: number,
    heading: number,
  ): void {
    const s = this.canvas.width;
    const range = this.expanded ? this.expandedRange : this.range;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, s, s);

    // Semi-transparent so the driving view remains readable behind the panel
    ctx.fillStyle = this.expanded ? 'rgba(10, 12, 16, 0.55)' : 'rgba(10, 12, 16, 0.78)';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(201, 163, 106, 0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, s - 2, s - 2);

    const scale = s / (range * 2);
    const toSx = (x: number) => (x - px) * scale + s / 2;
    const toSy = (z: number) => -(z - pz) * scale + s / 2;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const line of lines) {
      const pts = line.points;
      if (pts.length < 2) continue;
      let near = false;
      for (const p of pts) {
        if (Math.abs(p.x - px) < range * 1.2 && Math.abs(p.z - pz) < range * 1.2) {
          near = true;
          break;
        }
      }
      if (!near) continue;

      const major =
        line.highway === 'motorway' ||
        line.highway === 'trunk' ||
        line.highway === 'primary';
      ctx.strokeStyle = major ? 'rgba(220, 200, 160, 0.85)' : 'rgba(140, 150, 165, 0.55)';
      ctx.lineWidth = major ? 2.2 : 1.2;
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        const sx = toSx(p.x);
        const sy = toSy(p.z);
        if (sx < -20 || sy < -20 || sx > s + 20 || sy > s + 20) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(sx, sy);
          started = true;
        } else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }

    const cx = s / 2;
    const cy = s / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-heading);
    ctx.fillStyle = '#5ad4ff';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = 'rgba(201, 163, 106, 0.9)';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.fillText('N', s - 16, 14);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    this.root.remove();
  }
}
