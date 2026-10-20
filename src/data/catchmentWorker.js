// Worker « lieu étudié » : à partir d'un lieu cliqué n'importe où en France, repère les cours
// d'eau proches (BD TOPO), délimite le bassin versant amont de chacun et du versant qui domine
// le lieu, et mesure le dénivelé entre le lieu et chaque lit. L'emprise part d'un carré fin
// autour du lieu et s'agrandit (maille plus grossière) tant qu'un bassin touche le bord.

import { LAYERS } from '../config.js';
import { fetchFloatGrid } from './wms.js';
import { fetchRivers, riverCandidates } from './rivers.js';
import { flowModel, snapToStream } from '../sim/model.js';
import { upstreamMask } from '../hydrology/terrain.js';
import { makeGrid, cellOf, cellCenter, toWgs } from '../geo.js';
import { outlineWgs } from './outline.js';

// Demi-côté de l'emprise (m) et maille (m) de chaque étape.
const LEVELS = [
  { half: 2000, dx: 10 },
  { half: 5000, dx: 20 },
  { half: 12000, dx: 40 },
  { half: 30000, dx: 100 },
];
const RIVERS_MAX_HALF = 12000; // au-delà, pas de gravure BD TOPO (trop de tronçons)
const SEARCH_RADIUS = 600; // m : cours d'eau pris en compte autour du lieu

const post = (type, data) => self.postMessage({ type, ...data });

function touchesEdge(mask, nx, ny) {
  for (let i = 0; i < nx; i++) if (mask[i] || mask[(ny - 1) * nx + i]) return true;
  for (let j = 0; j < ny; j++) if (mask[j * nx] || mask[j * nx + nx - 1]) return true;
  return false;
}

function maskBbox(mask, grid) {
  let imin = grid.nx;
  let imax = -1;
  let jmin = grid.ny;
  let jmax = -1;
  for (let j = 0; j < grid.ny; j++)
    for (let i = 0; i < grid.nx; i++)
      if (mask[j * grid.nx + i]) {
        if (i < imin) imin = i;
        if (i > imax) imax = i;
        if (j < jmin) jmin = j;
        if (j > jmax) jmax = j;
      }
  return {
    xmin: grid.xmin + imin * grid.dx,
    xmax: grid.xmin + (imax + 1) * grid.dx,
    ymin: grid.ymax - (jmax + 1) * grid.dx,
    ymax: grid.ymax - jmin * grid.dx,
  };
}

/** Altitude du lit : minimum du MNT brut autour de la maille (le lit est plus étroit qu'elle). */
function bedLevel(dem, grid, k) {
  const i0 = k % grid.nx;
  const j0 = (k - i0) / grid.nx;
  let z = dem[k];
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      const i = i0 + di;
      const j = j0 + dj;
      if (i >= 0 && j >= 0 && i < grid.nx && j < grid.ny) z = Math.min(z, dem[j * grid.nx + i]);
    }
  return z;
}

self.onmessage = async (e) => {
  const { x, y, burnDepth = 1 } = e.data;
  try {
    let cands = null;
    let zHouse = null;
    let active = [];
    for (let l = 0; l < LEVELS.length; l++) {
      const { half, dx } = LEVELS[l];
      post('progress', { level: l, levels: LEVELS.length, sizeKm: (2 * half) / 1000, remaining: active.length });
      const snap = (v) => Math.round(v / dx) * dx;
      const grid = makeGrid({ xmin: snap(x - half), ymin: snap(y - half), xmax: snap(x + half), ymax: snap(y + half) }, dx);
      const warnings = [];
      const demP = fetchFloatGrid(grid, LAYERS.dem, LAYERS.demFallback, { warnings });
      const rivP =
        half <= RIVERS_MAX_HALF
          ? fetchRivers({ xmin: grid.xmin - 200, ymin: grid.ymin - 200, xmax: grid.xmax + 200, ymax: grid.ymax + 200 }).catch(
              () => null,
            )
          : Promise.resolve(null);
      const [dem, rivers] = await Promise.all([demP, rivP]);
      if (!(dem[cellOf(grid, x, y).k] > -1000)) throw new Error('pas de relief disponible ici (hors France ?)');
      const fm = flowModel({ grid, dem, rivers, burnDepth });

      if (l === 0) {
        const hk = cellOf(grid, x, y).k;
        zHouse = dem[hk];
        cands = (rivers ? riverCandidates(rivers, x, y, SEARCH_RADIUS, 5) : []).map((r) => ({
          kind: 'stream',
          name: r.name || "Cours d'eau sans nom",
          named: !!r.name,
          dist: r.d,
          px: r.x,
          py: r.y,
        }));
        // Ruissellement du versant qui domine directement le lieu.
        cands.push({ kind: 'slope', name: 'Ruissellement du versant au-dessus du lieu', named: false, dist: 0, px: x, py: y });
        active = cands;
      }

      for (const c of active) {
        const pt =
          c.kind === 'slope'
            ? { x: c.px, y: c.py, exact: true }
            : l === 0
              ? { x: c.px, y: c.py, radiusM: 30 }
              : { x: c.px, y: c.py, minAreaM2: c.areaM2, radiusM: Math.max(2 * dx, 1.5 * LEVELS[l - 1].dx) };
        const k = snapToStream(grid, fm.acc, pt);
        if (k < 0) {
          c.failed = true;
          continue;
        }
        if (l === 0 && c.kind === 'stream') c.dz = zHouse - bedLevel(dem, grid, k);
        const { mask, cells } = upstreamMask(fm.down, fm.order, k);
        const i0 = k % grid.nx;
        [c.px, c.py] = cellCenter(grid, i0, (k - i0) / grid.nx);
        c.areaM2 = cells * dx * dx;
        c.dx = dx;
        c.complete = !touchesEdge(mask, grid.nx, grid.ny);
        c.bbox = maskBbox(mask, grid);
        c.outline = outlineWgs(mask, grid);
      }
      active = active.filter((c) => !c.failed && !c.complete);
      if (!active.length) break;
    }
    // Deux points calés sur le même lit (deux noms pour un même tracé) : on garde le premier.
    const seen = new Set();
    const out = [];
    for (const c of cands) {
      if (c.failed) continue;
      if (c.kind === 'stream' && c.areaM2 < 1e4) continue; // moins d'1 ha : pas un vrai cours d'eau ici
      const key = `${Math.round(c.px)},${Math.round(c.py)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: c.kind,
        name: c.name,
        named: c.named,
        dist: c.dist,
        dz: c.dz ?? 0,
        areaKm2: c.areaM2 / 1e6,
        complete: c.complete,
        dx: c.dx,
        point: { x: c.px, y: c.py },
        pointWgs: toWgs(c.px, c.py),
        bbox: c.bbox,
        outline: c.outline,
      });
    }
    post('done', { house: { x, y }, houseWgs: toWgs(x, y), zHouse, cands: out });
  } catch (err) {
    post('error', { message: String(err?.message || err) });
  }
};
