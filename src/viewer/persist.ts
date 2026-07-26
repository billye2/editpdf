// IndexedDB persistence: crash/close recovery for unsaved edits (and, in the
// same DB, the recent-files cache). Everything here is strictly best-effort —
// persistence must never break viewing/editing, so entry points no-op when
// IndexedDB is unavailable (private mode) and callers fire-and-forget.

const DB_NAME = 'editpdf';
const DB_VERSION = 1;
const SESSION_STORE = 'session';
const RECENT_META_STORE = 'recentMeta';
const RECENT_BYTES_STORE = 'recentBytes';
const SESSION_KEY = 'current';

export interface SessionSnapshot {
  bytes: Uint8Array;
  fileName: string;
  savedAt: number;
}

export function hasIDB(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
        if (!db.objectStoreNames.contains(RECENT_META_STORE)) db.createObjectStore(RECENT_META_STORE);
        if (!db.objectStoreNames.contains(RECENT_BYTES_STORE)) db.createObjectStore(RECENT_BYTES_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null; // allow a retry on the next call
        reject(req.error ?? new Error('IndexedDB open failed'));
      };
    });
  }
  return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function reqResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

// ---------- session (autosave / restore) ----------

export async function saveSession(snapshot: SessionSnapshot): Promise<void> {
  if (!hasIDB()) return;
  const db = await openDb();
  const tx = db.transaction(SESSION_STORE, 'readwrite');
  tx.objectStore(SESSION_STORE).put(snapshot, SESSION_KEY);
  await txDone(tx);
}

export async function loadSession(): Promise<SessionSnapshot | null> {
  if (!hasIDB()) return null;
  const db = await openDb();
  const tx = db.transaction(SESSION_STORE, 'readonly');
  const val = await reqResult(tx.objectStore(SESSION_STORE).get(SESSION_KEY));
  await txDone(tx);
  const s = val as SessionSnapshot | undefined;
  // integrity: never offer a half-usable restore
  if (!s || !(s.bytes instanceof Uint8Array) || s.bytes.length === 0 || typeof s.fileName !== 'string') return null;
  return s;
}

export async function clearSession(): Promise<void> {
  if (!hasIDB()) return;
  const db = await openDb();
  const tx = db.transaction(SESSION_STORE, 'readwrite');
  tx.objectStore(SESSION_STORE).delete(SESSION_KEY);
  await txDone(tx);
}

// ---------- recent files (content-hashed) ----------

export interface RecentMeta {
  hash: string;
  name: string;
  size: number;
  pageCount: number;
  openedAt: number;
  pinned: boolean;
  thumb?: string; // small JPEG data URL
}

export interface RecentLimits {
  maxCount: number;
  maxBytes: number;
}

export const RECENT_LIMITS: RecentLimits = { maxCount: 10, maxBytes: 100 * 1024 * 1024 };

/** SHA-256 of the bytes, so reopening the same file updates in place. Falls
 *  back to name+length when subtle crypto is unavailable — a weak but stable
 *  key beats no recents. */
export async function hashBytes(bytes: Uint8Array, name: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `${name}|${bytes.length}`;
  }
}

// Strictly monotonic timestamp: same-millisecond writes would make the
// "oldest unpinned" eviction order arbitrary (Date.now() ties — hit by fast
// CI runners writing several entries in one ms).
let lastOpenedAt = 0;
function nextOpenedAt(): number {
  lastOpenedAt = Math.max(Date.now(), lastOpenedAt + 1);
  return lastOpenedAt;
}

/** Store/update a recent entry and evict (oldest unpinned first) past the
 *  count/size caps — eviction runs in the SAME transaction as the write so
 *  meta and bytes can never drift apart. Best-effort: callers fire-and-forget. */
export async function recordRecent(
  bytes: Uint8Array,
  info: { name: string; pageCount: number; thumb?: string },
  limits: RecentLimits = RECENT_LIMITS,
): Promise<void> {
  if (!hasIDB()) return;
  const hash = await hashBytes(bytes, info.name);
  const db = await openDb();
  const tx = db.transaction([RECENT_META_STORE, RECENT_BYTES_STORE], 'readwrite');
  const metaStore = tx.objectStore(RECENT_META_STORE);
  const bytesStore = tx.objectStore(RECENT_BYTES_STORE);
  const existing = (await reqResult(metaStore.get(hash))) as RecentMeta | undefined;
  const meta: RecentMeta = {
    hash,
    name: info.name,
    size: bytes.length,
    pageCount: info.pageCount,
    openedAt: nextOpenedAt(),
    pinned: existing?.pinned ?? false,
    thumb: info.thumb ?? existing?.thumb,
  };
  metaStore.put(meta, hash);
  bytesStore.put(bytes, hash);

  // evict: oldest unpinned first; the just-written entry and pins are exempt
  const all = (await reqResult(metaStore.getAll())) as RecentMeta[];
  const evictable = all.filter((m) => m.hash !== hash && !m.pinned).sort((a, b) => a.openedAt - b.openedAt);
  let count = all.length;
  let total = all.reduce((sum, m) => sum + m.size, 0);
  for (const m of evictable) {
    if (count <= limits.maxCount && total <= limits.maxBytes) break;
    metaStore.delete(m.hash);
    bytesStore.delete(m.hash);
    count--;
    total -= m.size;
  }
  await txDone(tx);
}

export async function listRecents(): Promise<RecentMeta[]> {
  if (!hasIDB()) return [];
  const db = await openDb();
  const tx = db.transaction(RECENT_META_STORE, 'readonly');
  const all = (await reqResult(tx.objectStore(RECENT_META_STORE).getAll())) as RecentMeta[];
  await txDone(tx);
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

export async function getRecentBytes(hash: string): Promise<Uint8Array | null> {
  if (!hasIDB()) return null;
  const db = await openDb();
  const tx = db.transaction(RECENT_BYTES_STORE, 'readonly');
  const val = await reqResult(tx.objectStore(RECENT_BYTES_STORE).get(hash));
  await txDone(tx);
  return val instanceof Uint8Array && val.length > 0 ? val : null;
}

export async function setRecentPinned(hash: string, pinned: boolean): Promise<void> {
  if (!hasIDB()) return;
  const db = await openDb();
  const tx = db.transaction(RECENT_META_STORE, 'readwrite');
  const store = tx.objectStore(RECENT_META_STORE);
  const meta = (await reqResult(store.get(hash))) as RecentMeta | undefined;
  if (meta) store.put({ ...meta, pinned }, hash);
  await txDone(tx);
}

export async function removeRecent(hash: string): Promise<void> {
  if (!hasIDB()) return;
  const db = await openDb();
  const tx = db.transaction([RECENT_META_STORE, RECENT_BYTES_STORE], 'readwrite');
  tx.objectStore(RECENT_META_STORE).delete(hash);
  tx.objectStore(RECENT_BYTES_STORE).delete(hash);
  await txDone(tx);
}

export async function clearRecents(): Promise<void> {
  if (!hasIDB()) return;
  const db = await openDb();
  const tx = db.transaction([RECENT_META_STORE, RECENT_BYTES_STORE], 'readwrite');
  tx.objectStore(RECENT_META_STORE).clear();
  tx.objectStore(RECENT_BYTES_STORE).clear();
  await txDone(tx);
}
