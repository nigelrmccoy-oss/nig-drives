import { WEATHER_LABELS, type WeatherPreset } from '../weather/Environment';

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
}

export class HUD {
  private root: HTMLElement;
  private speedEl: HTMLElement;
  private gearEl: HTMLElement;
  private vehicleEl: HTMLElement;
  private placeEl: HTMLElement;
  private statusEl: HTMLElement;
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

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="hud-panel">
          <div class="label">Vehicle</div>
          <div class="sub" id="hud-vehicle">—</div>
          <div class="sub" id="hud-assist"></div>
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
          <div class="telem-row"><span class="telem-k">Coolant</span><span id="telem-coolant">—</span></div>
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
          R weather · T time · P pause clock
        </div>
        <div class="status-toast" id="hud-status">Loading map…</div>
      </div>
      <div class="pause-banner" id="hud-paused" hidden>PAUSED</div>
      <div class="osm-badge">© OpenStreetMap · Overpass · Terrarium DEM (AWS) · v1.3.1d</div>
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

    this.weatherEl.addEventListener('click', () => this.onWeatherClick?.());
    this.timeEl.addEventListener('click', () => this.onTimeClick?.());
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

  setAssists(flags: { abs: boolean; tcs: boolean; slide: boolean }): void {
    const parts: string[] = [];
    if (flags.slide) parts.push('SLIDE');
    if (flags.abs) parts.push('ABS');
    if (flags.tcs) parts.push('TCS');
    this.assistEl.textContent = parts.join(' · ');
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
  }
}
