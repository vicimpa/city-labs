// IndexedDB working copy: { meta, chunks: {layer: Uint8Array (encoded VSPB chunks)}, savedAt, source }.
// Layers are stored pre-encoded so an autosave re-encodes only the layers that changed.
const DB = 'vespera-editor', STORE = 'files', KEY = 'working';

function open() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode), rq = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(rq?.result); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
}
export const loadWorking = () => tx('readonly', (s) => s.get(KEY));
export const saveWorking = (rec) => tx('readwrite', (s) => s.put(rec, KEY));
export const dropWorking = () => tx('readwrite', (s) => s.delete(KEY));
