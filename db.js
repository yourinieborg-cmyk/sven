// Kleine IndexedDB-laag. De database-versie alleen verhogen met een
// upgrade die bestaande gegevens behoudt (nooit stores verwijderen).
const DB_NAME = 'sven-uren';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('shifts')) db.createObjectStore('shifts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('planned')) db.createObjectStore('planned', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function reqP(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export const db = {
  all: (store) => tx(store, 'readonly', (s) => reqP(s.getAll())),
  get: (store, key) => tx(store, 'readonly', (s) => reqP(s.get(key))),
  put: (store, value) => tx(store, 'readwrite', (s) => reqP(s.put(value))),
  del: (store, key) => tx(store, 'readwrite', (s) => reqP(s.delete(key))),
  // Vervangt alles in één transactie (voor import).
  replaceAll: (data) => open().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(['shifts', 'planned', 'settings'], 'readwrite');
    for (const name of ['shifts', 'planned', 'settings']) {
      const s = t.objectStore(name);
      s.clear();
      for (const item of data[name]) s.put(item);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  })),
  // Start een dienst alleen als er nog geen actieve dienst is (in dezelfde transactie).
  startShiftIfNone: (shift) => open().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('shifts', 'readwrite');
    const s = t.objectStore('shifts');
    let started = false;
    const r = s.getAll();
    r.onsuccess = () => {
      if (!r.result.some((x) => x.end == null)) { s.put(shift); started = true; }
    };
    t.oncomplete = () => resolve(started);
    t.onerror = () => reject(t.error);
  }))
};
