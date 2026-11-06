import { loadSettings, saveSettings } from '../save/settings';
import {
  ACTION_LABELS,
  DEFAULT_BINDINGS,
  flattenBindings,
  bindingsFromSettings,
  type InputAction,
} from '../input/bindings';
import {
  PAD_ACTIONS,
  PAD_ACTION_LABELS,
  DEFAULT_PAD_BINDINGS,
  assignPadBinding,
  padActionAcceptsButton,
  padBindingsFromSettings,
  padCapture,
  padInputLabel,
  type PadAction,
  type PadBindingsMap,
  type PadInput,
} from '../input/padBindings';
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
  /** v1.5.0c gamepad rebinding state. */
  private padMap: PadBindingsMap;
  private padListening: PadAction | null = null;
  private padPhase: 'listen' | 'release' = 'listen';
  private padBase: { axes: number[]; buttons: boolean[] } | null = null;
  private padRaf = 0;
  private padReleaseUntil = 0;
  private padNote = '';
  onClose: (() => void) | null = null;
  onBindingsChanged: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    const s = loadSettings();
    this.flat = { ...flattenBindings(bindingsFromSettings(s.bindings)), ...(s.bindings || {}) };
    this.padMap = padBindingsFromSettings(s.padBindings);
    this.root = document.createElement('div');
    this.root.id = 'options-menu';
    this.root.className = 'overlay-menu hidden';
    parent.appendChild(this.root);
  }

  show(): void {
    this.visible = true;
    this.padMap = padBindingsFromSettings(loadSettings().padBindings);
    this.padNote = '';
    this.root.classList.remove('hidden');
    this.render();
  }
  hide(): void {
    this.visible = false;
    this.listening = null;
    this.stopPadListen();
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
        </div>

        <div class="section-label">Gamepad binds (click, then press a button or move a stick / trigger)</div>
        <p class="hint-line" id="opt-pad-status">${this.padStatusLine()}</p>
        <div class="choice-row variants pack-list" id="opt-pad-binds">
          ${PAD_ACTIONS.map((a) => {
            const on = this.padListening === a;
            const prompt = a === 'steer' ? 'Push the stick LEFT…' : 'Press a button / move an axis…';
            return `<button type="button" class="choice ${on ? 'selected' : ''}" data-padbind="${a}">
              <strong>${PAD_ACTION_LABELS[a]}</strong>
              <span>${on ? prompt : padInputLabel(this.padMap[a], a)}</span>
            </button>`;
          }).join('')}
        </div>
        <div class="choice-row">
          <button type="button" class="choice" id="opt-reset-pad"><strong>Reset gamepad</strong><span>Restore Xbox standard layout</span></button>
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
    this.root.querySelectorAll('[data-padbind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = (btn as HTMLElement).dataset.padbind as PadAction;
        if (this.padListening === a) this.stopPadListen();
        else this.startPadListen(a);
        this.render();
      });
    });
    this.root.querySelector('#opt-reset-pad')?.addEventListener('click', () => {
      this.stopPadListen();
      this.padMap = structuredClone(DEFAULT_PAD_BINDINGS);
      saveSettings({ padBindings: undefined });
      this.padNote = 'Gamepad reset to the Xbox standard layout.';
      this.onBindingsChanged?.();
      this.render();
    });
    this.root.querySelectorAll('[data-bind]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.stopPadListen();
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
    if (this.padListening && this.padPhase === 'listen' && code === 'Escape') {
      this.stopPadListen();
      this.render();
      return true;
    }
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

  private padStatusLine(): string {
    const pad = firstPad();
    const who = pad ? `Pad: ${escapeHtml(pad.id.slice(0, 60))}${pad.mapping === 'standard' ? '' : ' (non-standard mapping)'}` : 'No gamepad detected — press any pad button to wake it.';
    return `${who}${this.padNote ? ' · ' + escapeHtml(this.padNote) : ''} · Global, all drivers. Esc cancels.`;
  }

  private startPadListen(a: PadAction): void {
    this.listening = null;
    this.padListening = a;
    this.padPhase = 'listen';
    this.padBase = null;
    this.padNote = '';
    padCapture.active = true;
    cancelAnimationFrame(this.padRaf);
    this.padRaf = requestAnimationFrame(this.padFrame);
  }

  private stopPadListen(): void {
    this.padListening = null;
    this.padPhase = 'listen';
    this.padBase = null;
    padCapture.active = false;
    cancelAnimationFrame(this.padRaf);
    this.padRaf = 0;
  }

  private snapshot(pad: Gamepad): { axes: number[]; buttons: boolean[] } {
    return { axes: [...pad.axes], buttons: pad.buttons.map((b) => b.pressed || b.value > 0.5) };
  }

  /** Capture loop: only runs while a pad row is listening (or waiting for the captured input to be let go). */
  private padFrame = (): void => {
    const pad = firstPad();
    const now = performance.now();
    if (this.padPhase === 'release') {
      const base = this.padBase;
      const settled =
        !pad || !base ||
        (pad.buttons.every((b, i) => !(b.pressed || b.value > 0.5) || base.buttons[i]) &&
          pad.axes.every((v, i) => Math.abs(v - (base.axes[i] ?? 0)) < 0.25));
      if (settled || now > this.padReleaseUntil) {
        this.stopPadListen();
        return;
      }
      this.padRaf = requestAnimationFrame(this.padFrame);
      return;
    }
    const action = this.padListening;
    if (!action) return this.stopPadListen();
    if (!pad) {
      this.padRaf = requestAnimationFrame(this.padFrame);
      return;
    }
    if (!this.padBase) {
      this.padBase = this.snapshot(pad);
      this.padRaf = requestAnimationFrame(this.padFrame);
      return;
    }
    const base = this.padBase;
    let got: PadInput | null = null;
    if (padActionAcceptsButton(action)) {
      for (let i = 0; i < pad.buttons.length; i++) {
        const b = pad.buttons[i];
        if ((b.pressed || b.value > 0.5) && !base.buttons[i]) {
          got = { kind: 'button', index: i };
          break;
        }
      }
    }
    if (!got) {
      for (let i = 0; i < pad.axes.length; i++) {
        const d = pad.axes[i] - (base.axes[i] ?? 0);
        if (Math.abs(d) > 0.5) {
          const dir: 1 | -1 = d > 0 ? 1 : -1;
          const full = action !== 'steer' && Math.abs(base.axes[i] ?? 0) > 0.8 && Math.sign(base.axes[i]) === -dir;
          got = full ? { kind: 'axis', index: i, dir, full: true } : { kind: 'axis', index: i, dir };
          break;
        }
      }
    }
    if (!got) {
      this.padRaf = requestAnimationFrame(this.padFrame);
      return;
    }
    const cleared = assignPadBinding(this.padMap, action, got);
    saveSettings({ padBindings: { ...this.padMap } });
    this.padNote = cleared.length
      ? `${PAD_ACTION_LABELS[action]} → ${padInputLabel(got, action)}; cleared ${cleared.map((c) => PAD_ACTION_LABELS[c]).join(', ')} (was on the same input)`
      : `${PAD_ACTION_LABELS[action]} → ${padInputLabel(got, action)}`;
    this.onBindingsChanged?.();
    // Keep the game's pad reader muted until the captured control is let go, so it doesn't fire on resume.
    this.padListening = null;
    this.padPhase = 'release';
    this.padReleaseUntil = now + 2000;
    this.render();
    this.padRaf = requestAnimationFrame(this.padFrame);
  };
}

function firstPad(): Gamepad | null {
  const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) if (p && p.connected) return p;
  return null;
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
