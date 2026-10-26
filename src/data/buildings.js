// Bâtiments BD TOPO (IGN) : emprise au sol et hauteur, pour les ajouter au relief (le MNT LiDAR
// est un modèle du sol nu). Format compact : [{ h, rings: [[x, y], …][] }] en Lambert 93.

import { WFS, LAYERS } from '../config.js';
import { cacheGet, cachePut } from './cache.js';
import { fetchWithRetry } from './wms.js';

export const DEFAULT_BUILDING_H = 6; // m, quand la hauteur n'est pas renseignée

export async function fetchBuildings(bbox, { signal } = {}) {
  const b = [bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax].map((v) => Math.round(v));
  const key = `bati:${b.join(',')}`;
  const hit = await cacheGet(key);
  if (hit) return hit;
  const out = [];
  const count = 5000;
  for (let start = 0; start < 200000; start += count) {
    const p = new URLSearchParams({
      SERVICE: 'WFS',
      VERSION: '2.0.0',
      REQUEST: 'GetFeature',
      TYPENAMES: LAYERS.buildings,
      SRSNAME: 'EPSG:2154',
      BBOX: `${b.join(',')},urn:ogc:def:crs:EPSG::2154`,
      OUTPUTFORMAT: 'application/json',
      COUNT: String(count),
      STARTINDEX: String(start),
      PROPERTYNAME: 'geometrie,hauteur',
    });
    const buf = await fetchWithRetry(`${WFS}?${p}`, { signal });
    const json = JSON.parse(new TextDecoder().decode(buf));
    for (const f of json.features) {
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
      const h = Number(f.properties?.hauteur) > 0 ? Number(f.properties.hauteur) : DEFAULT_BUILDING_H;
      for (const poly of polys) out.push({ h, rings: poly.map((ring) => ring.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10])) });
    }
    if (json.features.length < count) break;
  }
  await cachePut(key, out);
  return out;
}
