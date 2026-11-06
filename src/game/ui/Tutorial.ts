import { loadSettings, saveSettings } from '../save/settings';

const STEPS = [
  { title: 'Steer, throttle, brake', body: 'Use the bound steer / throttle / brake keys (defaults WASD or arrows). Feel free to skip anytime.' },
  { title: 'Handbrake & ABS', body: 'Space (default) is the handbrake. F1 toggles ABS/TCS/ESC — try them on and off.' },
  { title: 'Gears', body: 'Auto: G cycles P/R/N/D. Sequential: Q/E. H-pattern: 1–6, N, B=R.' },
  { title: 'Camera & Telemetry+', body: 'C cycles chase / cockpit. F2 opens Telemetry+ (tyre load, slip, and tyre heat).' },
  { title: 'Weather & time', body: 'R cycles weather, T time of day, P pauses the clock. I toggles satellite ground if a Cesium token is set.' },
  { title: 'Tyres & garage', body: 'On the main menu, pick a compound and a driver profile. Each driver keeps their own garage cars and setups.' },
  { title: 'Pause', body: 'Esc opens pause → Options (rebinds, graphics, units, audio) or Main menu. Have fun.' },
];

export class Tutorial {
  private root: HTMLElement;
  private step = 0;
  private visible = false;
  onDone: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'tutorial';
    this.root.className = 'overlay-menu hidden';
    parent.appendChild(this.root);
  }

  /** Start if first run (tutorialDone false), or force. */
  maybeStart(force = false): void {
    if (!force && loadSettings().tutorialDone) return;
    this.step = 0;
    this.show();
  }

  show(): void {
    this.visible = true;
    this.root.classList.remove('hidden');
    this.render();
  }
  hide(): void {
    this.visible = false;
    this.root.classList.add('hidden');
  }
  isVisible(): boolean {
    return this.visible;
  }

  private render(): void {
    const s = STEPS[this.step];
    this.root.innerHTML = `
      <div class="menu-card tutorial-card">
        <h2>Tutorial · ${this.step + 1}/${STEPS.length}</h2>
        <p class="tagline"><strong>${s.title}</strong></p>
        <p class="hint-line">${s.body}</p>
        <div class="choice-row">
          <button type="button" class="choice" id="tut-skip"><strong>Skip</strong><span>Don't show again</span></button>
          <button type="button" class="choice selected" id="tut-next"><strong>${this.step + 1 >= STEPS.length ? 'Done' : 'Next'}</strong></button>
        </div>
      </div>`;
    this.root.querySelector('#tut-skip')?.addEventListener('click', () => this.finish());
    this.root.querySelector('#tut-next')?.addEventListener('click', () => {
      if (this.step + 1 >= STEPS.length) this.finish();
      else {
        this.step++;
        this.render();
      }
    });
  }

  private finish(): void {
    saveSettings({ tutorialDone: true });
    this.hide();
    this.onDone?.();
  }
}
