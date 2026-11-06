import type { GlobalSettings } from './types';
import { nowIso, readVersioned, writeVersioned } from './storage';

export const SETTINGS_KEY = 'nigdrives.settings.v1';
export const SETTINGS_BAK = 'nigdrives.settings.bak';
export const SETTINGS_SCHEMA = 1;

const LEGACY_ASSISTS = 'nigdrives.assists';
const LEGACY_QUALITY = 'nigdrives.quality';

function defaultSettings(): GlobalSettings {
  return {
    schema: SETTINGS_SCHEMA,
    app: 'nig-drives',
    gameVersion: '1.5.0-c',
    updatedAt: nowIso(),
    quality: 'medium',
    assistsDefault: { abs: true, tcs: true, stability: true },
    units: { speed: 'kmh', temp: 'c' },
    audio: { master: 1, engine: 1, ui: 1 },
    tutorialDone: false,
  };
}

function migrateSettings(raw: unknown, from: number): GlobalSettings {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<GlobalSettings>;
  return {
    ...base,
    ...r,
    schema: SETTINGS_SCHEMA,
    app: 'nig-drives',
    updatedAt: nowIso(),
    assistsDefault: {
      abs: r.assistsDefault?.abs ?? true,
      tcs: r.assistsDefault?.tcs ?? true,
      stability: r.assistsDefault?.stability ?? true,
    },
    units: { speed: r.units?.speed === 'mph' ? 'mph' : 'kmh', temp: r.units?.temp === 'f' ? 'f' : 'c' },
    audio: {
      master: clamp01(r.audio?.master ?? 1),
      engine: clamp01(r.audio?.engine ?? 1),
      ui: clamp01(r.audio?.ui ?? 1),
    },
    quality: r.quality === 'low' || r.quality === 'high' ? r.quality : 'medium',
    // from unused except for future chains
    ...(from >= 0 ? {} : {}),
  };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 1));
}

function validateSettings(doc: GlobalSettings): GlobalSettings {
  return migrateSettings(doc, doc.schema ?? 0);
}

/** Migrate legacy assists/quality keys into settings.v1 once. */
function pullLegacy(into: GlobalSettings): GlobalSettings {
  const out = { ...into };
  try {
    const q = localStorage.getItem(LEGACY_QUALITY);
    if (q === 'low' || q === 'medium' || q === 'high') out.quality = q;
  } catch {
    /* ignore */
  }
  try {
    const a = localStorage.getItem(LEGACY_ASSISTS);
    if (a) {
      const parsed = JSON.parse(a) as Partial<GlobalSettings['assistsDefault']>;
      out.assistsDefault = {
        abs: !!parsed.abs,
        tcs: !!parsed.tcs,
        stability: !!parsed.stability,
      };
    }
  } catch {
    /* ignore */
  }
  return out;
}

let cache: GlobalSettings | null = null;

export function loadSettings(): GlobalSettings {
  if (cache) return cache;
  const res = readVersioned<GlobalSettings>({
    key: SETTINGS_KEY,
    backupKey: SETTINGS_BAK,
    currentSchema: SETTINGS_SCHEMA,
    migrate: migrateSettings,
    validate: validateSettings,
    createDefault: () => pullLegacy(defaultSettings()),
  });
  cache = res.value ?? pullLegacy(defaultSettings());
  // If we just created from legacy, persist.
  if (!localStorage.getItem(SETTINGS_KEY)) {
    saveSettings(cache);
  }
  return cache;
}

export function saveSettings(patch: Partial<GlobalSettings>): GlobalSettings {
  const next: GlobalSettings = validateSettings({
    ...loadSettings(),
    ...patch,
    schema: SETTINGS_SCHEMA,
    app: 'nig-drives',
    updatedAt: nowIso(),
  });
  writeVersioned(SETTINGS_KEY, SETTINGS_BAK, next);
  cache = next;
  // Keep legacy keys in sync one release so older builds still see quality/assists.
  try {
    localStorage.setItem(LEGACY_QUALITY, next.quality);
    localStorage.setItem(LEGACY_ASSISTS, JSON.stringify(next.assistsDefault));
  } catch {
    /* ignore */
  }
  return next;
}
