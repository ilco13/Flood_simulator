// Humidité du sol mesurée par satellite et modèle (NASA POWER, réanalyse MERRA-2) : part de
// saturation de la zone des racines (GWETROOT, 0 sec à 1 saturé), par jour, depuis 1981, sur une
// maille d'environ 50 km. Service gratuit, sans clé, accessible depuis une page (CORS).

import { cacheGet, cachePut } from './cache.js';

const API = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const ymd = (d) => d.replaceAll('-', '');

/**
 * Humidité de la zone des racines (0–1) jour par jour entre deux dates (AAAA-MM-JJ).
 * @returns Map date AAAA-MM-JJ → valeur (jours manquants absents)
 */
export async function rootWetness(lon, lat, from, to) {
  const key = `gwet:${lon.toFixed(2)},${lat.toFixed(2)}:${from}:${to}`;
  const hit = await cacheGet(key);
  if (hit) return new Map(hit);
  const q = new URLSearchParams({ parameters: 'GWETROOT', community: 'AG', longitude: lon.toFixed(3), latitude: lat.toFixed(3), start: ymd(from), end: ymd(to), format: 'JSON' });
  let json;
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(`${API}?${q}`);
      if (!res.ok) throw new Error(`NASA POWER HTTP ${res.status}`);
      json = await res.json();
      break;
    } catch (e) {
      if (a === 2) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (a + 1)));
    }
  }
  const out = [];
  for (const [d, v] of Object.entries(json?.properties?.parameter?.GWETROOT || {}))
    if (v >= 0 && v <= 1) out.push([`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, v]);
  // Les jours récents peuvent manquer (données publiées avec quelques jours de retard) : pas de cache
  if (out.length) await cachePut(key, out);
  return new Map(out);
}
