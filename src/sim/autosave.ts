/**
 * Browser session persistence: named slots (up to MAX_SLOTS) so a reload
 * does not wipe work, and so several projects can live side-by-side.
 *
 * Prefer localStorage (sync). Oversized payloads fall back to IndexedDB.
 * Legacy key `switchlab.autosave.v1` migrates into slot "1" on first access.
 */

import type { SerializedProject } from './serialize.js';

export const MAX_SLOTS = 3;

const META_KEY = 'switchlab.sessions.v1';
const LEGACY_KEY = 'switchlab.autosave.v1';
const IDB_NAME = 'switchlab';
const IDB_STORE = 'autosave';

export interface SessionSlotMeta {
  id: string;
  name: string;
  updatedAt: number;
  /** Monotonic counter bumped on every successful save — detects multi-tab races. */
  writeGen?: number;
}

export interface SessionMeta {
  activeId: string;
  slots: SessionSlotMeta[];
}

function lsSlotKey(id: string): string {
  return `switchlab.slot.${id}`;
}

function idbSlotKey(id: string): string {
  return `slot:${id}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function idbPut(key: string, json: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(json, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB put failed'));
  });
  db.close();
}

async function idbGet(key: string): Promise<string | null> {
  try {
    const db = await openDb();
    const json = await new Promise<string | undefined>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result as string | undefined);
      req.onerror = () => reject(req.error ?? new Error('indexedDB get failed'));
    });
    db.close();
    return json ?? null;
  } catch {
    return null;
  }
}

async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'));
    });
    db.close();
  } catch {
    /* ignore */
  }
}

function parseProject(raw: string): SerializedProject | null {
  try {
    const data = JSON.parse(raw) as SerializedProject;
    if (data?.format !== 'z80-sim-project') return null;
    return data;
  } catch {
    return null;
  }
}

function defaultMeta(): SessionMeta {
  return {
    activeId: '1',
    slots: [{ id: '1', name: 'Session 1', updatedAt: Date.now() }],
  };
}

/** Read/create session index; migrates legacy single autosave once. */
export function getSessionMeta(): SessionMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (raw) {
      const meta = JSON.parse(raw) as SessionMeta;
      if (meta?.activeId && Array.isArray(meta.slots) && meta.slots.length > 0) return meta;
    }
  } catch {
    /* fall through */
  }

  const meta = defaultMeta();
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      localStorage.setItem(lsSlotKey('1'), legacy);
      localStorage.removeItem(LEGACY_KEY);
      meta.slots[0]!.updatedAt = Date.now();
    }
  } catch {
    /* ignore */
  }
  saveSessionMeta(meta);
  return meta;
}

export function saveSessionMeta(meta: SessionMeta): void {
  try {
    localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    /* ignore */
  }
}

export function loadSlotSync(slotId: string): SerializedProject | null {
  try {
    const raw = localStorage.getItem(lsSlotKey(slotId));
    if (!raw) return null;
    return parseProject(raw);
  } catch {
    return null;
  }
}

/** Sync LS first, then IndexedDB for this slot. */
export async function loadSlot(slotId: string): Promise<SerializedProject | null> {
  const sync = loadSlotSync(slotId);
  if (sync) return sync;
  const json = await idbGet(idbSlotKey(slotId));
  if (!json) {
    // Legacy IDB key from single-slot era.
    if (slotId === '1') {
      const legacy = await idbGet('project');
      return legacy ? parseProject(legacy) : null;
    }
    return null;
  }
  return parseProject(json);
}

export async function saveSlot(
  slotId: string,
  data: SerializedProject,
): Promise<'localStorage' | 'indexedDB' | null> {
  const json = JSON.stringify(data);
  try {
    localStorage.setItem(lsSlotKey(slotId), json);
    void idbPut(idbSlotKey(slotId), json).catch(() => {});
    return 'localStorage';
  } catch {
    try {
      localStorage.removeItem(lsSlotKey(slotId));
    } catch {
      /* ignore */
    }
    try {
      await idbPut(idbSlotKey(slotId), json);
      return 'indexedDB';
    } catch {
      return null;
    }
  }
}

export async function clearSlot(slotId: string): Promise<void> {
  try {
    localStorage.removeItem(lsSlotKey(slotId));
  } catch {
    /* ignore */
  }
  await idbDelete(idbSlotKey(slotId));
  if (slotId === '1') {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
    await idbDelete('project');
  }
}

/** Clear every slot + meta (Reset session). */
export async function clearAllSessions(): Promise<void> {
  const meta = getSessionMeta();
  for (const s of meta.slots) await clearSlot(s.id);
  try {
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
  await idbDelete('project');
}

export function ensureSlot(meta: SessionMeta, id: string, name: string): SessionMeta {
  if (meta.slots.some((s) => s.id === id)) return meta;
  if (meta.slots.length >= MAX_SLOTS) throw new Error(`At most ${MAX_SLOTS} sessions`);
  meta.slots.push({ id, name, updatedAt: Date.now() });
  return meta;
}

export function touchSlot(meta: SessionMeta, id: string): void {
  const s = meta.slots.find((x) => x.id === id);
  if (s) s.updatedAt = Date.now();
}

/** Active slot project — sync path used at boot. */
export function loadAutosaveSync(): SerializedProject | null {
  const meta = getSessionMeta();
  return loadSlotSync(meta.activeId);
}

export async function loadAutosave(): Promise<SerializedProject | null> {
  const meta = getSessionMeta();
  return loadSlot(meta.activeId);
}

export async function clearAutosave(): Promise<void> {
  await clearAllSessions();
}

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

/**
 * Debounced writer for the *active* session slot.
 * `getProject` is evaluated at flush time.
 *
 * Multi-tab: each successful save bumps `writeGen` on the slot meta. This tab
 * remembers the last gen it wrote; if meta shows a higher gen before flush,
 * we refuse to overwrite and surface `conflict`.
 */
export function createAutosaveScheduler(
  getProject: () => SerializedProject,
  opts: {
    delayMs?: number;
    getActiveSlotId?: () => string;
    onStatus?: (status: AutosaveStatus, detail?: string) => void;
    onConflict?: (slotId: string) => void;
  } = {},
): {
  schedule: () => void;
  flush: () => Promise<void>;
  dispose: () => void;
  setActiveSlot: (id: string) => void;
  /** Call after loading a slot so conflict detection starts from that gen. */
  adoptWriteGen: (slotId: string) => void;
  /** Last known writeGen for the active slot (this tab). */
  localWriteGen: () => number;
  /**
   * Adopt the remote writeGen then flush — overwrites another tab's save
   * with this tab's project (conflict "Restore local").
   */
  forceOverwrite: () => Promise<void>;
} {
  const delayMs = opts.delayMs ?? 800;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing = false;
  let pending = false;
  let activeSlotId = opts.getActiveSlotId?.() ?? getSessionMeta().activeId;
  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-slot last writeGen this tab authored or loaded. */
  const localGens = new Map<string, number>();

  const readSlotGen = (slotId: string): number => {
    const meta = getSessionMeta();
    const s = meta.slots.find((x) => x.id === slotId);
    return s?.writeGen ?? 0;
  };

  const adoptWriteGen = (slotId: string): void => {
    localGens.set(slotId, readSlotGen(slotId));
  };
  adoptWriteGen(activeSlotId);

  const setStatus = (status: AutosaveStatus, detail?: string): void => {
    opts.onStatus?.(status, detail);
  };

  const run = (): Promise<void> => {
    timer = null;
    if (writing) {
      pending = true;
      return Promise.resolve();
    }
    writing = true;
    setStatus('saving');
    const slotId = activeSlotId;
    const metaGen = readSlotGen(slotId);
    const mine = localGens.get(slotId) ?? 0;
    if (metaGen > mine) {
      writing = false;
      setStatus('conflict', 'elsewhere');
      opts.onConflict?.(slotId);
      return Promise.resolve();
    }
    const data = getProject();
    return saveSlot(slotId, data).then((where) => {
      writing = false;
      const meta = getSessionMeta();
      if (where) {
        const nextGen = (meta.slots.find((x) => x.id === slotId)?.writeGen ?? 0) + 1;
        const slot = meta.slots.find((x) => x.id === slotId);
        if (slot) {
          slot.writeGen = nextGen;
          slot.updatedAt = Date.now();
        }
        localGens.set(slotId, nextGen);
        saveSessionMeta(meta);
        setStatus('saved', where === 'indexedDB' ? 'IDB' : undefined);
        if (savedTimer) clearTimeout(savedTimer);
        savedTimer = setTimeout(() => setStatus('idle'), 2500);
      } else {
        setStatus('error', 'storage full?');
      }
      if (pending) {
        pending = false;
        schedule();
      }
    });
  };

  const schedule = (): void => {
    setStatus('pending');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void run();
    }, delayMs);
  };

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return run();
  };

  const forceOverwrite = (): Promise<void> => {
    // Catch up to remote gen so the conflict gate lets this write through.
    localGens.set(activeSlotId, readSlotGen(activeSlotId));
    return flush();
  };

  const onHide = (): void => {
    if (document.visibilityState === 'hidden') void flush();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', () => {
    void flush();
  });

  // Another tab wrote session meta — detect ahead-of-us gens early.
  const onStorage = (ev: StorageEvent): void => {
    if (ev.key !== META_KEY || !ev.newValue) return;
    try {
      const meta = JSON.parse(ev.newValue) as SessionMeta;
      const slot = meta.slots.find((s) => s.id === activeSlotId);
      const theirs = slot?.writeGen ?? 0;
      const mine = localGens.get(activeSlotId) ?? 0;
      if (theirs > mine) {
        setStatus('conflict', 'elsewhere');
        opts.onConflict?.(activeSlotId);
      }
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('storage', onStorage);

  return {
    schedule,
    flush,
    forceOverwrite,
    adoptWriteGen,
    localWriteGen: () => localGens.get(activeSlotId) ?? 0,
    setActiveSlot: (id: string) => {
      activeSlotId = id;
      adoptWriteGen(id);
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
      if (savedTimer) clearTimeout(savedTimer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('storage', onStorage);
    },
  };
}
