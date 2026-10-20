// Worker « bassin versant d'un point » : à partir d'un point cliqué sur un cours d'eau,
// délimite toute la surface qui s'y écoule. On part d'une petite emprise fine, et on
// l'agrandit (en grossissant la maille) tant que le bassin touche le bord de l'emprise.

import { LAYERS } from '../config.js';
import { fetchFloatGrid } from './wms.js';
import { fetchRivers, nearestRiverPoint } from './rivers.js';
import { prepareTerrain } from '../sim/model.js';
import { makeGrid, cellCenter, toWgs } from '../geo.js';
import { outlineWgs } from './outline.js';

// Demi-côté de l'emprise (m) et maille (m) de chaque étape.
const LEVELS = [
  { half: 2000, dx: 10 },
  { half: 5000, dx: 20 },
  { half: 12000, dx: 40 },
  { half: 30000, dx: 100 },
];
const RIVERS_MAX_HALF = 12000; // au-delà, pas de gravure BD TOPO (trop de tronçons)

const post = (type, data) => self.postMessage({ type, ...data });

function touchesEdge(mask, nx, ny) {
  for (let i = 0; i < nx; i++) if (mask[i] || mask[(ny - 1) * nx + i]) return true;
  for (let j = 0; j < ny; j++) if (mask[j * nx] || mask[j * nx + nx - 1]) return true;
  return false;
}

self.onmessage = async (e) => {
  const { x, y, burnDepth = 1 } = e.data;
  try {
    let areaM2 = 0;
    let px = x;
    let py = y;
    let result = null;
    let river = null;
    for (let l = 0; l < LEVELS.length; l++) {
      const { half, dx } = LEVELS[l];
      post('progress', { level: l, levels: LEVELS.length, sizeKm: (2 * half) / 1000 });
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
      let snapTo;
      if (l === 0) {
        // Clic approximatif : on se cale d'abord sur le tracé BD TOPO le plus proche.
        const near = rivers && nearestRiverPoint(rivers, x, y, 100);
        if (near) {
          px = near.x;
          py = near.y;
          river = near.name;
        }
        snapTo = { x: px, y: py, radiusM: near ? 30 : 60 };
      } else {
        // Même cours d'eau que l'étape précédente, dont le bassin était tronqué.
        snapTo = { x: px, y: py, minAreaM2: areaM2, radiusM: Math.max(2 * dx, 1.5 * LEVELS[l - 1].dx) };
      }
      const t = prepareTerrain({ grid, dem, rivers, burnDepth, upstreamOf: snapTo });
      if (!t.mask) throw new Error('point hors de la zone couverte');
      areaM2 = t.basinCells * dx * dx;
      // Le point calé sur le cours d'eau, réutilisé aux étapes suivantes.
      const i0 = t.outletK % grid.nx;
      const j0 = (t.outletK - i0) / grid.nx;
      [px, py] = cellCenter(grid, i0, j0);
      const edge = touchesEdge(t.mask, grid.nx, grid.ny);
      // Emprise du bassin (Lambert 93).
      let imin = grid.nx;
      let imax = -1;
      let jmin = grid.ny;
      let jmax = -1;
      for (let j = 0; j < grid.ny; j++)
        for (let i = 0; i < grid.nx; i++)
          if (t.mask[j * grid.nx + i]) {
            if (i < imin) imin = i;
            if (i > imax) imax = i;
            if (j < jmin) jmin = j;
            if (j > jmax) jmax = j;
          }
      result = {
        point: { x: px, y: py },
        pointWgs: toWgs(px, py),
        areaKm2: areaM2 / 1e6,
        river,
        dx,
        complete: !edge,
        bbox: {
          xmin: grid.xmin + imin * dx,
          xmax: grid.xmin + (imax + 1) * dx,
          ymin: grid.ymax - (jmax + 1) * dx,
          ymax: grid.ymax - jmin * dx,
        },
        outline: outlineWgs(t.mask, grid),
      };
      if (!edge) break;
    }
    post('done', result);
  } catch (err) {
    post('error', { message: String(err?.message || err) });
  }
};
