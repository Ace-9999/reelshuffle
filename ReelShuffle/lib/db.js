import { cleanRecord } from './model.js';

let connection;
export function openDB() {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('reelshuffle', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('reels', { keyPath: 'shortcode' });
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = null; };
      resolve(request.result);
    };
    request.onerror = () => { connection = null; reject(request.error); };
  });
  return connection;
}

async function transaction(stores, mode, run) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let output;
    tx.oncomplete = () => resolve(typeof output === 'function' ? output() : output);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Cache update interrupted'));
    output = run(tx);
  });
}

export const getReels = () => transaction(['reels'], 'readonly', tx => {
  const r = tx.objectStore('reels').getAll(); return () => r.result;
});
export const putReels = records => transaction(['reels'], 'readwrite', tx => {
  for (const reel of records) tx.objectStore('reels').put(cleanRecord(reel));
});
export const deleteReel = shortcode => transaction(['reels'], 'readwrite', tx => tx.objectStore('reels').delete(shortcode));
export const getMeta = key => transaction(['meta'], 'readonly', tx => {
  const r = tx.objectStore('meta').get(key); return () => r.result;
});
export const setMeta = (key, value) => transaction(['meta'], 'readwrite', tx => tx.objectStore('meta').put(value, key));
export const clearDB = () => transaction(['reels', 'meta'], 'readwrite', tx => {
  tx.objectStore('reels').clear(); tx.objectStore('meta').clear();
});

// Reconciliation only runs after the last valid page. Interrupted syncs never prune.
export const reconcile = (seen, syncedAt) => transaction(['reels', 'meta'], 'readwrite', tx => {
  const request = tx.objectStore('reels').openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if (!seen.has(cursor.key)) cursor.delete();
    cursor.continue();
  };
  tx.objectStore('meta').put(syncedAt, 'lastSync');
});
