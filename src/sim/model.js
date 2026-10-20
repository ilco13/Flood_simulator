// Préparation des entrées du modèle à partir des données brutes.

import { burnRivers, riverDirectionAt, rasterizeLine } from '../data/rivers.js';
import { drainageLabels, basinMask } from '../hydrology/terrain.js';
import { buildRunoffFields } from '../hydrology/scs.js';
import { cellOf } from '../geo.js';

/**
 * Prétraitements indépendants de la pluie : gravure du réseau, bassin versant.
 * @returns {{ z: Float32Array, mask: Uint8Array, basinCells: number, burned: number, breached: number }}
 */
export function prepareTerrain({ grid, dem, rivers, burnDepth, outlet }) {
  const z = dem.slice();
  const burned = rivers && burnDepth > 0 ? burnRivers(grid, z, rivers, burnDepth) : 0;
  const { label, breached } = drainageLabels(z, grid.nx, grid.ny, {
    maxDepth: Math.max(2, 0.3 * grid.dx),
    maxLength: Math.max(4, Math.round(300 / grid.dx)),
  });
  let mask = null;
  let basinCells = grid.nx * grid.ny;
  const c = outlet && cellOf(grid, outlet.x, outlet.y);
  if (c) {
    // L'exutoire est sur l'Arc : on prend la maille de plus faible altitude autour du point
    // pour être sûr d'être dans le lit.
    let best = c.k;
    for (let dj = -3; dj <= 3; dj++)
      for (let di = -3; di <= 3; di++) {
        const i = c.i + di;
        const j = c.j + dj;
        if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
        const k = j * grid.nx + i;
        if (z[k] < z[best]) best = k;
      }
    const r = basinMask(label, best);
    mask = r.mask;
    basinCells = r.cells;
  }
  return { z, mask, basinCells, burned, breached };
}

/** Sections transversales de mesure du débit. */
export function buildGauges(grid, rivers, gaugeDefs) {
  const out = [];
  for (const g of gaugeDefs) {
    const dir = rivers ? riverDirectionAt(rivers, g.x, g.y, g.river) : null;
    const ux = dir ? dir.ux : 1;
    const uy = dir ? dir.uy : 0;
    const cx = dir ? dir.px : g.x;
    const cy = dir ? dir.py : g.y;
    // Ligne perpendiculaire au cours d'eau
    const L = 2 * g.halfWidth;
    const a = [cx + uy * g.halfWidth, cy - ux * g.halfWidth];
    const b = [cx - uy * g.halfWidth, cy + ux * g.halfWidth];
    const cells = [];
    rasterizeLine(grid, [a, b], (k) => {
      if (!cells.includes(k)) cells.push(k);
    });
    if (!cells.length) continue;
    const w = L / cells.length;
    // Normale (sens de l'écoulement) exprimée dans le repère de la grille (est, sud).
    out.push({
      ...g,
      line: [a, b],
      cells: Int32Array.from(cells),
      wx: new Float32Array(cells.length).fill(w * ux),
      wy: new Float32Array(cells.length).fill(-w * uy),
    });
  }
  return out;
}

/** Champs dépendant du scénario (sol, humidité). */
export function buildModel({ grid, terrain, classes, soilGroup, amc, rainOnBasinOnly, cnFactor }) {
  const { S, manning } = buildRunoffFields(
    classes,
    rainOnBasinOnly ? terrain.mask : null,
    soilGroup,
    amc,
    cnFactor,
  );
  return { nx: grid.nx, ny: grid.ny, dx: grid.dx, z: terrain.z, S, manning };
}
