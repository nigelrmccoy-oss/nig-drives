import { loadSettings, saveSettings } from '../save/settings';
import {
  ACTION_LABELS,
  DEFAULT_BINDINGS,
  flattenBindings,
  bindingsFromSettings,
  type InputAction,
} from '../input/bindings';
import type { QualityLevel } from '../visuals/Quality';
import { saveQualityLevel } from '../visuals/Quality';

const REBINDABLE: InputAction[] = [
  'throttle', 'brake', 'steer_left', 'steer_right', 'handbrake', 'clutch',
  'shift_up', 'shift_down', 'auto_selector', 'camera', 'weather', 'time',
  'time_pause', 'assists', 'telemetry', 'imagery', 'pause',
];

export class OptionsMenu {
  private root: HTMLElement;
  private visible = false;
  private listening: InputAction | null = null;
  private flat: Record<string, string>;
  onClose: (() => void) | null = null;
  onBindingsChanged: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    const s = loadSettings();
    this.flat = { ...flattenBindings(bindingsFromSettings(s.bindings)), ...(s.bindings || {}) };
    this.root = document.createElement('div');
    this.root.id = 'options-menu';
    this.root.className = 'overlay-menu hidden';
    parent.appendChild(this.root);
  }

  show(): void {
    this.visible = true;
    this.root.classList.remove('hidden');
    this.render();
  }
  hide(): void {
    this.visible = false;
    this.listening = null;
    this.root.classList.add('hidden');
  }
  isVisible(): boolean {
    return this.visible;
  }

  private render(): void {
    const s = loadSettings();
    this.root.innerHTML = `
      <div class="menu-card options-card">
        <h2>Options</h2>
        <p class="hint-line">Global — shared across all drivers. Xbox pad + keyboard defaults unchanged until you rebind.</p>

        <div class="section-label">Graphics</div>
        <div class="choice-row" id="opt-quality">
          ${(['low','medium','high'] as QualityLevel[]).map((q) => `
            <button type="button" class="choice ${s.quality===q?'selected':''}" data-quality="${q}"><strong>${q}</strong></button>`).join('')}
        </div>

        <div class="section-label">Units</div>
        <div class="choice-row">
          <button type="button" class="choice ${s.units.speed==='kmh'?'selected':''}" data-speed="kmh"><strong>km/h</strong></button>
          <button type="button" class="choice ${s.units.speed==='mph'?'selected':''}" data-speed="mph"><strong>mph</strong></button>
          <button type="button" class="choice ${s.units.temp==='c'?'selected':''}" data-temp="c"><strong>°C</strong></button>
          <button type="button" class="choice ${s.units.temp==='f'?'selected':''}" data-temp="f"><strong>°F</strong></button>
        </div>

        <div class="section-label">Audio (0–100)</div>
        <div class="choice-row" style="grid-template-columns:1fr">
          <label class="opt-slider">Master <input type="range" min="0" max="100" value="${Math.round(s.audio.master*100)}" data-audio="master"/></label>
          <label class="opt-slider">Engine <input type="range" min="0" max="100" value="${Math.round(s.audio.engine*100)}" data-audio="engine"/></label>
          <label class="opt-slider">UI <input type="range" min="0" max="100" value="${Math.round(s.audio.ui*100)}" data-audio="ui"/></label>
        </div>

        <div class="section-label">Key binds (click, then press a key)</div>
        <div class="choice-row variants pack-list" id="opt-binds">
          ${REBINDABLE.map((a) => {
            const code = this.flat[a] || DEFAULT_BINDINGS[a].keys[0];
            const listening = this.listening === a ? 'selected' : '';
            return `<button type="button" class="choice ${listening}" data-bind="${a}">
              <strong>${ACTION_LABELS[a]}</strong>
              <span>${this.listening===a ? 'Press a key…' : code}</span>
            </button>`;
          }).join('')}
        </div>
        <div class="choice-row">
          <button type="button" class="choice" id="opt-reset-binds"><strong>Reset binds</strong><span>Restore keyboard defaults</span></button>
          <button type="button" class="choice selected" id="opt-close"><strong>Done</strong><span>Save &amp; close</span></button>
        </div>
      </div>`;

    this.root.querySelectorAll('[data-quality]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const q = (btn as HTMLElement).dataset.quality as QualityLevel;
        saveQualityLevel(q);
        saveSettings({ quality: q });
        this.render();
      });
    });
    this.root.querySelectorAll('[data-speed]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const speed = (btn as HTMLElement).dataset.speed as 'kmh' | 'mph';
        saveSettings({ units: { ...loadSettings().units, speed } });
        this.render();
      });
    });
    this.root.querySelectorAll('[data-temp]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const temp = (btn as HTMLElement).dataset.temp as 'c' | 'f';
        saveSettings({ units: { ...loadSettings().units, temp } });
        this.render();
      });
    });
    this.root.querySelectorAll('[data-audio]').forEach((el) => {
      el.addEventListener('input', () => {
        const key = (el as HTMLInputElement).dataset.audio as 'master' | 'engine' | 'ui';
        const v = Number((el as HTMLInputElement).value) / 100;
        const audio = { ...loadSettings().audio, [key]: v };
        saveSettings({ audio });
      });
    });
    this.root.querySelectorAll('[data-bind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.listening = (btn as HTMLElement).dataset.bind as InputAction;
        this.render();
      });
    });
    this.root.querySelector('#opt-reset-binds')?.addEventListener('click', () => {
      this.flat = flattenBindings(structuredClone(DEFAULT_BINDINGS));
      saveSettings({ bindings: this.flat });
      this.onBindingsChanged?.();
      this.render();
    });
    this.root.querySelector('#opt-close')?.addEventListener('click', () => {
      saveSettings({ bindings: this.flat });
      this.onBindingsChanged?.();
      this.hide();
      this.onClose?.();
    });
  }

  /** Call from a capturing keydown while listening. */
  handleRebindKey(code: string): boolean {
    if (!this.listening) return false;
    if (code === 'Escape') {
      this.listening = null;
      this.render();
      return true;
    }
    this.flat[this.listening] = code;
    this.listening = null;
    saveSettings({ bindings: this.flat });
    this.onBindingsChanged?.();
    this.render();
    return true;
  }
}
