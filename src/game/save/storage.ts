/**
 * Versioned localStorage helpers: parse → migrate → validate → write,
 * with backup key and quota handling. Never throws to the UI layer.
 */

export type MigrateFn<T> = (raw: unknown, fromSchema: number) => T;

export interface StorageResult<T> {
  ok: boolean;
  value: T | null;
  error?: string;
  readOnly?: boolean;
}

function safeParse(raw: string | null): unknown {
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readVersioned<T extends { schema: number }>(opts: {
  key: string;
  backupKey: string;
  currentSchema: number;
  migrate: MigrateFn<T>;
  validate: (doc: T) => T;
  createDefault: () => T;
}): StorageResult<T> {
  try {
    const raw = localStorage.getItem(opts.key);
    const parsed = safeParse(raw);
    if (parsed == null) {
      const fresh = opts.validate(opts.createDefault());
      writeVersioned(opts.key, opts.backupKey, fresh);
      return { ok: true, value: fresh };
    }
    const schema =
      typeof parsed === 'object' && parsed && 'schema' in parsed
        ? Number((parsed as { schema: unknown }).schema)
        : 0;
    if (!Number.isFinite(schema)) {
      return { ok: false, value: opts.validate(opts.createDefault()), error: 'bad schema' };
    }
    if (schema > opts.currentSchema) {
      // Newer than this build — keep a bak, do not overwrite.
      try {
        localStorage.setItem(opts.backupKey, raw!);
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        value: null,
        readOnly: true,
        error: `save schema ${schema} newer than app ${opts.currentSchema}`,
      };
    }
    const migrated = schema < opts.currentSchema ? opts.migrate(parsed, schema) : (parsed as T);
    const validated = opts.validate(migrated);
    return { ok: true, value: validated };
  } catch (e) {
    return { ok: false, value: opts.validate(opts.createDefault()), error: String(e) };
  }
}

export function writeVersioned(key: string, backupKey: string, doc: unknown): StorageResult<null> {
  let serialized: string;
  try {
    serialized = JSON.stringify(doc);
  } catch (e) {
    return { ok: false, value: null, error: 'serialize failed: ' + String(e) };
  }
  try {
    const prev = localStorage.getItem(key);
    if (prev) {
      try {
        localStorage.setItem(backupKey, prev);
      } catch {
        /* bak optional */
      }
    }
    localStorage.setItem(key, serialized);
    return { ok: true, value: null };
  } catch (e) {
    const msg = String(e);
    const quota = /quota| QuotaExceeded/i.test(msg);
    return {
      ok: false,
      value: null,
      error: quota ? 'storage full — export your garage, then free space' : msg,
    };
  }
}

export function newId(prefix = ''): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sanitizeName(name: string, max = 32): string {
  return name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) || 'Untitled';
}
