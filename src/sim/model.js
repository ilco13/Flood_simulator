// Préparation des entrées du modèle à partir des données brutes.

import { burnRivers, riverDirectionAt, rasterizeLine } from '../data/rivers.js';
import { drainageLabels, basinMask, accumulation, upstreamMask, flowDirections } from '../hydrology/terrain.js';
import { buildRunoffFields } from '../hydrology/scs.js';
import { cellOf } from '../geo.js';

/**
 * Prétraitements indépendants de la pluie : gravure du réseau, bassin versant.
 * @returns {{ z: Float32Array, mask: Uint8Array, basinCells: number, burned: number, breached: number }}
 */
export function prepareTerrain({ grid, dem, rivers, burnDepth, outlet, upstreamOf }) {
  const z = dem.slice();
  const burned = rivers && burnDepth > 0 ? burnRivers(grid, z, rivers, burnDepth) : 0;
  const { label, breached, parent, order, filled } = drainageLabels(z, grid.nx, grid.ny, {
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
  } else if (upstreamOf) {
    // Bassin versant d'un point choisi : toutes les mailles en amont de ce point.
    const down = flowDirections(filled, parent, order, grid.nx, grid.ny);
    const acc = accumulation(down, order);
    const k = snapToStream(grid, acc, upstreamOf);
    if (k >= 0) {
      const r = upstreamMask(down, order, k);
      mask = r.mask;
      basinCells = r.cells;
      return { z, mask, basinCells, burned, breached, outletK: k, acc };
    }
  }
  return { z, mask, basinCells, burned, breached };
}

/**
 * Cale le point choisi sur le cours d'eau voisin, dans un rayon `radiusM` :
 *  - par défaut : la maille la plus drainée (rayon ~60 m) ;
 *  - `areaM2` (surface attendue, connue sur une autre grille) : la maille dont la surface
 *    drainée en est la plus proche ;
 *  - `minAreaM2` (surface minimale, bassin tronqué sur une grille plus petite) : la plus
 *    petite surface drainée qui la dépasse, pour rester sur le même cours d'eau sans sauter
 *    dans une rivière plus grosse toute proche.
 */
export function snapToStream(grid, acc, { x, y, areaM2 = 0, minAreaM2 = 0, radiusM = 0 }) {
  const c = cellOf(grid, x, y);
  if (!c) return -1;
  const cellArea = grid.dx * grid.dx;
  const r = Math.max(2, Math.round((radiusM || (areaM2 ? 150 : 60)) / grid.dx));
  let best = -1;
  let bestScore = -Infinity;
  for (let dj = -r; dj <= r; dj++)
    for (let di = -r; di <= r; di++) {
      if (di * di + dj * dj > r * r) continue;
      const i = c.i + di;
      const j = c.j + dj;
      if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
      const k = j * grid.nx + i;
      const a = acc[k] * cellArea;
      const dist = Math.hypot(di, dj) / r;
      let score;
      if (areaM2) score = -Math.abs(Math.log(a / areaM2)) - 0.3 * dist;
      else if (minAreaM2) score = a >= 0.9 * minAreaM2 ? -Math.log(a / minAreaM2) - dist : -1e9 + a;
      else score = Math.log(a) - 0.5 * dist;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
  return best;
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
    const a = [cx + uy * g.halfWidth, cy - ux * g.halfWidth];
    const b = [cx - uy * g.halfWidth, cy + ux * g.halfWidth];
    const line = new Set();
    rasterizeLine(grid, [a, b], (k) => line.add(k));
    if (!line.size) continue;
    // Débit = somme des flux à travers les faces qui séparent la ligne (maille 4-connexe)
    // des mailles situées côté aval. Chaque écoulement est ainsi compté une seule fois,
    // même quand la ligne en escalier le traverse sur deux mailles.
    // Faces repérées par la maille dont c'est la face est (wx) ou sud (wy) ;
    // qx > 0 vers l'est, qy > 0 vers le sud (j croissant).
    const gx = ux;
    const gy = -uy; // sens de l'écoulement en coordonnées de grille (i, j)
    const { nx, ny, dx } = grid;
    const faces = new Map();
    const add = (k, wx, wy) => {
      const f = faces.get(k) || [0, 0];
      f[0] += wx;
      f[1] += wy;
      faces.set(k, f);
    };
    for (const k of line) {
      const i = k % nx;
      const j = (k - i) / nx;
      if (gx > 1e-3 && i + 1 < nx && !line.has(k + 1)) add(k, dx, 0);
      if (gx < -1e-3 && i > 0 && !line.has(k - 1)) add(k - 1, -dx, 0);
      if (gy > 1e-3 && j + 1 < ny && !line.has(k + nx)) add(k, 0, dx);
      if (gy < -1e-3 && j > 0 && !line.has(k - nx)) add(k - nx, 0, -dx);
    }
    const ks = [...faces.keys()];
    out.push({
      ...g,
      line: [a, b],
      cells: Int32Array.from(ks),
      wx: Float32Array.from(ks, (k) => faces.get(k)[0]),
      wy: Float32Array.from(ks, (k) => faces.get(k)[1]),
    });
  }
  return out;
}

/** Facteur de sur-échantillonnage de l'occupation du sol (pixels par côté de maille). */
export function landcoverOversampling(dx) {
  return Math.max(1, Math.min(4, Math.round(dx / 10)));
}

/**
 * Réordonne une image de classes à résolution dx/f en f² échantillons consécutifs par maille.
 */
export function regroupSamples(sub, grid, f) {
  if (f === 1) return sub;
  const { nx, ny } = grid;
  const W = nx * f;
  const out = new Uint8Array(nx * ny * f * f);
  let o = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      for (let b = 0; b < f; b++)
        for (let a = 0; a < f; a++) out[o++] = sub[(j * f + b) * W + i * f + a];
  return out;
}

/** Champs dépendant du scénario (sol, humidité). */
export function buildModel({ grid, terrain, classes, spc = 1, soilGroup, amc, rainOnBasinOnly, cnFactor }) {
  const { S, manning } = buildRunoffFields(
    classes,
    rainOnBasinOnly ? terrain.mask : null,
    soilGroup,
    amc,
    cnFactor,
    spc,
  );
  return { nx: grid.nx, ny: grid.ny, dx: grid.dx, z: terrain.z, S, manning };
}
