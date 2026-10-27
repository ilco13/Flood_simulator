// Worker « épisode réel » : pluies horaires observées par les stations Météo-France proches
// (données climatologiques de base horaires, data.gouv.fr), sur une période donnée.
// Fichiers départementaux gzip par décennie (jusqu'à ~75 Mo), lus en flux : seules les lignes
// des stations proches et de la période sont gardées. Heures en temps universel.

import { cacheGet, cachePut } from './cache.js';
import { yearsOf } from '../hydrology/episode.js';

const INDEX_URL = 'https://www.data.gouv.fr/api/1/datasets/donnees-climatologiques-de-base-horaires/';
const BASE = 'https://object.files.data.gouv.fr/meteofrance/data/synchro_ftp/BASE/HOR/';
const mirror = (url) => url.replace(/^https:\/\/[^/]+\/data\//, 'https://object.files.data.gouv.fr/meteofrance/data/');
const post = (type, data) => self.postMessage({ type, ...data });

function distKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}


async function departmentFiles(dep) {
  let index = await cacheGet('mf-hor-index');
  if (!index || Date.now() - index.t > 7 * 864e5) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(INDEX_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      index = { t: Date.now(), urls: json.resources.map((r) => r.url).filter((u) => /\/H_[0-9AB]+_.*\d{4}-\d{4}\.csv\.gz$/.test(u)) };
      await cachePut('mf-hor-index', index);
    } catch (e) {
      console.warn('Index data.gouv indisponible, noms de fichiers devinés', e);
      index = null;
    }
  }
  if (index) return index.urls.filter((u) => u.includes(`/H_${dep}_`)).map(mirror);
  // Noms devinés (décennies, puis « previous » et « latest », qui suivent l'année en cours) :
  // tous essayés à la lecture, les absents (404) sont simplement ignorés.
  const y = new Date().getFullYear();
  const out = [];
  for (let d = 1950; d < 2020; d += 10) out.push(`${BASE}H_${dep}_${d}-${d + 9}.csv.gz`);
  for (const Y of [y - 1, y - 2, y - 3]) out.push(`${BASE}H_${dep}_previous-2020-${Y}.csv.gz`, `${BASE}H_${dep}_latest-${Y + 1}-${Y + 2}.csv.gz`);
  return out;
}

const stamp = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}`;

async function readFile(url, q, stations, onBytes) {
  let res;
  for (let a = 0; a < 3; a++) {
    try {
      res = await fetch(url);
      break;
    } catch (e) {
      if (a === 2) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (a + 1)));
    }
  }
  if (res.status === 404) return false; // nom deviné qui n'existe pas
  if (!res.ok) throw new Error(`Météo-France HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const counted = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, ctrl) {
        got += chunk.length;
        onBytes(got, total);
        ctrl.enqueue(chunk);
      },
    }),
  );
  const reader = counted.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  let header = true;
  let curId = null;
  let cur = null;
  const handle = (line) => {
    if (!line) return;
    if (header) {
      header = false;
      return;
    }
    const s1 = line.indexOf(';');
    const id = line.slice(0, s1);
    if (id !== curId) {
      curId = id;
      const f = line.split(';', 6);
      const lat = Number(f[2]);
      const lon = Number(f[3]);
      const d = distKm(q.lat, q.lon, lat, lon);
      if (d <= q.radiusKm) {
        cur = stations.get(id);
        if (!cur) {
          cur = { id, name: f[1], lat, lon, alt: Number(f[4]), d, rr: new Float32Array(q.hours).fill(NaN) };
          stations.set(id, cur);
        }
      } else cur = null;
    }
    if (!cur) return;
    // NUM_POSTE;NOM_USUEL;LAT;LON;ALTI;AAAAMMJJHH;RR1;…
    let p = s1;
    for (let k = 0; k < 4; k++) p = line.indexOf(';', p + 1);
    const p2 = line.indexOf(';', p + 1);
    const when = line.slice(p + 1, p2);
    if (when < q.from || when > q.to) return;
    const p3 = line.indexOf(';', p2 + 1);
    const rr = line.slice(p2 + 1, p3);
    if (rr === '') return;
    const t = Date.UTC(+when.slice(0, 4), +when.slice(4, 6) - 1, +when.slice(6, 8), +when.slice(8, 10));
    // RR1 de l'heure HH = pluie tombée entre HH-1 et HH : rangée dans l'heure qui finit à HH
    const k = Math.round((t - q.t0) / 3600e3) - 1;
    if (k >= 0 && k < q.hours) cur.rr[k] = Number(rr);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = rest + value;
    let start = 0;
    let nl;
    while ((nl = text.indexOf('\n', start)) >= 0) {
      handle(text.slice(start, nl).replace(/\r$/, ''));
      start = nl + 1;
    }
    rest = text.slice(start);
  }
  handle(rest);
  return true;
}

/**
 * Message : { lat, lon, deps, t0 (ms, début en TU, heure ronde), hours, radiusKm }.
 * Réponse : { stations: [{ id, name, lat, lon, alt, d, rr: Float32Array (mm par heure, NaN = manquant) }] }
 */
self.onmessage = async (e) => {
  const { lat, lon, deps, t0, hours, radiusKm = 25 } = e.data;
  try {
    const key = `episode:${lat.toFixed(2)},${lon.toFixed(2)}:${t0}:${hours}:${radiusKm}`;
    const hit = await cacheGet(key);
    if (hit) {
      post('done', hit);
      return;
    }
    const q = { lat, lon, radiusKm, t0, hours, from: stamp(new Date(t0)), to: stamp(new Date(t0 + hours * 3600e3)) };
    const y0 = new Date(t0).getUTCFullYear();
    const y1 = new Date(t0 + hours * 3600e3).getUTCFullYear();
    const stations = new Map();
    for (let i = 0; i < deps.length; i++) {
      const files = (await departmentFiles(deps[i])).filter((u) => {
        const ys = yearsOf(u);
        return ys && ys[1] >= y0 && ys[0] <= y1;
      });
      // Années couvertes par un fichier déjà lu (les noms devinés peuvent se recouvrir)
      const done = [];
      for (const url of files) {
        const ys = yearsOf(url);
        if (done.some(([a, b]) => a <= Math.max(ys[0], y0) && b >= Math.min(ys[1], y1))) continue;
        try {
          if (await readFile(url, q, stations, (got, total) => post('progress', { dep: deps[i], k: i + 1, n: deps.length, mb: got / 1e6, totalMb: total / 1e6 }))) done.push(ys);
        } catch (err) {
          console.warn('Fichier Météo-France illisible', url, err);
        }
      }
      // Tous les départements voisins sont lus : un bassin à cheval sur deux départements a
      // souvent ses stations les plus utiles de l'autre côté (et certaines stations proches ont
      // des trous pendant l'épisode).
    }
    const out = { stations: [...stations.values()].filter((s) => s.rr.some((v) => v >= 0)).sort((a, b) => a.d - b.d) };
    await cachePut(key, out);
    post('done', out);
  } catch (err) {
    post('error', { message: String(err?.message || err) });
  }
};
