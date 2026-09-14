import type { RoadCenterline } from '../map/RoadBuilder';

/**
 * Corner minimap — click to expand/collapse a larger map overlay.
 * Draws player + nearby road centerlines.
 */
export class Minimap {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private expanded = false;
  private size = 148;
  private expandedSize = 360;
  private range = 180; // meters half-extent when collapsed
  private expandedRange = 420;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'minimap';
    this.root.title = 'Click to expand / collapse map';
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.size;
    this.canvas.height = this.size;
    this.root.appendChild(this.canvas);
    const hint = document.createElement('div');
    hint.className = 'minimap-hint';
    hint.textContent = 'MAP';
    this.root.appendChild(hint);
    parent.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d')!;

    this.root.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.root.classList.toggle('expanded', this.expanded);
    const s = this.expanded ? this.expandedSize : this.size;
    this.canvas.width = s;
    this.canvas.height = s;
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? 'block' : 'none';
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

    // Background
    ctx.fillStyle = 'rgba(10, 12, 16, 0.82)';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(201, 163, 106, 0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, s - 2, s - 2);

    const scale = s / (range * 2);
    const toSx = (x: number) => (x - px) * scale + s / 2;
    // World +Z is north; canvas +Y is down — flip Z
    const toSy = (z: number) => -(z - pz) * scale + s / 2;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const line of lines) {
      const pts = line.points;
      if (pts.length < 2) continue;
      // Cull far lines roughly
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

    // Player
    const cx = s / 2;
    const cy = s / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-heading); // heading 0 = +Z; canvas up = -Z after flip → rotate by -heading
    ctx.fillStyle = '#5ad4ff';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // North indicator
    ctx.fillStyle = 'rgba(201, 163, 106, 0.9)';
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.fillText('N', s - 16, 14);
  }

  dispose(): void {
    this.root.remove();
  }
}
