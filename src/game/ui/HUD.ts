import { WEATHER_LABELS, type WeatherPreset } from '../weather/Environment';
import { ASSIST_LABELS, type AssistPrefs } from './assistPrefs';

export interface TelemetryData {
  rpm: number;
  rpmNorm: number;
  gear: string;
  engineName: string;
  throttle: number;
  brake: number;
  boost: number;
  coolant: number;
  showBoost: boolean;
  /** v1.4.0: battery-electric readout (null for engine cars). */
  ev?: { powerKw: number; regenKw: number; soc: number } | null;
}

const ASSIST_KEYS = Object.keys(ASSIST_LABELS) as (keyof AssistPrefs)[];

export class HUD {
  private root: HTMLElement;
  private speedEl: HTMLElement;
  private gearEl: HTMLElement;
  private vehicleEl: HTMLElement;
  private placeEl: HTMLElement;
  private statusEl: HTMLElement;
  private fpsEl: HTMLElement;
  private camEl: HTMLElement;
  private weatherEl: HTMLElement;
  private timeEl: HTMLElement;
  private assistEl: HTMLElement;
  private surfaceEl: HTMLElement;
  private telemRpm: HTMLElement;
  private telemGear: HTMLElement;
  private telemEngine: HTMLElement;
  private telemPedals: HTMLElement;
  private telemBoost: HTMLElement;
  private telemCoolant: HTMLElement;
  private rpmBar: HTMLElement;
  private pauseBanner: HTMLElement;
  private onWeatherClick?: () => void;
  private onTimeClick?: () => void;
  private onAssistsChange?: (a: AssistPrefs) => void;
  private assistSwitches: AssistPrefs = { abs: true, tcs: true, stability: true };
  private assistPanel: HTMLElement;
  private assistBtn: HTMLElement;
  private lights: Record<keyof AssistPrefs, HTMLElement>;
  private telemPower: HTMLElement;
  private telemRegen: HTMLElement;
  private telemBattery: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="hud-panel">
          <div class="label">Vehicle</div>
          <div class="sub" id="hud-vehicle">—</div>
          <div class="assist-lights">
            ${ASSIST_KEYS.map((k) => `<span class="alight" data-light="${k}" title="${ASSIST_LABELS[k].hint}">${ASSIST_LABELS[k].short}</span>`).join('')}
            <span class="sub" id="hud-assist"></span>
          </div>
          <div class="sub" id="hud-surface">Surface: —</div>
        </div>
        <div class="hud-panel">
          <div class="label">Location</div>
          <div class="value loc" id="hud-place">—</div>
          <div class="sub" id="hud-cam">Camera: chase (C)</div>
        </div>
        <div class="hud-panel hud-interactive">
          <div class="label">Environment</div>
          <button type="button" class="hud-btn" id="hud-weather">Weather: Clear / dry (R)</button>
          <button type="button" class="hud-btn" id="hud-time">Time: Day (T)</button>
          <button type="button" class="hud-btn" id="hud-assists">Assists ▾</button>
          <div class="assist-panel" id="hud-assist-panel" hidden>
            ${ASSIST_KEYS.map((k) => `<button type="button" class="hud-btn assist-toggle" data-assist-toggle="${k}">${ASSIST_LABELS[k].name}: On</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="speedo-cluster">
        <div class="telemetry" id="hud-telemetry">
          <div class="telem-row"><span class="telem-k">RPM</span><span id="telem-rpm">800</span></div>
          <div class="rpm-bar"><div class="rpm-fill" id="rpm-fill"></div></div>
          <div class="telem-row"><span class="telem-k">Gear</span><span id="telem-gear">D1</span></div>
          <div class="telem-row"><span class="telem-k">Engine</span><span id="telem-engine">—</span></div>
          <div class="telem-row"><span class="telem-k">T / B</span><span id="telem-pedals">0% / 0%</span></div>
          <div class="telem-row telem-boost"><span class="telem-k">Boost</span><span id="telem-boost">—</span></div>
          <div class="telem-row telem-ice"><span class="telem-k">Coolant</span><span id="telem-coolant">—</span></div>
          <div class="telem-row telem-ev"><span class="telem-k">Power</span><span id="telem-power">—</span></div>
          <div class="telem-row telem-ev"><span class="telem-k">Regen</span><span id="telem-regen">—</span></div>
          <div class="telem-row telem-ev"><span class="telem-k">Battery</span><span id="telem-battery">—</span></div>
        </div>
        <div class="speedo">
          <div class="speedo-gear" id="hud-gear">D</div>
          <div class="speedo-value" id="hud-speed">0</div>
          <div class="speedo-unit">km/h</div>
        </div>
      </div>
      <div class="hud-bottom">
        <div class="controls-hint">
          W/↑ accel · S/↓ brake/reverse · A/D steer · Space brake · C camera<br/>
          G auto P-R-N-D · Q/E shift · 1–6/N/B H-pattern · Shift clutch<br/>
          R weather · T time · P pause clock · F1 assists on/off · F2 Telemetry+<br/>
          Gamepad: stick steer · RT/LT throttle/brake · LB/RB shift · B reverse · X clutch · Y camera
        </div>
        <div class="status-toast" id="hud-status">Loading map…</div>
      </div>
      <div class="pause-banner" id="hud-paused" hidden>PAUSED</div>
      <div class="fps-counter" id="hud-fps">— FPS</div>
      <div class="osm-badge">© OpenStreetMap · Overpass · Terrarium DEM (AWS) · textures CC0 Poly Haven · ambientCG · v1.4.2</div>
    `;
    parent.appendChild(this.root);
    this.speedEl = this.root.querySelector('#hud-speed')!;
    this.gearEl = this.root.querySelector('#hud-gear')!;
    this.vehicleEl = this.root.querySelector('#hud-vehicle')!;
    this.placeEl = this.root.querySelector('#hud-place')!;
    this.statusEl = this.root.querySelector('#hud-status')!;
    this.camEl = this.root.querySelector('#hud-cam')!;
    this.weatherEl = this.root.querySelector('#hud-weather')!;
    this.timeEl = this.root.querySelector('#hud-time')!;
    this.assistEl = this.root.querySelector('#hud-assist')!;
    this.surfaceEl = this.root.querySelector('#hud-surface')!;
    this.telemRpm = this.root.querySelector('#telem-rpm')!;
    this.telemGear = this.root.querySelector('#telem-gear')!;
    this.telemEngine = this.root.querySelector('#telem-engine')!;
    this.telemPedals = this.root.querySelector('#telem-pedals')!;
    this.telemBoost = this.root.querySelector('#telem-boost')!;
    this.telemCoolant = this.root.querySelector('#telem-coolant')!;
    this.rpmBar = this.root.querySelector('#rpm-fill')!;
    this.pauseBanner = this.root.querySelector('#hud-paused')!;
    this.fpsEl = this.root.querySelector('#hud-fps')!;

    this.telemPower = this.root.querySelector('#telem-power')!;
    this.telemRegen = this.root.querySelector('#telem-regen')!;
    this.telemBattery = this.root.querySelector('#telem-battery')!;
    this.assistPanel = this.root.querySelector('#hud-assist-panel')!;
    this.assistBtn = this.root.querySelector('#hud-assists')!;
    this.lights = {
      abs: this.root.querySelector('[data-light="abs"]')!,
      tcs: this.root.querySelector('[data-light="tcs"]')!,
      stability: this.root.querySelector('[data-light="stability"]')!,
    };

    this.weatherEl.addEventListener('click', () => this.onWeatherClick?.());
    this.timeEl.addEventListener('click', () => this.onTimeClick?.());
    this.assistBtn.addEventListener('click', () => this.toggleAssistPanel());
    this.root.querySelectorAll<HTMLElement>('[data-assist-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.assistToggle as keyof AssistPrefs;
        this.setAssistSwitches({ ...this.assistSwitches, [k]: !this.assistSwitches[k] });
        this.onAssistsChange?.({ ...this.assistSwitches });
      });
    });
  }

  /** v1.4.0: called when the driver flips an assist in the HUD panel. */
  setAssistHandler(cb: (a: AssistPrefs) => void): void {
    this.onAssistsChange = cb;
  }

  toggleAssistPanel(): void {
    this.assistPanel.hidden = !this.assistPanel.hidden;
    this.assistBtn.classList.toggle('active', !this.assistPanel.hidden);
  }

  /** Show which assists are switched on (panel buttons + dimmed / struck-out lights). */
  setAssistSwitches(a: AssistPrefs): void {
    this.assistSwitches = { ...a };
    for (const k of ASSIST_KEYS) {
      this.lights[k].classList.toggle('off', !a[k]);
      this.lights[k].title = `${ASSIST_LABELS[k].hint}: ${a[k] ? 'on' : 'OFF'}`;
      const btn = this.assistPanel.querySelector<HTMLElement>(`[data-assist-toggle="${k}"]`)!;
      btn.textContent = `${ASSIST_LABELS[k].name}: ${a[k] ? 'On' : 'Off'}`;
      btn.classList.toggle('active', a[k]);
    }
    const off = ASSIST_KEYS.filter((k) => !a[k]).map((k) => ASSIST_LABELS[k].short);
    this.assistBtn.textContent = off.length ? `Assists ▾ ${off.join(' · ')} off (F1 all on)` : 'Assists ▾ all on (F1 all off)';
  }

  setEnvHandlers(onWeather: () => void, onTime: () => void): void {
    this.onWeatherClick = onWeather;
    this.onTimeClick = onTime;
  }

  show(): void {
    this.root.classList.add('visible');
  }

  hide(): void {
    this.root.classList.remove('visible');
  }

  setVehicleName(name: string): void {
    this.vehicleEl.textContent = name;
  }

  setPlace(city: string, region: string): void {
    this.placeEl.textContent = city;
    this.placeEl.title = region;
  }

  setSpeed(kmh: number): void {
    const v = Number.isFinite(kmh) ? Math.round(kmh) : 0;
    this.speedEl.textContent = `${v}`;
  }

  setSurface(label: string, grip: number): void {
    const g = Number.isFinite(grip) ? Math.round(grip * 100) : 0;
    this.surfaceEl.textContent = `Surface: ${label} · grip ${g}%`;
  }

  setFps(fps: number, qualityLabel: string): void {
    const v = Number.isFinite(fps) ? Math.round(fps) : 0;
    this.fpsEl.textContent = `${v} FPS · ${qualityLabel}`;
    this.fpsEl.classList.toggle('low', v < 45);
  }

  setStatus(msg: string): void {
    this.statusEl.textContent = msg;
  }

  setCameraMode(mode: string): void {
    this.camEl.textContent = `Camera: ${mode} (C)`;
  }

  setWeather(w: WeatherPreset): void {
    this.weatherEl.textContent = `Weather: ${WEATHER_LABELS[w]} (R)`;
  }

  setTime(label: string, paused: boolean, dayMin?: number): void {
    const day = dayMin !== undefined ? ` · ${dayMin}m day` : '';
    this.timeEl.textContent = `Time: ${label}${paused ? ' ⏸ PAUSED' : ''}${day} (T/P)`;
    this.pauseBanner.hidden = !paused;
    this.pauseBanner.classList.toggle('visible', paused);
  }

  /** Lights flash while an assist is working; stability control has its own (STM) light. */
  setAssists(flags: { abs: boolean; tcs: boolean; esc: boolean; slide: boolean }): void {
    this.lights.abs.classList.toggle('on', flags.abs);
    this.lights.tcs.classList.toggle('on', flags.tcs);
    this.lights.stability.classList.toggle('on', flags.esc);
    this.assistEl.textContent = flags.slide ? 'SLIDE' : '';
  }

  setTelemetry(t: TelemetryData): void {
    this.gearEl.textContent = t.gear;
    this.telemRpm.textContent = `${t.rpm}`;
    this.telemGear.textContent = t.gear;
    this.telemEngine.textContent = t.engineName;
    this.telemPedals.textContent = `${Math.round(t.throttle * 100)}% / ${Math.round(t.brake * 100)}%`;
    this.rpmBar.style.width = `${Math.round(t.rpmNorm * 100)}%`;
    this.rpmBar.classList.toggle('hot', t.rpmNorm > 0.85);
    if (t.showBoost) {
      this.telemBoost.textContent = `${Math.round(t.boost * 100)}%`;
      (this.telemBoost.parentElement as HTMLElement).style.display = '';
    } else {
      this.telemBoost.textContent = '—';
      (this.telemBoost.parentElement as HTMLElement).style.display = 'none';
    }
    this.telemCoolant.textContent = `${Math.round(t.coolant * 100)}%`;
    const ev = t.ev ?? null;
    this.root.classList.toggle('is-ev', ev !== null);
    if (ev) {
      this.telemPower.textContent = `${Math.round(ev.powerKw)} kW`;
      this.telemRegen.textContent = ev.regenKw > 0.5 ? `${Math.round(ev.regenKw)} kW` : '—';
      this.telemBattery.textContent = `${(ev.soc * 100).toFixed(1)}%`;
    }
  }
}
