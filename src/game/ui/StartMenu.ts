import { CITIES } from '../cities';
import {
  BUS_VARIANT_IDS,
  GOLF_ENGINE_IDS,
  VEHICLE_SPECS,
  type VehicleId,
  type VehicleClass,
} from '../vehicles/Vehicle';
import type { TransmissionMode } from '../vehicles/Transmission';

export interface StartSelection {
  vehicle: VehicleId;
  cityId: string;
  transmission: TransmissionMode;
}

export class StartMenu {
  private root: HTMLElement;
  private vehicleClass: VehicleClass = 'golf';
  private vehicle: VehicleId = 'golf_20aba';
  private cityId = CITIES[0].id;
  private transmission: TransmissionMode = 'auto';
  private onStart: (sel: StartSelection) => void;

  constructor(parent: HTMLElement, onStart: (sel: StartSelection) => void) {
    this.onStart = onStart;
    this.root = document.createElement('div');
    this.root.id = 'menu';
    parent.appendChild(this.root);
    this.render();
  }

  private render(): void {
    const variantIds = this.vehicleClass === 'golf' ? GOLF_ENGINE_IDS : BUS_VARIANT_IDS;
    const variantLabel = this.vehicleClass === 'golf' ? 'Engine' : 'Powertrain';

    this.root.innerHTML = `
      <div class="menu-card">
        <h1>Nig Drives <span class="ver">v1.3.1a</span></h1>
        <p class="tagline">Gears · telemetry · minimap · street signs · slower day cycle · OSM roads.</p>

        <div class="section-label">Vehicle</div>
        <div class="choice-row" id="class-choices">
          <button type="button" class="choice ${this.vehicleClass === 'golf' ? 'selected' : ''}" data-class="golf">
            <strong>VW Golf</strong>
            <span>Hatchback · pick an engine below</span>
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
        <div class="choice-row" id="trans-choices">
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

        <button type="button" id="start-btn">Start driving</button>

        <p class="attribution">
          Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (Overpass).
          Elevation: AWS Open Data Terrarium DEM. Not affiliated with Google — no Google Maps/Earth road data.
          Vehicles are stylized; not affiliated with Volkswagen, New Flyer, or Grand River Transit.
        </p>
      </div>
    `;

    this.root.querySelectorAll('[data-class]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.vehicleClass = (btn as HTMLElement).dataset.class as VehicleClass;
        this.vehicle =
          this.vehicleClass === 'golf' ? 'golf_20aba' : 'bus_diesel';
        this.render();
      });
    });

    this.root.querySelectorAll('[data-vehicle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.vehicle = (btn as HTMLElement).dataset.vehicle as VehicleId;
        this.root.querySelectorAll('[data-vehicle]').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });

    this.root.querySelectorAll('[data-trans]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.transmission = (btn as HTMLElement).dataset.trans as TransmissionMode;
        this.root.querySelectorAll('[data-trans]').forEach((b) => b.classList.remove('selected'));
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
        transmission: this.transmission,
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
    default:
      return '';
  }
}
