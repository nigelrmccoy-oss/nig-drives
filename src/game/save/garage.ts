import type { CompoundId, GarageCar, GarageDoc, GlobalSettings } from './types';
import { newId, nowIso, readVersioned, sanitizeName, writeVersioned } from './storage';

export const GARAGE_SCHEMA = 1;
export const MAX_GARAGE_CARS = 1000;

/** Stock catalogue ids seeded into every new driver garage. */
export const STARTER_MODEL_IDS = [
  'golf_18carb',
  'golf_20aba',
  'golf_19tdi',
  'golf_28vr6',
  'bus_diesel',
  'bus_hybrid',
  'model3_lr_awd',
] as const;

const DEFAULT_PAINT: Record<string, string> = {
  golf_18carb: '#2f5a2f',
  golf_20aba: '#1f4a7a',
  golf_19tdi: '#3a3a3a',
  golf_28vr6: '#7a1f1f',
  bus_diesel: '#c9a36a',
  bus_hybrid: '#1a5a5a',
  model3_lr_awd: '#d0d4d8',
};

export function garageKeyForDriver(driverId: string): string {
  return `nigdrives.driver.${driverId}.garage.v1`;
}

export function garageBakForDriver(driverId: string): string {
  return `nigdrives.driver.${driverId}.garage.bak`;
}

export function stockGarageCar(
  modelId: string,
  assists: GlobalSettings['assistsDefault'],
  nickname?: string,
): GarageCar {
  const t = nowIso();
  return {
    id: newId('car'),
    modelId,
    modelRev: 1,
    nickname: sanitizeName(nickname ?? defaultNickname(modelId)),
    createdAt: t,
    updatedAt: t,
    paint: {
      body: DEFAULT_PAINT[modelId] ?? '#2a3344',
      finish: 'gloss',
    },
    tyres: { front: 'all_season' as CompoundId, rear: 'all_season' as CompoundId },
    parts: {},
    setup: {},
    assists: { ...assists },
    transmission: modelId.startsWith('model3') ? 'auto' : 'auto',
    origin: 'sandbox',
  };
}

function defaultNickname(modelId: string): string {
  const map: Record<string, string> = {
    golf_18carb: 'Golf 1.8',
    golf_20aba: 'Golf 2.0 ABA',
    golf_19tdi: 'Golf 1.9 TDI',
    golf_28vr6: 'Golf VR6',
    bus_diesel: 'City Bus',
    bus_hybrid: 'Hybrid Bus',
    model3_lr_awd: 'Model 3 LR',
  };
  return map[modelId] ?? modelId;
}

export function seedGarage(assists: GlobalSettings['assistsDefault']): GarageDoc {
  const cars = STARTER_MODEL_IDS.map((id) => stockGarageCar(id, assists));
  return {
    schema: GARAGE_SCHEMA,
    app: 'nig-drives',
    gameVersion: '1.6.0',
    updatedAt: nowIso(),
    activeId: cars[1]?.id ?? cars[0]?.id ?? null, // ABA default
    cars,
  };
}

function migrateGarage(raw: unknown, _from: number): GarageDoc {
  const empty: GarageDoc = {
    schema: GARAGE_SCHEMA,
    app: 'nig-drives',
    gameVersion: '1.6.0',
    updatedAt: nowIso(),
    activeId: null,
    cars: [],
  };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Partial<GarageDoc>;
  const cars = Array.isArray(r.cars) ? r.cars.map(clampCar).filter(Boolean) as GarageCar[] : [];
  let activeId = typeof r.activeId === 'string' ? r.activeId : null;
  if (activeId && !cars.some((c) => c.id === activeId)) activeId = cars[0]?.id ?? null;
  return {
    schema: GARAGE_SCHEMA,
    app: 'nig-drives',
    gameVersion: typeof r.gameVersion === 'string' ? r.gameVersion : '1.5.0-b',
    updatedAt: nowIso(),
    activeId,
    cars: cars.slice(0, MAX_GARAGE_CARS),
  };
}

function clampCar(c: unknown): GarageCar | null {
  if (!c || typeof c !== 'object') return null;
  const r = c as Partial<GarageCar>;
  if (typeof r.id !== 'string' || typeof r.modelId !== 'string') return null;
  const assists = r.assists ?? { abs: true, tcs: true, stability: true };
  return {
    id: r.id,
    modelId: r.modelId,
    modelRev: typeof r.modelRev === 'number' ? r.modelRev : 1,
    nickname: sanitizeName(typeof r.nickname === 'string' ? r.nickname : r.modelId),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : nowIso(),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : nowIso(),
    paint: {
      body: typeof r.paint?.body === 'string' ? r.paint.body : '#2a3344',
      accent: r.paint?.accent,
      finish:
        r.paint?.finish === 'metallic' || r.paint?.finish === 'matte' || r.paint?.finish === 'pearl'
          ? r.paint.finish
          : 'gloss',
    },
    tyres: {
      front: (r.tyres?.front as CompoundId) || 'all_season',
      rear: (r.tyres?.rear as CompoundId) || 'all_season',
    },
    parts: r.parts && typeof r.parts === 'object' ? r.parts : {},
    conversions: r.conversions,
    setup: r.setup && typeof r.setup === 'object' ? r.setup : {},
    assists: { abs: !!assists.abs, tcs: !!assists.tcs, stability: !!assists.stability },
    transmission:
      r.transmission === 'stick_seq' || r.transmission === 'stick_h' ? r.transmission : 'auto',
    odometerKm: typeof r.odometerKm === 'number' ? r.odometerKm : undefined,
    notes: typeof r.notes === 'string' ? r.notes.slice(0, 500) : undefined,
    origin: r.origin === 'career' ? 'career' : 'sandbox',
  };
}

function validateGarage(doc: GarageDoc): GarageDoc {
  return migrateGarage(doc, doc.schema ?? 0);
}

export function loadGarage(driverId: string, assists: GlobalSettings['assistsDefault']): GarageDoc {
  const res = readVersioned<GarageDoc>({
    key: garageKeyForDriver(driverId),
    backupKey: garageBakForDriver(driverId),
    currentSchema: GARAGE_SCHEMA,
    migrate: migrateGarage,
    validate: validateGarage,
    createDefault: () => seedGarage(assists),
  });
  if (res.readOnly) {
    // Newer schema — return empty seed without writing.
    return seedGarage(assists);
  }
  return res.value ?? seedGarage(assists);
}

export function saveGarage(driverId: string, doc: GarageDoc): { ok: boolean; error?: string } {
  const next = validateGarage({ ...doc, schema: GARAGE_SCHEMA, updatedAt: nowIso(), app: 'nig-drives' });
  const res = writeVersioned(garageKeyForDriver(driverId), garageBakForDriver(driverId), next);
  return { ok: res.ok, error: res.error };
}

export function renameGarageCar(doc: GarageDoc, carId: string, nickname: string): GarageDoc {
  const cars = doc.cars.map((c) =>
    c.id === carId ? { ...c, nickname: sanitizeName(nickname), updatedAt: nowIso() } : c,
  );
  return { ...doc, cars, updatedAt: nowIso() };
}

export function setActiveGarageCar(doc: GarageDoc, carId: string | null): GarageDoc {
  if (carId && !doc.cars.some((c) => c.id === carId)) return doc;
  return { ...doc, activeId: carId, updatedAt: nowIso() };
}

export function addGarageCar(doc: GarageDoc, car: GarageCar): GarageDoc {
  if (doc.cars.length >= MAX_GARAGE_CARS) return doc;
  return { ...doc, cars: [...doc.cars, car], activeId: car.id, updatedAt: nowIso() };
}
