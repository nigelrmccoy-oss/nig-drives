import { CITIES } from '../cities';
import {
  BUS_VARIANT_IDS,
  EV_VARIANT_IDS,
  GOLF_ENGINE_IDS,
  VEHICLE_SPECS,
  type VehicleId,
  type VehicleClass,
} from '../vehicles/Vehicle';
import type { TransmissionMode } from '../vehicles/Transmission';
import { QUALITY, loadQualityLevel, saveQualityLevel, type QualityLevel } from '../visuals/Quality';
import { ASSIST_LABELS, loadAssistPrefs, saveAssistPrefs, type AssistPrefs } from './assistPrefs';
import { openDyno } from './Dyno';
import { MODEL3_LR_AWD } from '../physics/specs/model3LrAwd';

export interface StartSelection {
  vehicle: VehicleId;
  cityId: string;
  transmission: TransmissionMode;
  quality: QualityLevel;
  /** v1.4.0: ABS / TCS / stability switches. */
  assists: AssistPrefs;
}

const CLASS_VARIANTS: Record<VehicleClass, { ids: VehicleId[]; label: string; first: VehicleId }> = {
  golf: { ids: GOLF_ENGINE_IDS, label: 'Engine', first: 'golf_20aba' },
  ev: { ids: EV_VARIANT_IDS, label: 'Motor', first: 'model3_lr_awd' },
  bus: { ids: BUS_VARIANT_IDS, label: 'Powertrain', first: 'bus_diesel' },
};

export class StartMenu {
  private root: HTMLElement;
  private vehicleClass: VehicleClass = 'golf';
  private vehicle: VehicleId = 'golf_20aba';
  private cityId = CITIES[0].id;
  private transmission: TransmissionMode = 'auto';
  private quality: QualityLevel = loadQualityLevel();
  private assists: AssistPrefs = loadAssistPrefs();
  private onStart: (sel: StartSelection) => void;

  constructor(parent: HTMLElement, onStart: (sel: StartSelection) => void) {
    this.onStart = onStart;
    this.root = document.createElement('div');
    this.root.id = 'menu';
    parent.appendChild(this.root);
    this.render();
  }

