/**
 * v1.3.5: persistent last-good Overpass responses (IndexedDB), keyed per tile
 * / shore window / relation batch. When every mirror is slow or down, a tile
 * falls back to its cached real OSM data before the synthetic offline grid.
 * All calls fail soft (private mode, no IndexedDB, quota) → behave as a miss.
 */
const DB_NAME = 'nig-drives-overpass';
const STORE = 'responses';
export let cacheNotice = '';
interface DiskCache {
  get(key: string): Promise<Row | null>;
  put(row: Row): Promise<void>;
  stats(): Promise<{ count: number; bytes: number }>;
  clear(): Promise<void>;
}
declare global { interface Window { mapCache?: DiskCache } }
const disk = () => typeof window !== 'undefined' ? window.mapCache : undefined;
if (typeof navigator !== 'undefined') void navigator.storage?.persist?.().catch(() => false);

interface Row {
  key: string;
  t: number;
  data: unknown;
}

let dbP: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('t', 't');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbP;
}

export async function cacheGet<T>(key: string): Promise<{ data: T; ageMs: number } | null> {
  const native = disk();
  if (native) {
    try { const r = await native.get(key); return r ? { data: r.data as T, ageMs: Date.now() - r.t } : null; }
    catch { cacheNotice = 'Map disk unavailable'; return null; }
  }
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        const row = req.result as Row | undefined;
        resolve(row ? { data: row.data as T, ageMs: Date.now() - row.t } : null);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cachePut(key: string, data: unknown): Promise<void> {
  const row = { key, t: Date.now(), data } satisfies Row;
  try {
    const native = disk();
    if (native) { await native.put(row); return; }
    const db = await openDb();
    if (!db) { cacheNotice = 'Map storage unavailable'; return; }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { cacheNotice = 'Map storage full or unavailable — existing tiles kept'; }
}

export async function cacheStats(): Promise<{ count: number; bytes: number; notice: string }> {
  const native = disk();
  if (native) return { ...await native.stats(), notice: cacheNotice };
  const db = await openDb();
  let count = 0, bytes = 0;
  if (db) await new Promise<void>((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(); return; }
      count++; bytes += new Blob([JSON.stringify(c.value)]).size; c.continue();
    };
    req.onerror = () => resolve();
  });
  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.quota && (estimate.usage ?? 0) / estimate.quota > 0.85) cacheNotice = 'Map storage near browser quota';
  return { count, bytes, notice: cacheNotice };
}

export async function clearMapCache(): Promise<void> {
  const native = disk();
  if (native) await native.clear();
  else {
    const db = await openDb();
    if (db) await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  }
  cacheNotice = '';
}

const refreshing = new Set<string>();
export async function cachedDem(url: string, signal: AbortSignal): Promise<Blob> {
  const key = `dem:${url}`;
  const old = await cacheGet<number[]>(key);
  const download = async () => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`DEM ${res.status}`);
    const blob = await res.blob();
    await cachePut(key, Array.from(new Uint8Array(await blob.arrayBuffer())));
    return blob;
  };
  if (!old) return download();
  if (old.ageMs > 30 * 86400_000 && navigator.onLine && !refreshing.has(key)) {
    refreshing.add(key);
    void download().catch(() => undefined).finally(() => refreshing.delete(key));
  }
  return new Blob([new Uint8Array(old.data)], { type: 'image/png' });
}
