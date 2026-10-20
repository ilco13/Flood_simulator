import { WFS, LAYERS } from '../config.js';
import { cacheGet, cachePut } from './cache.js';
import { fetchWithRetry } from './wms.js';

const PROPS = 'geometrie,cpx_toponyme_de_cours_d_eau,nature,persistance,position_par_rapport_au_sol,fictif';

/** Tronçons hydrographiques BD TOPO (GeoJSON en Lambert 93) dans l'emprise. */
export async function fetchRivers(bbox, { signal } = {}) {
  const key = `rivers:${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`;
  const hit = await cacheGet(key);
  if (hit) return hit;
  const features = [];
  const count = 5000;
  for (let start = 0; start < 100000; start += count) {
    const p = new URLSearchParams({
      SERVICE: 'WFS',
      VERSION: '2.0.0',
      REQUEST: 'GetFeature',
      TYPENAMES: LAYERS.rivers,
      SRSNAME: 'EPSG:2154',
      BBOX: `${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax},urn:ogc:def:crs:EPSG::2154`,
      OUTPUTFORMAT: 'application/json',
      COUNT: String(count),
      STARTINDEX: String(start),
      PROPERTYNAME: PROPS,
    });
    const buf = await fetchWithRetry(`${WFS}?${p}`, { signal });
    const json = JSON.parse(new TextDecoder().decode(buf));
    for (const f of json.features) {
      if (!f.geometry) continue;
      const pr = f.properties;
      features.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          name: pr.cpx_toponyme_de_cours_d_eau || null,
          nature: pr.nature,
          permanent: pr.persistance === 'Permanent',
          underground: pr.position_par_rapport_au_sol === '-1',
          fictif: !!pr.fictif,
        },
      });
    }
    if (json.features.length < count) break;
  }
  const fc = { type: 'FeatureCollection', features };
  await cachePut(key, fc);
  return fc;
}

/** Tronçons à graver dans le MNT : écoulements naturels et buses, pas les canaux. */
export function isBurnable(f) {
  const n = f.properties.nature;
  if (f.properties.fictif) return false;
  if (f.properties.name && /canal/i.test(f.properties.name)) return false;
  return n === 'Ecoulement naturel' || n === 'Conduit buse' || n === 'Ecoulement canalisé';
}

function lineParts(geom) {
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}

/** Liste des mailles traversées par une polyligne (pas de dx/2). */
export function rasterizeLine(grid, coords, visit) {
  const step = grid.dx / 2;
  let last = -1;
  for (let s = 0; s < coords.length - 1; s++) {
    const [x0, y0] = coords[s];
    const [x1, y1] = coords[s + 1];
    const L = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(L / step));
    for (let t = 0; t <= n; t++) {
      const x = x0 + ((x1 - x0) * t) / n;
      const y = y0 + ((y1 - y0) * t) / n;
      const i = Math.floor((x - grid.xmin) / grid.dx);
      const j = Math.floor((grid.ymax - y) / grid.dx);
      if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
      const k = j * grid.nx + i;
      if (k !== last) {
        visit(k, i, j);
        last = k;
      }
    }
  }
}

/**
 * Grave le réseau hydrographique dans le MNT : chaque maille du lit est abaissée au minimum
 * de son voisinage 3×3 moins `depth`. Cela rétablit la continuité des petits vallats que la
 * maille de calcul ne résout pas, et le passage sous les remblais (buses, ponts).
 */
export function burnRivers(grid, z, rivers, depth) {
  const z0 = z.slice();
  const { nx, ny } = grid;
  let count = 0;
  for (const f of rivers.features) {
    if (!isBurnable(f)) continue;
    for (const part of lineParts(f.geometry)) {
      rasterizeLine(grid, part, (k, i, j) => {
        let m = z0[k];
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= nx) continue;
            const v = z0[jj * nx + ii];
            if (v < m) m = v;
          }
        }
        const target = m - depth;
        if (target < z[k]) {
          z[k] = target;
          count++;
        }
      });
    }
  }
  return count;
}

/** Direction locale (vecteur unitaire, Lambert 93) du cours d'eau nommé le plus proche. */
export function riverDirectionAt(rivers, x, y, name) {
  let best = null;
  for (const f of rivers.features) {
    if (name && f.properties.name !== name) continue;
    for (const part of lineParts(f.geometry)) {
      for (let s = 0; s < part.length - 1; s++) {
        const [x0, y0] = part[s];
        const [x1, y1] = part[s + 1];
        const vx = x1 - x0;
        const vy = y1 - y0;
        const L2 = vx * vx + vy * vy;
        if (L2 === 0) continue;
        const t = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / L2));
        const d = Math.hypot(x0 + t * vx - x, y0 + t * vy - y);
        if (!best || d < best.d) {
          const L = Math.sqrt(L2);
          best = { d, ux: vx / L, uy: vy / L, px: x0 + t * vx, py: y0 + t * vy };
        }
      }
    }
  }
  return best;
}