  private render(): void {
    const variantIds = CLASS_VARIANTS[this.vehicleClass].ids;
    const variantLabel = CLASS_VARIANTS[this.vehicleClass].label;
    const ev = this.vehicleClass === 'ev';

    this.root.innerHTML = `
      <div class="menu-card">
        <h1>Nig Drives <span class="ver">v1.4.0</span></h1>
        <p class="tagline">v1.4.0: real tyre &amp; drivetrain physics · Tesla Model 3 · assists you can switch off · Telemetry+ (F2) · Dyno.</p>

        <div class="section-label">Vehicle</div>
        <div class="choice-row" id="class-choices">
          <button type="button" class="choice ${this.vehicleClass === 'golf' ? 'selected' : ''}" data-class="golf">
            <strong>VW Golf</strong>
            <span>Hatchback · pick an engine below</span>
          </button>
          <button type="button" class="choice ${ev ? 'selected' : ''}" data-class="ev">
            <strong>Tesla Model 3</strong>
            <span>Electric · dual motor · 0–100 in 4.4 s</span>
          </button>
          <button type="button" class="choice ${this.vehicleClass === 'bus' ? 'selected' : ''}" data-class="bus">
            <strong>City Bus</strong>
            <span>New Flyer style · diesel or hybrid</span>
          </button>
        </div>

        <div class="section-label">${variantLabel}</div>
        <div class="choice-row variants" id="variant-choices">
          ${variantIds
            .map((id) => {
              const s = VEHICLE_SPECS[id];
              const selected = id === this.vehicle ? 'selected' : '';
              return `
            <button type="button" class="choice ${selected}" data-vehicle="${id}">
              <strong>${s.variantLabel}</strong>
              <span>${variantHint(id)}</span>
            </button>`;
            })
            .join('')}
        </div>

        <div class="section-label">Transmission</div>
        ${
          ev
            ? `<div class="choice-row" id="trans-choices">
          <button type="button" class="choice selected" disabled>
            <strong>Single-speed</strong>
            <span>9.03:1 reduction · no gears · G cycles P/R/N/D</span>
          </button>
        </div>`
            : `<div class="choice-row" id="trans-choices">
          <button type="button" class="choice ${this.transmission === 'auto' ? 'selected' : ''}" data-trans="auto">
            <strong>Auto</strong>
            <span>P/R/N/D · G cycles · shift points</span>
          </button>
          <button type="button" class="choice ${this.transmission === 'stick_seq' ? 'selected' : ''}" data-trans="stick_seq">
            <strong>Stick · Sequential</strong>
            <span>Q/E · 1–5/6 + R · clutch optional</span>
          </button>
          <button type="button" class="choice ${this.transmission === 'stick_h' ? 'selected' : ''}" data-trans="stick_h">
            <strong>Stick · H-pattern</strong>
            <span>1–6 / N / B=R · Q/E also</span>
          </button>
        </div>`
        }

        <div class="section-label">Assists</div>
        <div class="choice-row" id="assist-choices">
          ${(Object.keys(ASSIST_LABELS) as (keyof AssistPrefs)[])
            .map(
              (k) => `
            <button type="button" class="choice toggle ${this.assists[k] ? 'selected' : ''}" data-assist="${k}" aria-pressed="${this.assists[k]}">
              <strong>${ASSIST_LABELS[k].name}: ${this.assists[k] ? 'On' : 'Off'}</strong>
              <span>${ASSIST_LABELS[k].hint}</span>
            </button>`,
            )
            .join('')}
        </div>

        <div class="section-label">Graphics</div>
        <div class="choice-row" id="quality-choices">
          ${(['low', 'medium', 'high'] as QualityLevel[])
            .map(
              (q) => `
            <button type="button" class="choice ${q === this.quality ? 'selected' : ''}" data-quality="${q}">
              <strong>${QUALITY[q].label}</strong>
              <span>${qualityHint(q)}</span>
            </button>`,
            )
            .join('')}
        </div>

        <div class="section-label">Start city</div>
        <div class="choice-row cities" id="city-choices">
          ${CITIES.map(
            (c) => `
            <button type="button" class="choice ${c.id === this.cityId ? 'selected' : ''}" data-city="${c.id}">
              <strong>${c.name}</strong>
              <span>${c.region}</span>
            </button>`,
          ).join('')}
        </div>

        <div class="menu-actions">
          <button type="button" id="start-btn">Start driving</button>
          <button type="button" id="dyno-btn" class="secondary-btn">Dyno: ${VEHICLE_SPECS[this.vehicle].variantLabel}</button>
        </div>

        <p class="attribution">
          Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (Overpass).
          Elevation: AWS Open Data Terrarium DEM. Not affiliated with Google — no Google Maps/Earth road data.
          Vehicles are stylized; not affiliated with Volkswagen, Tesla, New Flyer, or Grand River Transit.
        </p>
      </div>
    `;

    this.root.querySelectorAll('[data-class]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.vehicleClass = (btn as HTMLElement).dataset.class as VehicleClass;
        this.vehicle = CLASS_VARIANTS[this.vehicleClass].first;
        this.render();
      });
    });

    this.root.querySelectorAll('[data-vehicle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.vehicle = (btn as HTMLElement).dataset.vehicle as VehicleId;
        this.root.querySelectorAll('[data-vehicle]').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.root.querySelector('#dyno-btn')!.textContent = `Dyno: ${VEHICLE_SPECS[this.vehicle].variantLabel}`;
      });
    });

    this.root.querySelectorAll('[data-assist]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = (btn as HTMLElement).dataset.assist as keyof AssistPrefs;
        this.assists = { ...this.assists, [k]: !this.assists[k] };
        saveAssistPrefs(this.assists);
        btn.classList.toggle('selected', this.assists[k]);
        btn.setAttribute('aria-pressed', String(this.assists[k]));
        btn.querySelector('strong')!.textContent = `${ASSIST_LABELS[k].name}: ${this.assists[k] ? 'On' : 'Off'}`;
      });
    });

    this.root.querySelector('#dyno-btn')!.addEventListener('click', () => {
      openDyno(this.root, this.vehicle);
    });

    this.root.querySelectorAll('[data-trans]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.transmission = (btn as HTMLElement).dataset.trans as TransmissionMode;
        this.root.querySelectorAll('[data-trans]').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    this.root.querySelectorAll('[data-quality]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.quality = (btn as HTMLElement).dataset.quality as QualityLevel;
        saveQualityLevel(this.quality);
        this.root.querySelectorAll('[data-quality]').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    this.root.querySelectorAll('[data-city]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.cityId = (btn as HTMLElement).dataset.city!;
        this.root.querySelectorAll('[data-city]').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    this.root.querySelector('#start-btn')!.addEventListener('click', () => {
      this.onStart({
        vehicle: this.vehicle,
        cityId: this.cityId,
        transmission: this.vehicleClass === 'ev' ? 'auto' : this.transmission,
        quality: this.quality,
        assists: { ...this.assists },
      });
    });
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  show(): void {
    this.root.classList.remove('hidden');
  }
}

function variantHint(id: VehicleId): string {
  switch (id) {
    case 'golf_18carb':
      return 'Light · mild · soft top end';
    case 'golf_20aba':
      return 'Balanced classic 8V feel';
    case 'golf_19tdi':
      return 'Low-end torque · diesel note';
    case 'golf_28vr6':
      return 'Strong · heavier · higher pitch';
    case 'bus_diesel':
      return 'Heavy · low growl · stack';
    case 'bus_hybrid':
      return 'Lighter · regen brake · roof pack';
    case 'model3_lr_awd':
      return `${Math.round(MODEL3_LR_AWD.ev!.systemPowerW / 1000)} kW · front + rear motors · one-pedal regen`; // v1.4.1: from the sim spec
    default:
      return '';
  }
}

function qualityHint(q: QualityLevel): string {
  switch (q) {
    case 'low':
      return 'Older iGPUs · 1.0× res · no normal maps';
    case 'medium':
      return 'Default · laptop iGPU · 1.25× res';
    case 'high':
      return 'Discrete GPU · 1.5× res · 1K splat';
  }
}
