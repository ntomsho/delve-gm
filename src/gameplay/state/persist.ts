/**
 * PERSISTENCE
 * ===========
 *
 * A tiny key/value interface with two implementations, so everything above it
 * runs headless.
 *
 *   memoryStore()    tests, the CLI, anything under vitest
 *   indexedDbStore() the browser
 *
 * IndexedDB is browser-only, and the applier and store are exactly the code
 * most worth testing — refusing bad input is their whole job. Putting the
 * boundary here means those tests never need jsdom or a fake-indexeddb shim.
 *
 * TWO KEYSPACES, deliberately. A generated dungeon is large and written once;
 * the run around it is small and written on every commit. Keeping them apart
 * means a turn does not re-serialise thirty rooms and everything in them.
 *
 *   dungeon:<id>  GeneratedDungeon  — write-once
 *   run:<id>      RunState          — written per commit
 *   character:<id> PlayerCharacter  — the character library (Phase 5)
 */

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** every key carrying this prefix, for listing saves and characters */
  keys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// KEYS
// ---------------------------------------------------------------------------

export const dungeonKey = (id: string) => `dungeon:${id}`;
export const runKey = (id: string) => `run:${id}`;
export const characterKey = (id: string) => `character:${id}`;

// ---------------------------------------------------------------------------
// MEMORY  (tests, CLI, Node)
// ---------------------------------------------------------------------------

/**
 * Values are structured-cloned on the way in and out, so a caller mutating an
 * object it stored cannot silently change what is "persisted" — which is the
 * behaviour IndexedDB has, and the behaviour a test wants to be checking
 * against.
 */
export function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();

  return {
    async get<T>(key: string) {
      const v = map.get(key);
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    async set<T>(key: string, value: T) {
      map.set(key, structuredClone(value));
    },
    async delete(key: string) {
      map.delete(key);
    },
    async keys(prefix?: string) {
      const all = [...map.keys()];
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    async clear() {
      map.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// INDEXEDDB  (browser)
// ---------------------------------------------------------------------------

const DB_NAME = "dungeon-crawler";
const DB_VERSION = 1;
const STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function indexedDbStore(): KeyValueStore {
  // Opened lazily and reused: constructing the store must not touch IndexedDB,
  // or importing this module would break under Node.
  let db: Promise<IDBDatabase> | undefined;
  const conn = () => (db ??= openDb());

  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const store = (await conn()).transaction(STORE, mode).objectStore(STORE);
    return promisify(fn(store));
  };

  return {
    get: <T>(key: string) => tx<T>("readonly", (s) => s.get(key) as IDBRequest<T>),
    set: async <T>(key: string, value: T) => {
      await tx("readwrite", (s) => s.put(value, key));
    },
    delete: async (key: string) => {
      await tx("readwrite", (s) => s.delete(key));
    },
    keys: async (prefix?: string) => {
      const all = (await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys())).map(String);
      return prefix ? all.filter((k) => k.startsWith(prefix)) : all;
    },
    clear: async () => {
      await tx("readwrite", (s) => s.clear());
    },
  };
}

// ---------------------------------------------------------------------------
// DEFAULT
// ---------------------------------------------------------------------------

/** IndexedDB in a browser, memory anywhere else. */
export function defaultStore(): KeyValueStore {
  return typeof indexedDB === "undefined" ? memoryStore() : indexedDbStore();
}
