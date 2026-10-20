// Enregistrement des simulations terminées : dans le navigateur (IndexedDB) et en fichier
// « .crue » pour les transférer d'un ordinateur à l'autre.
//
// Tous les gros tableaux sont compressés (deflate). Le relief est stocké en décimètres
// (Uint16), largement suffisant pour l'affichage et la sonde.

import { compress, decompress } from '../sim/snapshots.js';

const DB_NAME = 'flood-sim-runs';
const VERSION = 1;
const MAGIC = 'CRUE1';

let dbP = null;
function db() {
  if (dbP) return dbP;
  dbP = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('meta', { keyPath: 'id' });
      req.result.createObjectStore('payload');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbP;
}

function tx(stores, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(stores, mode);
        const out = fn(t);
        t.oncomplete = () => resolve(out?.result ?? out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Enregistrement annulé (espace disque ?)'));
      }),
  );
}

const toBlob = (x) => (x instanceof Blob ? x : new Blob([x]));

async function packFloat(arr) {
  return toBlob(await compress(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)));
}
async function unpackFloat(blob) {
  const u8 = await decompress(blob);
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}
async function packDem(dem) {
  const u = new Uint16Array(dem.length);
  for (let k = 0; k < dem.length; k++) {
    const z = dem[k];
    u[k] = z > -500 ? Math.min(65535, Math.round((z + 500) * 10)) : 0;
  }
  return toBlob(await compress(new Uint8Array(u.buffer)));
}
async function unpackDem(blob) {
  const u8 = await decompress(blob);
  const u = new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength / 2);
  const z = new Float32Array(u.length);
  for (let k = 0; k < u.length; k++) z[k] = u[k] / 10 - 500;
  return z;
}

/**
 * Prépare un enregistrement à partir d'une simulation terminée.
 * @returns {{ meta, payload }} meta = petit résumé listable ; payload = données lourdes (Blobs)
 */
export async function packRun({ name, params, grid, totalTime, tEnd, store, series, gauges, maxima, dem, zSim, outline, rivers, summary, warnings }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const snaps = store.items.map((it) => ({ t: it.t, blob: toBlob(it.data) }));
  const payload = {
    snaps,
    hmax: await packFloat(maxima.hmax),
    tmax: await packFloat(maxima.tmax),
    vmax: await packFloat(maxima.vmax),
    dem: await packDem(dem),
    // Terrain de la simulation (vallats gravés, cuvettes ouvertes) : sert aux coupes.
    zsim: zSim ? await packDem(zSim) : null,
    json: {
      series,
      gauges: gauges.map((g) => ({ id: g.id, name: g.name, lineWgs: g.lineWgs })),
      outline,
      rivers,
      summary,
      warnings,
    },
  };
  let size = payload.hmax.size + payload.tmax.size + payload.vmax.size + payload.dem.size + (payload.zsim?.size || 0);
  for (const s of snaps) size += s.blob.size;
  const meta = {
    id,
    name,
    created: new Date().toISOString(),
    params,
    grid,
    totalTime,
    tEnd,
    size,
    format: MAGIC,
  };
  return { meta, payload };
}

export async function saveRun(rec) {
  await tx(['meta', 'payload'], 'readwrite', (t) => {
    t.objectStore('meta').put(rec.meta);
    t.objectStore('payload').put(rec.payload, rec.meta.id);
  });
  return rec.meta;
}

export async function listRuns() {
  const all = await tx(['meta'], 'readonly', (t) => t.objectStore('meta').getAll());
  return all.sort((a, b) => (a.created < b.created ? 1 : -1));
}

export async function deleteRun(id) {
  await tx(['meta', 'payload'], 'readwrite', (t) => {
    t.objectStore('meta').delete(id);
    t.objectStore('payload').delete(id);
  });
}

export async function renameRun(id, name) {
  const meta = await tx(['meta'], 'readonly', (t) => t.objectStore('meta').get(id));
  if (!meta) return;
  meta.name = name;
  await tx(['meta'], 'readwrite', (t) => t.objectStore('meta').put(meta));
}

/** Recharge une simulation : tableaux décompressés prêts pour l'affichage. */
export async function loadRun(id) {
  const [meta, payload] = await Promise.all([
    tx(['meta'], 'readonly', (t) => t.objectStore('meta').get(id)),
    tx(['payload'], 'readonly', (t) => t.objectStore('payload').get(id)),
  ]);
  if (!meta || !payload) throw new Error('Simulation introuvable');
  return {
    meta,
    snaps: payload.snaps,
    maxima: {
      hmax: await unpackFloat(payload.hmax),
      tmax: await unpackFloat(payload.tmax),
      vmax: await unpackFloat(payload.vmax),
    },
    dem: await unpackDem(payload.dem),
    z: payload.zsim ? await unpackDem(payload.zsim) : null,
    ...payload.json,
  };
}

/* ---------- Fichier .crue ----------
 * [5 octets « CRUE1 »][uint32 longueur de l'en-tête JSON][en-tête JSON][blocs binaires…]
 * L'en-tête donne meta, les données JSON et la taille de chaque bloc, dans l'ordre.
 */

export async function exportRun(id) {
  const [meta, payload] = await Promise.all([
    tx(['meta'], 'readonly', (t) => t.objectStore('meta').get(id)),
    tx(['payload'], 'readonly', (t) => t.objectStore('payload').get(id)),
  ]);
  const named = [
    ['hmax', payload.hmax],
    ['tmax', payload.tmax],
    ['vmax', payload.vmax],
    ['dem', payload.dem],
    ...(payload.zsim ? [['zsim', payload.zsim]] : []),
  ];
  const blobs = [...named.map((x) => x[1]), ...payload.snaps.map((s) => s.blob)];
  const header = {
    meta,
    json: payload.json,
    parts: named.map((x) => x[0]),
    snapTimes: payload.snaps.map((s) => s.t),
    sizes: blobs.map((b) => b.size),
  };
  const head = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length, true);
  return new Blob([MAGIC, len, head, ...blobs], { type: 'application/octet-stream' });
}

export async function importRun(file) {
  const buf = await file.arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 5));
  if (magic !== MAGIC) throw new Error("Ce fichier n'est pas une simulation « Crue de l'Arc » (.crue)");
  const hl = new DataView(buf, 5, 4).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 9, hl)));
  let off = 9 + hl;
  const blobs = header.sizes.map((n) => {
    const b = new Blob([buf.slice(off, off + n)]);
    off += n;
    return b;
  });
  const parts = header.parts || ['hmax', 'tmax', 'vmax', 'dem'];
  const named = Object.fromEntries(parts.map((name, i) => [name, blobs[i]]));
  const snapBlobs = blobs.slice(parts.length);
  const meta = { ...header.meta, id: `${Date.now().toString(36)}-imp`, imported: true };
  const payload = {
    hmax: named.hmax,
    tmax: named.tmax,
    vmax: named.vmax,
    dem: named.dem,
    zsim: named.zsim || null,
    snaps: header.snapTimes.map((t, i) => ({ t, blob: snapBlobs[i] })),
    json: header.json,
  };
  return saveRun({ meta, payload });
}

export function formatSize(bytes) {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} ko`;
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0).replace('.', ',')} Mo`;
}
