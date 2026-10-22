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

/** Point le plus proche sur un cours d'eau gravable, à moins de `maxDist` m (ou null). */
export function nearestRiverPoint(rivers, x, y, maxDist) {
  let best = null;
  for (const f of rivers.features) {
    if (!isBurnable(f)) continue;
    for (const part of lineParts(f.geometry)) {
      for (let s = 0; s < part.length - 1; s++) {
        const [x0, y0] = part[s];
        const [x1, y1] = part[s + 1];
        const vx = x1 - x0;
        const vy = y1 - y0;
        const L2 = vx * vx + vy * vy;
        const t = L2 ? Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / L2)) : 0;
        const px = x0 + t * vx;
        const py = y0 + t * vy;
        const d = Math.hypot(px - x, py - y);
        if (d <= maxDist && (!best || d < best.d)) best = { d, x: px, y: py, name: f.properties.name };
      }
    }
  }
  return best;
}

/**
 * Cours d'eau proches d'un point : pour chaque cours d'eau nommé (et pour le tronçon sans
 * nom le plus proche), le point de son tracé le plus proche. Triés par distance.
 */
export function riverCandidates(rivers, x, y, maxDist, max = 5) {
  const best = new Map();
  for (const f of rivers.features) {
    // Les rivières larges sont représentées par un axe « fictif » dans leur surface en eau :
    // on les garde ici (mais pas pour la gravure du relief).
    const pr = f.properties;
    const natural = pr.nature === 'Ecoulement naturel' || pr.nature === 'Ecoulement canalisé';
    if (pr.underground || !(isBurnable(f) || (pr.fictif && natural && pr.name))) continue;
    if (pr.name && /canal/i.test(pr.name)) continue;
    const key = pr.name || '';
    for (const part of lineParts(f.geometry)) {
      for (let s = 0; s < part.length - 1; s++) {
        const [x0, y0] = part[s];
        const [x1, y1] = part[s + 1];
        const vx = x1 - x0;
        const vy = y1 - y0;
        const L2 = vx * vx + vy * vy;
        const t = L2 ? Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / L2)) : 0;
        const px = x0 + t * vx;
        const py = y0 + t * vy;
        const d = Math.hypot(px - x, py - y);
        if (d > maxDist) continue;
        const cur = best.get(key);
        if (!cur || d < cur.d) best.set(key, { d, x: px, y: py, name: f.properties.name || null });
      }
    }
  }
  const out = [...best.values()].sort((a, b) => a.d - b.d).slice(0, max);
  // Points du tracé de chaque cours d'eau à moins de 120 m du point retenu (tous les 5 m) :
  // ils servent à caler le candidat sur le vrai lit, même si le tracé est un peu décalé.
  for (const c of out) {
    c.trace = [];
    for (const f of rivers.features) {
      const pr = f.properties;
      if ((pr.name || '') !== (c.name || '') || pr.underground) continue;
      for (const part of lineParts(f.geometry))
        for (let s = 0; s < part.length - 1; s++) {
          const [x0, y0] = part[s];
          const [x1, y1] = part[s + 1];
          const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 5));
          for (let k = 0; k <= n; k++) {
            const px = x0 + ((x1 - x0) * k) / n;
            const py = y0 + ((y1 - y0) * k) / n;
            if (Math.hypot(px - c.x, py - c.y) <= 120) c.trace.push([px, py]);
          }
        }
    }
  }
  return out;
}

function lineParts(geom) {
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}

/**
 * Mailles traversées par une polyligne, dans l'ordre, reliées par un côté (chemin 4-connexe :
 * l'eau du modèle ne passe que par les côtés des mailles, jamais par un coin).
 * Parcours exact de la grille (Amanatides & Woo) ; les mailles hors grille sont ignorées.
 */
export function rasterizeLine(grid, coords, visit) {
  const { xmin, ymax, dx, nx, ny } = grid;
  let last = -1;
  const emit = (i, j) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return;
    const k = j * nx + i;
    if (k !== last) {
      visit(k, i, j);
      last = k;
    }
  };
  for (let s = 0; s < coords.length - 1; s++) {
    const gx0 = (coords[s][0] - xmin) / dx;
    const gy0 = (ymax - coords[s][1]) / dx;
    const gx1 = (coords[s + 1][0] - xmin) / dx;
    const gy1 = (ymax - coords[s + 1][1]) / dx;
    let i = Math.floor(gx0);
    let j = Math.floor(gy0);
    const i1 = Math.floor(gx1);
    const j1 = Math.floor(gy1);
    const ddx = gx1 - gx0;
    const ddy = gy1 - gy0;
    const si = Math.sign(ddx);
    const sj = Math.sign(ddy);
    const tdx = si ? Math.abs(1 / ddx) : Infinity;
    const tdy = sj ? Math.abs(1 / ddy) : Infinity;
    let tx = si > 0 ? (i + 1 - gx0) * tdx : si < 0 ? (gx0 - i) * tdx : Infinity;
    let ty = sj > 0 ? (j + 1 - gy0) * tdy : sj < 0 ? (gy0 - j) * tdy : Infinity;
    emit(i, j);
    let guard = Math.abs(i1 - i) + Math.abs(j1 - j) + 2;
    while ((i !== i1 || j !== j1) && guard-- > 0) {
      if (tx < ty) {
        i += si;
        tx += tdx;
      } else {
        j += sj;
        ty += tdy;
      }
      emit(i, j);
    }
  }
}

