// Worker « pluies de référence » : pluies journalières observées par les stations Météo-France
// autour du lieu étudié (données climatologiques de base quotidiennes, data.gouv.fr, depuis 1950).
// Fichiers départementaux gzip (~15 Mo) lus en flux ; seules les stations proches sont gardées.
// Résultat : records, épisodes les plus forts, pluies décennale et centennale (loi de Gumbel).

import { cacheGet, cachePut } from './cache.js';

const INDEX_URL = 'https://www.data.gouv.fr/api/1/datasets/donnees-climatologiques-de-base-quotidiennes/';
// Le miroir data.gouv autorise l'accès depuis une page web (CORS), pas l'hébergeur d'origine.
const mirror = (url) => url.replace(/^https:\/\/[^/]+\/data\//, 'https://object.files.data.gouv.fr/meteofrance/data/');

const RADIUS_KM = 25;
const MIN_YEARS = 15;

const post = (type, data) => self.postMessage({ type, ...data });

function distKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

const BASE = 'https://object.files.data.gouv.fr/meteofrance/data/synchro_ftp/BASE/QUOT/';

/** Le fichier existe-t-il sur le miroir ? (requête HEAD, sans téléchargement) */
async function exists(url) {
  try {
    return (await fetch(url, { method: 'HEAD' })).ok;
  } catch {
    return false;
  }
}

/**
 * Adresses des fichiers RR quotidiens (1950-… et récents) d'un département : d'après l'index
 * data.gouv, ou, s'il ne répond pas, en devinant les noms (ils suivent l'année en cours).
 */
async function departmentFiles(dep) {
  let index = await cacheGet('mf-quot-index');
  if (!index || Date.now() - index.t > 7 * 864e5) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(INDEX_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      index = {
        t: Date.now(),
        urls: json.resources.map((r) => r.url).filter((u) => /\/Q_[0-9AB]+_(previous|latest)-[0-9-]+_RR-T-Vent\.csv\.gz$/.test(u)),
      };
      await cachePut('mf-quot-index', index);
    } catch (e) {
      console.warn('Index data.gouv indisponible, noms de fichiers devinés', e);
      index = null;
    }
  }
  if (index) return index.urls.filter((u) => u.includes(`/Q_${dep}_`)).map(mirror);
  const y = new Date().getFullYear();
  for (const Y of [y - 2, y - 1, y - 3]) {
    const prev = `${BASE}Q_${dep}_previous-1950-${Y}_RR-T-Vent.csv.gz`;
    if (!(await exists(prev))) continue;
    const latest = `${BASE}Q_${dep}_latest-${Y + 1}-${Y + 2}_RR-T-Vent.csv.gz`;
    return (await exists(latest)) ? [prev, latest] : [prev];
  }
  return [];
}

/** Lit un fichier départemental et ajoute les pluies des stations proches à `stations`. */
async function readFile(url, lat0, lon0, stations, onBytes) {
  const res = await fetch(url);
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
  let header = null;
  let curId = null;
  let cur = null; // station courante si elle est proche, sinon null
  const handle = (line) => {
    if (!line) return;
    if (!header) {
      header = line.split(';');
      return;
    }
    const s1 = line.indexOf(';');
    const id = line.slice(0, s1);
    if (id !== curId) {
      curId = id;
      const f = line.split(';');
      const lat = Number(f[2]);
      const lon = Number(f[3]);
      const d = distKm(lat0, lon0, lat, lon);
      if (d <= RADIUS_KM) {
        cur = stations.get(id);
        if (!cur) {
          cur = { id, name: f[1], lat, lon, alt: Number(f[4]), d, rr: new Map() };
          stations.set(id, cur);
        }
      } else cur = null;
    }
    if (!cur) return;
    // Champs : NUM_POSTE;NOM_USUEL;LAT;LON;ALTI;AAAAMMJJ;RR;…
    let p = s1;
    for (let k = 0; k < 4; k++) p = line.indexOf(';', p + 1);
    const q = line.indexOf(';', p + 1);
    const r = line.indexOf(';', q + 1);
    const rrTxt = line.slice(q + 1, r);
    if (!rrTxt) return;
    cur.rr.set(line.slice(p + 1, q), Number(rrTxt));
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
}

/** Loi de Gumbel ajustée par les moments sur les maxima annuels ; quantile de période T ans. */
function gumbel(am) {
  const n = am.length;
  const m = am.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(am.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const beta = (sd * Math.sqrt(6)) / Math.PI;
  const mu = m - 0.5772 * beta;
  return (T) => mu - beta * Math.log(-Math.log(1 - 1 / T));
}

function summarize(stations) {
  const out = [];
  for (const s of stations.values()) {
    const years = new Map();
    for (const [day, v] of s.rr) {
      const y = day.slice(0, 4);
      const e = years.get(y) || { n: 0, max: 0 };
      e.n++;
      if (v > e.max) e.max = v;
      years.set(y, e);
    }
    const am = [...years.values()].filter((e) => e.n >= 300).map((e) => e.max);
    let rec = { mm: 0, day: null };
    for (const [day, v] of s.rr) if (v > rec.mm) rec = { mm: v, day };
    const top = [...s.rr].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const st = { name: s.name, d: s.d, alt: s.alt, years: am.length, record: rec, top };
    if (am.length >= MIN_YEARS) {
      const q = gumbel(am);
      st.q10 = q(10);
      st.q100 = q(100);
    }
    out.push(st);
  }
  return out.sort((a, b) => a.d - b.d);
}

self.onmessage = async (e) => {
  const { lat, lon, deps } = e.data;
  try {
    const key = `rainref:${lat.toFixed(2)},${lon.toFixed(2)}`;
    const hit = await cacheGet(key);
    if (hit) {
      post('done', hit);
      return;
    }
    const stations = new Map();
    for (let i = 0; i < deps.length; i++) {
      const files = await departmentFiles(deps[i]);
      if (!files.length) continue;
      for (const url of files) {
        await readFile(url, lat, lon, stations, (got, total) =>
          post('progress', { dep: deps[i], k: i + 1, n: deps.length, mb: got / 1e6, totalMb: total / 1e6 }),
        );
      }
      // Assez de stations solides : inutile de lire les départements voisins.
      const good = summarize(stations).filter((s) => s.q100 != null && s.d <= 20).length;
      if (good >= 3) break;
    }
    const result = { stations: summarize(stations).map(({ top, ...s }) => ({ ...s, top: top.slice(0, 5) })) };
    await cachePut(key, result);
    post('done', result);
  } catch (err) {
    post('error', { message: String(err?.message || err) });
  }
};
