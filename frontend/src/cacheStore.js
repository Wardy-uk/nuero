import { openDB } from 'idb';

const DB_NAME = 'neuro-cache';
const STORE_NAME = 'responses';
const DB_VERSION = 1;

let dbPromise;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
    });
  }
  return dbPromise;
}

/**
 * Store a response in the cache keyed by endpoint path.
 * @param {string} key  — endpoint path, e.g. "/api/todos"
 * @param {*} data      — JSON-serialisable response payload
 */
export async function cachePut(key, data) {
  try {
    const db = await getDb();
    await db.put(STORE_NAME, { data, ts: Date.now() }, key);
  } catch (_) {
    // IndexedDB may be unavailable (private browsing, quota) — fail silently
  }
}

/**
 * Read a cached response.
 * @param {string} key
 * @returns {{ data: *, ts: number } | null}
 */
export async function cacheGet(key) {
  try {
    const db = await getDb();
    const entry = await db.get(STORE_NAME, key);
    return entry || null;
  } catch (_) {
    return null;
  }
}

/**
 * Delete a single cache entry.
 * @param {string} key
 */
export async function cacheDelete(key) {
  try {
    const db = await getDb();
    await db.delete(STORE_NAME, key);
  } catch (_) {}
}

/**
 * Clear entire cache.
 */
export async function cacheClear() {
  try {
    const db = await getDb();
    await db.clear(STORE_NAME);
  } catch (_) {}
}