/**
 * Grave le réseau hydrographique dans le MNT : chaque maille du lit est abaissée au minimum
 * de son voisinage 3×3 moins `depth`. Cela rétablit la continuité des petits vallats que la
 * maille de calcul ne résout pas, et le passage sous les remblais (buses, ponts).
 */
export function burnRivers(grid, z, rivers, depth, maxCarve = MAX_CARVE) {
  const z0 = z.slice();
  const { nx, ny } = grid;
  let count = 0;
  const paths = [];
  for (const f of rivers.features) {
    // Axes « fictifs » des rivières larges et des plans d'eau : pas de gravure locale (la surface
    // en eau est déjà dans le relief) mais pente continue imposée, pour relier l'amont à l'aval
    // à travers ponts, seuils et digues percées d'un ouvrage.
    const pr = f.properties;
    const axis = pr.fictif && !pr.underground && pr.nature === 'Ecoulement naturel' && !(pr.name && /canal/i.test(pr.name));
    if (!isBurnable(f) && !axis) continue;
    for (const part of lineParts(f.geometry)) {
      const path = [];
      rasterizeLine(grid, part, (k, i, j) => {
        path.push(k);
        if (axis) return;
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
      if (path.length < 2) continue;
      // Sens d'écoulement : altitudes BD TOPO (3e coordonnée) ou, à défaut, relief aux extrémités.
      const za = part[0][2];
      const zb = part[part.length - 1][2];
      const up = Number.isFinite(za) && Number.isFinite(zb) && za !== zb ? za > zb : z0[path[0]] >= z0[path[path.length - 1]];
      if (!up) path.reverse();
      paths.push(path);
    }
  }
  count += enforceDownstream(grid, z, paths, maxCarve);
  return count;
}

// Au-delà, l'obstacle est sans doute un vrai barrage (retenue) : on ne le creuse pas.
const MAX_CARVE = 15;

/**
 * Pente continue vers l'aval le long du réseau : le MNT garde souvent les ponts et les remblais
 * percés d'une buse comme un barrage (tablier interpolé). Chaque tronçon est parcouru de l'amont
 * vers l'aval (les plus hauts d'abord) et une maille plus haute que la précédente est abaissée
 * à son niveau ; un tronçon démarre au niveau du tronçon amont déjà traité qui le touche.
 */
function enforceDownstream(grid, z, paths, maxCarve) {
  const { nx, ny } = grid;
  const done = new Uint8Array(nx * ny);
  let count = 0;
  paths.sort((a, b) => z[b[0]] - z[a[0]]);
  for (const path of paths) {
    const k0 = path[0];
    const i0 = k0 % nx;
    const j0 = (k0 - i0) / nx;
    let level = z[k0];
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const ii = i0 + di;
        const jj = j0 + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const kk = jj * nx + ii;
        if (done[kk] && z[kk] < level) level = z[kk];
      }
    for (const k of path) {
      if (z[k] > level) {
        if (z[k] - level <= maxCarve) {
          z[k] = level;
          count++;
        } else level = z[k];
      } else level = z[k];
      done[k] = 1;
    }
  }
  return count;
}

/**
 * Direction moyenne (vecteur unitaire, Lambert 93) du cours d'eau nommé autour d'un point :
 * axe principal des sommets situés à moins de `radius` m du point le plus proche du tracé.
 * Plus robuste que le seul tronçon le plus proche dans un méandre.
 */
export function riverDirectionAt(rivers, x, y, name, radius = 250) {
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
        if (!best || d < best.d) best = { d, px: x0 + t * vx, py: y0 + t * vy, ux: vx, uy: vy };
      }
    }
  }
  if (!best) return null;
  // Points du tracé proches, échantillonnés tous les ~10 m
  const pts = [];
  for (const f of rivers.features) {
    if (name && f.properties.name !== name) continue;
    for (const part of lineParts(f.geometry)) {
      for (let s = 0; s < part.length - 1; s++) {
        const [x0, y0] = part[s];
        const [x1, y1] = part[s + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 10));
        for (let k = 0; k < n; k++) {
          const px = x0 + ((x1 - x0) * k) / n;
          const py = y0 + ((y1 - y0) * k) / n;
          if (Math.hypot(px - best.px, py - best.py) <= radius) pts.push([px, py]);
        }
      }
    }
  }
  let ux = best.ux;
  let uy = best.uy;
  if (pts.length >= 3) {
    let mx = 0;
    let my = 0;
    for (const [px, py] of pts) {
      mx += px;
      my += py;
    }
    mx /= pts.length;
    my /= pts.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const [px, py] of pts) {
      sxx += (px - mx) ** 2;
      syy += (py - my) ** 2;
      sxy += (px - mx) * (py - my);
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    ux = Math.cos(angle);
    uy = Math.sin(angle);
  }
  const L = Math.hypot(ux, uy);
  return { d: best.d, ux: ux / L, uy: uy / L, px: best.px, py: best.py };
}
