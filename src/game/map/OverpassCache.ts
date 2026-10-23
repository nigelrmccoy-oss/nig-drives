/**
 * v1.3.5: persistent last-good Overpass responses (IndexedDB), keyed per tile
 * / shore window / relation batch. When every mirror is slow or down, a tile
 * falls back to its cached real OSM data before the synthetic offline grid.
 * All calls fail soft (private mode, no IndexedDB, quota) → behave as a miss.
 */
const DB_NAME = 'nig-drives-overpass';
const STORE = 'responses';
const MAX_ENTRIES = 400;

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

let puts = 0;

export async function cachePut(key: string, data: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put({ key, t: Date.now(), data } satisfies Row);
    if (++puts % 20 === 1) {
      // Trim the oldest rows now and then
      const countReq = store.count();
      countReq.onsuccess = () => {
        let extra = countReq.result - MAX_ENTRIES;
        if (extra <= 0) return;
        const cur = store.index('t').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c || extra-- <= 0) return;
          c.delete();
          c.continue();
        };
      };
    }
  } catch {
    /* quota / closed: ignore */
  }
}
