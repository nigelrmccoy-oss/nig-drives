import { CITIES } from '../cities';
import type { VehicleId } from '../vehicles/Vehicle';

export interface StartSelection {
  vehicle: VehicleId;
  cityId: string;
}

export class StartMenu {
  private root: HTMLElement;
  private vehicle: VehicleId = 'golf';
  private cityId = CITIES[0].id;
  private onStart: (sel: StartSelection) => void;

  constructor(parent: HTMLElement, onStart: (sel: StartSelection) => void) {
    this.onStart = onStart;
    this.root = document.createElement('div');
    this.root.id = 'menu';
    parent.appendChild(this.root);
    this.render();
  }

  private render(): void {
    this.root.innerHTML = `
      <div class="menu-card">
        <h1>Nig Drives</h1>
        <p class="tagline">Drive a Golf or city bus on real OpenStreetMap roads across North America.</p>

        <div class="section-label">Vehicle</div>
        <div class="choice-row" id="vehicle-choices">
          <button type="button" class="choice selected" data-vehicle="golf">
            <strong>VW Golf</strong>
            <span>Agile hatchback · tighter turn · lower cam</span>
          </button>
          <button type="button" class="choice" data-vehicle="bus">
            <strong>City Bus</strong>
            <span>Heavy · slow accel · wide turn · high cam</span>
          </button>
        </div>

        <div class="section-label">Start city</div>
        <div class="choice-row cities" id="city-choices">
          ${CITIES.map(
            (c, i) => `
            <button type="button" class="choice ${i === 0 ? 'selected' : ''}" data-city="${c.id}">
              <strong>${c.name}</strong>
              <span>${c.region}</span>
            </button>`,
          ).join('')}
        </div>

        <button type="button" id="start-btn">Start driving</button>

        <p class="attribution">
          Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (Overpass).
          Elevation: AWS Open Data Terrarium DEM. Not affiliated with Google — no Google Maps/Earth road data.
        </p>
      </div>
    `;

    this.root.querySelectorAll('[data-vehicle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.vehicle = (btn as HTMLElement).dataset.vehicle as VehicleId;
        this.root.querySelectorAll('[data-vehicle]').forEach((b) => b.classList.remove('selected'));
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
      this.onStart({ vehicle: this.vehicle, cityId: this.cityId });
    });
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  show(): void {
    this.root.classList.remove('hidden');
  }
}
