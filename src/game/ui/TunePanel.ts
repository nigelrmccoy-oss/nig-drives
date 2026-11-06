/**
 * Sandbox tune sheet: GT-style stages, setup fields, PI badge, prices shown (not charged).
 * Engine swaps only from sourced donor catalogue ids.
 */
import { PARTS, displayPrice } from '../tuning/parts';
import { donorEngine, listEngineDonors } from '../tuning/donors';
import { ratePi, piBadge } from '../tuning/piRating';
import { physicsSpecFor } from '../physics/deriveSpec';
import { compileBuild } from '../tuning/compileBuild';
import { carBuildFromGarage } from '../tuning/CarBuild';
import { VEHICLE_SPECS, type VehicleId } from '../vehicles/Vehicle';
import { activeGarage, saveActiveGarage } from '../save/drivers';
import type { PartSlot } from '../save/types';

export class TunePanel {
  private root: HTMLElement;
  private visible = false;
  private modelId: VehicleId | null = null;
  onClose: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'tune-panel';
    this.root.className = 'overlay-menu hidden';
    parent.appendChild(this.root);
  }

  open(modelId: VehicleId): void {
    this.modelId = modelId;
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
    const id = this.modelId;
    if (!id) return;
    let garage = activeGarage();
    let car = garage.cars.find((c) => c.modelId === id);
    if (!car) {
      // should exist after start-menu persist; bail softly
      this.root.innerHTML = `<div class="menu-card"><p>No garage car for ${id}. Start once to seed it.</p>
        <button type="button" class="choice" id="tune-close"><strong>Close</strong></button></div>`;
      this.root.querySelector('#tune-close')?.addEventListener('click', () => {
        this.hide();
        this.onClose?.();
      });
      return;
    }
    const vs = VEHICLE_SPECS[id];
    const build = carBuildFromGarage(car);
    if (car.conversions?.engine) {
      const donor = donorEngine(car.conversions.engine);
      if (donor) build.donorEngine = donor;
    }
    const phys = compileBuild(physicsSpecFor(vs), build);
    const pi = ratePi(phys);
    const donors = listEngineDonors().filter((d) => d.modelId !== id).slice(0, 24);

    this.root.innerHTML = `
      <div class="menu-card options-card">
        <h2>Tune · ${vs.name}</h2>
        <p class="tagline">Class <strong>${piBadge(pi)}</strong> · ${pi.powerKw.toFixed(0)} kW · ${phys.chassis.mass.toFixed(0)} kg
          · susp ${phys.suspension.provenance}</p>
        <p class="hint-line">Prices shown for later career — nothing is charged in sandbox.</p>

        <div class="section-label">Upgrade stages</div>
        <div class="choice-row variants pack-list" id="tune-parts">
          ${PARTS.map((p) => {
            const cur = car!.parts[p.slot]?.stage ?? 0;
            const stages = [{ stage: 0, label: 'Stock', priceRel: 0 }, ...p.stages];
            return `<div class="tune-slot"><strong>${p.label}</strong>
              <div class="choice-row">${stages.map((st) => {
                const sel = cur === st.stage ? 'selected' : '';
                const price = st.stage === 0 ? '—' : `${displayPrice(st.priceRel)} cr`;
                return `<button type="button" class="choice ${sel}" data-slot="${p.slot}" data-stage="${st.stage}">
                  <strong>${st.label}</strong><span>${price}</span></button>`;
              }).join('')}</div></div>`;
          }).join('')}
        </div>

        <div class="section-label">Engine swap (sourced donors only)</div>
        <div class="choice-row variants pack-list">
          <button type="button" class="choice ${!car.conversions?.engine ? 'selected' : ''}" data-donor="">
            <strong>Stock engine</strong><span>—</span>
          </button>
          ${donors.map((d) => `
            <button type="button" class="choice ${car!.conversions?.engine===d.modelId?'selected':''}" data-donor="${d.modelId}">
              <strong>${d.label.slice(0, 48)}</strong><span>${d.drive.toUpperCase()}</span>
            </button>`).join('')}
        </div>

        <div class="section-label">Setup sheet</div>
        <div class="choice-row" style="grid-template-columns:1fr 1fr">
          <label class="opt-slider">Ride height mm
            <input type="number" id="setup-ride" value="${car.setup.rideHeightMm ?? phys.suspension.rideHeightMm}"/>
          </label>
          <label class="opt-slider">Brake bias % front
            <input type="number" id="setup-bias" value="${car.setup.brakeBiasFrontPct ?? 60}"/>
          </label>
          <label class="opt-slider">Spring F (N/m)
            <input type="number" id="setup-sf" value="${car.setup.springRateFront ?? phys.suspension.springFront}"/>
          </label>
          <label class="opt-slider">Spring R (N/m)
            <input type="number" id="setup-sr" value="${car.setup.springRateRear ?? phys.suspension.springRear}"/>
          </label>
        </div>

        <div class="choice-row">
          <button type="button" class="choice" id="tune-apply-setup"><strong>Apply setup</strong></button>
          <button type="button" class="choice selected" id="tune-close"><strong>Done</strong></button>
        </div>
      </div>`;

    this.root.querySelectorAll('[data-slot]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slot = (btn as HTMLElement).dataset.slot as PartSlot;
        const stage = Number((btn as HTMLElement).dataset.stage);
        garage = activeGarage();
        car = garage.cars.find((c) => c.modelId === id)!;
        const parts = { ...car.parts };
        if (stage <= 0) delete parts[slot];
        else parts[slot] = { stage };
        car = { ...car, parts, updatedAt: new Date().toISOString() };
        saveActiveGarage({
          ...garage,
          cars: garage.cars.map((c) => (c.id === car!.id ? car! : c)),
        });
        this.render();
      });
    });
    this.root.querySelectorAll('[data-donor]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const donor = (btn as HTMLElement).dataset.donor || '';
        garage = activeGarage();
        car = garage.cars.find((c) => c.modelId === id)!;
        const conversions = { ...car.conversions };
        if (!donor) delete conversions.engine;
        else conversions.engine = donor;
        car = { ...car, conversions, updatedAt: new Date().toISOString() };
        saveActiveGarage({
          ...garage,
          cars: garage.cars.map((c) => (c.id === car!.id ? car! : c)),
        });
        this.render();
      });
    });
    this.root.querySelector('#tune-apply-setup')?.addEventListener('click', () => {
      garage = activeGarage();
      car = garage.cars.find((c) => c.modelId === id)!;
      const ride = Number((this.root.querySelector('#setup-ride') as HTMLInputElement).value);
      const bias = Number((this.root.querySelector('#setup-bias') as HTMLInputElement).value);
      const sf = Number((this.root.querySelector('#setup-sf') as HTMLInputElement).value);
      const sr = Number((this.root.querySelector('#setup-sr') as HTMLInputElement).value);
      car = {
        ...car,
        setup: {
          ...car.setup,
          rideHeightMm: ride,
          brakeBiasFrontPct: bias,
          springRateFront: sf,
          springRateRear: sr,
        },
        updatedAt: new Date().toISOString(),
      };
      saveActiveGarage({
        ...garage,
        cars: garage.cars.map((c) => (c.id === car!.id ? car! : c)),
      });
      this.render();
    });
    this.root.querySelector('#tune-close')?.addEventListener('click', () => {
      this.hide();
      this.onClose?.();
    });
  }
}
