/**
 * Driver profiles = save slots.
 * Defaults: "Driver 1", "Driver 2", … Create / switch / rename.
 * Each driver owns an independent garage (cars, upgrades, setups, nicknames).
 * Global settings stay in nigdrives.settings.v1 and are shared.
 */
import type { DriversDoc, DriverProfile, GarageDoc, GlobalSettings } from './types';
import { newId, nowIso, readVersioned, sanitizeName, writeVersioned } from './storage';
import { loadGarage, saveGarage, seedGarage } from './garage';
import { loadSettings } from './settings';

export const DRIVERS_KEY = 'nigdrives.drivers.v1';
export const DRIVERS_BAK = 'nigdrives.drivers.bak';
export const DRIVERS_SCHEMA = 1;
export const MAX_DRIVERS = 8;

function defaultDriverName(index1Based: number): string {
  return `Driver ${index1Based}`;
}

function nextDriverName(existing: DriverProfile[]): string {
  const used = new Set(existing.map((d) => d.name));
  for (let i = 1; i <= MAX_DRIVERS + 5; i++) {
    const n = defaultDriverName(i);
    if (!used.has(n)) return n;
  }
  return `Driver ${Date.now() % 10000}`;
}

function makeDriver(name: string): DriverProfile {
  const t = nowIso();
  return { id: newId('drv'), name: sanitizeName(name, 24), createdAt: t, updatedAt: t };
}

function defaultDriversDoc(): DriversDoc {
  const d = makeDriver(defaultDriverName(1));
  return {
    schema: DRIVERS_SCHEMA,
    app: 'nig-drives',
    gameVersion: '1.5.0-b',
    updatedAt: nowIso(),
    activeId: d.id,
    drivers: [d],
  };
}

function migrateDrivers(raw: unknown, _from: number): DriversDoc {
  const base = defaultDriversDoc();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<DriversDoc>;
  const drivers = Array.isArray(r.drivers)
    ? r.drivers
        .filter((d): d is DriverProfile => !!d && typeof d.id === 'string' && typeof d.name === 'string')
        .map((d) => ({
          id: d.id,
          name: sanitizeName(d.name, 24),
          createdAt: typeof d.createdAt === 'string' ? d.createdAt : nowIso(),
          updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : nowIso(),
        }))
        .slice(0, MAX_DRIVERS)
    : base.drivers;
  if (drivers.length === 0) return base;
  let activeId = typeof r.activeId === 'string' ? r.activeId : drivers[0].id;
  if (!drivers.some((d) => d.id === activeId)) activeId = drivers[0].id;
  return {
    schema: DRIVERS_SCHEMA,
    app: 'nig-drives',
    gameVersion: typeof r.gameVersion === 'string' ? r.gameVersion : '1.5.0-b',
    updatedAt: nowIso(),
    activeId,
    drivers,
  };
}

function validateDrivers(doc: DriversDoc): DriversDoc {
  return migrateDrivers(doc, doc.schema ?? 0);
}

let cache: DriversDoc | null = null;

export function loadDrivers(): DriversDoc {
  if (cache) return cache;
  const res = readVersioned<DriversDoc>({
    key: DRIVERS_KEY,
    backupKey: DRIVERS_BAK,
    currentSchema: DRIVERS_SCHEMA,
    migrate: migrateDrivers,
    validate: validateDrivers,
    createDefault: defaultDriversDoc,
  });
  cache = res.value ?? defaultDriversDoc();
  // Ensure active driver has a garage seeded.
  ensureDriverGarage(cache.activeId, loadSettings());
  return cache;
}

function persist(doc: DriversDoc): DriversDoc {
  const next = validateDrivers({ ...doc, schema: DRIVERS_SCHEMA, updatedAt: nowIso(), app: 'nig-drives' });
  writeVersioned(DRIVERS_KEY, DRIVERS_BAK, next);
  cache = next;
  return next;
}

function ensureDriverGarage(driverId: string, settings: GlobalSettings): GarageDoc {
  return loadGarage(driverId, settings.assistsDefault);
}

export function getActiveDriver(): DriverProfile {
  const doc = loadDrivers();
  return doc.drivers.find((d) => d.id === doc.activeId) ?? doc.drivers[0];
}

export function listDrivers(): DriverProfile[] {
  return loadDrivers().drivers.slice();
}

export function createDriver(name?: string): { ok: boolean; driver?: DriverProfile; error?: string } {
  const doc = loadDrivers();
  if (doc.drivers.length >= MAX_DRIVERS) {
    return { ok: false, error: `At most ${MAX_DRIVERS} drivers` };
  }
  const driver = makeDriver(name?.trim() ? name : nextDriverName(doc.drivers));
  const settings = loadSettings();
  // Independent garage for the new driver
  saveGarage(driver.id, seedGarage(settings.assistsDefault));
  const next = persist({
    ...doc,
    drivers: [...doc.drivers, driver],
    activeId: driver.id,
  });
  return { ok: true, driver: next.drivers.find((d) => d.id === driver.id) };
}

export function switchDriver(driverId: string): { ok: boolean; error?: string } {
  const doc = loadDrivers();
  if (!doc.drivers.some((d) => d.id === driverId)) return { ok: false, error: 'Unknown driver' };
  ensureDriverGarage(driverId, loadSettings());
  persist({ ...doc, activeId: driverId });
  return { ok: true };
}

export function renameDriver(driverId: string, name: string): { ok: boolean; error?: string } {
  const doc = loadDrivers();
  const clean = sanitizeName(name, 24);
  if (!clean) return { ok: false, error: 'Name required' };
  if (!doc.drivers.some((d) => d.id === driverId)) return { ok: false, error: 'Unknown driver' };
  persist({
    ...doc,
    drivers: doc.drivers.map((d) =>
      d.id === driverId ? { ...d, name: clean, updatedAt: nowIso() } : d,
    ),
  });
  return { ok: true };
}

export function deleteDriver(driverId: string): { ok: boolean; error?: string } {
  const doc = loadDrivers();
  if (doc.drivers.length <= 1) return { ok: false, error: 'Need at least one driver' };
  if (!doc.drivers.some((d) => d.id === driverId)) return { ok: false, error: 'Unknown driver' };
  const drivers = doc.drivers.filter((d) => d.id !== driverId);
  const activeId = doc.activeId === driverId ? drivers[0].id : doc.activeId;
  persist({ ...doc, drivers, activeId });
  // Leave orphan garage keys; they are small and avoid accidental wipe. Could prune later.
  return { ok: true };
}

export function activeGarage(): GarageDoc {
  const settings = loadSettings();
  return loadGarage(getActiveDriver().id, settings.assistsDefault);
}

export function saveActiveGarage(doc: GarageDoc): { ok: boolean; error?: string } {
  return saveGarage(getActiveDriver().id, doc);
}
