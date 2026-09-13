import { WEATHER_LABELS, type WeatherPreset } from '../weather/Environment';

export class HUD {
  private root: HTMLElement;
  private speedEl: HTMLElement;
  private vehicleEl: HTMLElement;
  private placeEl: HTMLElement;
  private statusEl: HTMLElement;
  private camEl: HTMLElement;
  private weatherEl: HTMLElement;
  private timeEl: HTMLElement;
  private assistEl: HTMLElement;
  private onWeatherClick?: () => void;
  private onTimeClick?: () => void;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="hud-panel">
          <div class="label">Speed</div>
          <div class="value" id="hud-speed">0 km/h</div>
          <div class="sub" id="hud-vehicle">—</div>
          <div class="sub" id="hud-assist"></div>
        </div>
        <div class="hud-panel">
          <div class="label">Location</div>
          <div class="value" id="hud-place" style="font-size:1rem">—</div>
          <div class="sub" id="hud-cam">Camera: chase (C)</div>
        </div>
        <div class="hud-panel hud-interactive">
          <div class="label">Environment</div>
          <button type="button" class="hud-btn" id="hud-weather">Weather: Clear / dry (R)</button>
          <button type="button" class="hud-btn" id="hud-time">Time: Day (T)</button>
        </div>
      </div>
      <div class="hud-bottom">
        <div class="controls-hint">
          <strong>Controls</strong><br/>
          W/↑ accel · S/↓ reverse · A/D steer · Space brake · C camera<br/>
          R cycle weather (clear/rain/snow) · T time of day · P pause clock
        </div>
        <div class="status-toast" id="hud-status">Loading map…</div>
      </div>
      <div class="osm-badge">© OpenStreetMap · Overpass · Terrarium DEM (AWS)</div>
    `;
    parent.appendChild(this.root);
    this.speedEl = this.root.querySelector('#hud-speed')!;
    this.vehicleEl = this.root.querySelector('#hud-vehicle')!;
    this.placeEl = this.root.querySelector('#hud-place')!;
    this.statusEl = this.root.querySelector('#hud-status')!;
    this.camEl = this.root.querySelector('#hud-cam')!;
    this.weatherEl = this.root.querySelector('#hud-weather')!;
    this.timeEl = this.root.querySelector('#hud-time')!;
    this.assistEl = this.root.querySelector('#hud-assist')!;

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
    this.speedEl.textContent = `${Math.round(kmh)} km/h`;
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

  setTime(label: string, paused: boolean): void {
    this.timeEl.textContent = `Time: ${label}${paused ? ' ⏸' : ''} (T/P)`;
  }

  setAssists(flags: { abs: boolean; tcs: boolean; slide: boolean }): void {
    const parts: string[] = [];
    if (flags.slide) parts.push('SLIDE');
    if (flags.abs) parts.push('ABS');
    if (flags.tcs) parts.push('TCS');
    this.assistEl.textContent = parts.join(' · ');
  }
}
