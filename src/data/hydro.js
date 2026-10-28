// Débits mesurés des rivières (Hub'Eau hydrométrie, service public, accès libre depuis une page) :
// stations proches, crues passées (débit maximal instantané de chaque jour, depuis les années
// 1970 selon les stations), débits d'un épisode ; lecture d'un export HydroPortail (CSV).

import { cacheGet, cachePut } from './cache.js';
import { MIN_STATION_YEARS, annualMaxima, gumbelQuantiles } from '../hydrology/flood.js';

const API = 'https://hubeau.eaufrance.fr/api/v2/hydrometrie';

async function getJson(url) {
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url);
      if (!res.ok && res.status !== 206) throw new Error(`Hub'Eau HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
    }
  }
  throw last;
}

/**
 * Stations hydrométriques dans une emprise (WGS84), avec la surface de leur bassin.
 * @returns [{ code, site, name, river, lon, lat, x, y, areaKm2, open }]
 */
export async function stationsIn({ west, south, east, north }) {
  const p = new URLSearchParams({
    bbox: `${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)}`,
    format: 'json',
    size: '200',
    fields: 'code_station,code_site,libelle_station,libelle_cours_eau,longitude_station,latitude_station,coordonnee_x_station,coordonnee_y_station,en_service',
  });
  const st = (await getJson(`${API}/referentiel/stations?${p}`)).data || [];
  if (!st.length) return [];
  const codes = [...new Set(st.map((s) => s.code_site))];
  const sites = new Map();
  for (let i = 0; i < codes.length; i += 50) {
    const q = new URLSearchParams({ code_site: codes.slice(i, i + 50).join(','), format: 'json', size: '200', fields: 'code_site,surface_bv' });
    for (const s of (await getJson(`${API}/referentiel/sites?${q}`)).data || []) sites.set(s.code_site, s.surface_bv);
  }
  return st.map((s) => ({
    code: s.code_station,
    site: s.code_site,
    name: s.libelle_station,
    river: s.libelle_cours_eau,
    lon: s.longitude_station,
    lat: s.latitude_station,
    x: s.coordonnee_x_station,
    y: s.coordonnee_y_station,
    areaKm2: sites.get(s.code_site) || null,
    open: !!s.en_service,
  }));
}

/** Débit maximal instantané de chaque jour (m³/s) depuis `since` (AAAA-MM-JJ). */
export async function dailyMax(code, since = '1990-01-01') {
  const key = `hubeau:qix:${code}:${since}`;
  const hit = await cacheGet(key);
  if (hit && Date.now() - hit.t < 7 * 864e5) return hit.days;
  const days = [];
  let url = `${API}/obs_elab?${new URLSearchParams({ code_entite: code, grandeur_hydro_elab: 'QIXnJ', date_debut_obs_elab: since, size: '20000', fields: 'date_obs_elab,resultat_obs_elab' })}`;
  for (let page = 0; url && page < 5; page++) {
    const j = await getJson(url);
    for (const r of j.data || []) if (r.resultat_obs_elab != null) days.push([r.date_obs_elab, r.resultat_obs_elab / 1000]);
    url = j.next || null;
  }
  days.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  await cachePut(key, { t: Date.now(), days });
  return days;
}

const normName = (t) =>
  String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^(l'|la |le |les )/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Même cours d'eau (noms BD TOPO et Hub'Eau écrits différemment : « L'Arc », « Arc »). */
export function sameRiver(a, b) {
  const x = normName(a);
  const y = normName(b);
  return !!x && !!y && (x === y || x.endsWith(` ${y}`) || y.endsWith(` ${x}`));
}

/**
 * Crues décennale et centennale d'une station d'après ses maxima annuels mesurés (Gumbel), ou
 * null s'il y a moins de MIN_STATION_YEARS années complètes.
 */
export async function stationFloods(code) {
  const ann = annualMaxima(await dailyMax(code, '1950-01-01'));
  if (ann.length < MIN_STATION_YEARS) return null;
  const g = gumbelQuantiles(ann.map((e) => e.q));
  const top = ann.reduce((a, b) => (b.q > a.q ? b : a));
  return { ...g, years: ann.length, first: ann[0].year, last: ann.at(-1).year + 1, maxQ: top.q, maxYear: top.year };
}

/** Plus fortes crues : maxima journaliers les plus élevés, à au moins `gapDays` jours d'écart. */
export function topFloods(days, n = 8, gapDays = 5) {
  const sorted = [...days].sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const d of sorted) {
    const t = Date.parse(d[0]);
    if (out.some((o) => Math.abs(Date.parse(o.date) - t) < gapDays * 864e5)) continue;
    out.push({ date: d[0], q: d[1] });
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Débits d'un épisode : maximum et moyenne de chaque jour (m³/s) ; et, s'il date de moins d'un
 * mois, la courbe complète (mesures toutes les 5 à 60 min) des données « temps réel ».
 */
export async function episodeFlows(code, day0, day1) {
  const daily = new Map();
  for (const [g, field] of [['QIXnJ', 'max'], ['QmnJ', 'mean']]) {
    const q = new URLSearchParams({ code_entite: code, grandeur_hydro_elab: g, date_debut_obs_elab: day0, date_fin_obs_elab: day1, size: '100', fields: 'date_obs_elab,resultat_obs_elab' });
    for (const r of (await getJson(`${API}/obs_elab?${q}`)).data || []) {
      const d = daily.get(r.date_obs_elab) || { date: r.date_obs_elab };
      d[field] = r.resultat_obs_elab / 1000;
      daily.set(r.date_obs_elab, d);
    }
  }
  let curve = null;
  if (Date.now() - Date.parse(day0) < 29 * 864e5) {
    try {
      const q = new URLSearchParams({ code_entite: code, grandeur_hydro: 'Q', date_debut_obs: `${day0}T00:00:00Z`, date_fin_obs: `${day1}T23:59:59Z`, size: '20000', sort: 'asc', fields: 'date_obs,resultat_obs' });
      const j = await getJson(`${API}/observations_tr?${q}`);
      curve = (j.data || []).map((r) => [Date.parse(r.date_obs), r.resultat_obs / 1000]);
      if (!curve.length) curve = null;
    } catch {
      curve = null;
    }
  }
  return { daily: [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), curve };
}

/**
 * Export de débits (HydroPortail ou autre tableur) : première colonne date-heure, deuxième le
 * débit ; en l/s si l'en-tête le dit, sinon m³/s. Renvoie [[t (ms TU), Q m³/s]].
 */
export function parseFlowCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = [';', '\t', ','].find((c) => lines[0].includes(c)) || ';';
  const litres = /l\/s|litre/i.test(lines.slice(0, 3).join(' '));
  const out = [];
  for (const l of lines) {
    const f = l.split(sep).map((x) => x.trim().replace(/^"|"$/g, ''));
    if (f.length < 2) continue;
    let s = f[0];
    // 23/11/2019 14:30 → 2019-11-23T14:30
    const m = /^(\d{2})\/(\d{2})\/(\d{4})[ T]?(\d{2}:\d{2}(:\d{2})?)?/.exec(s);
    if (m) s = `${m[3]}-${m[2]}-${m[1]}T${m[4] || '00:00'}`;
    const t = Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
    const q = Number(f[1].replace(',', '.'));
    if (!Number.isFinite(t) || !Number.isFinite(q)) continue;
    out.push([t, litres ? q / 1000 : q]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
