// Préparation des entrées du modèle à partir des données brutes.

import { burnRivers, riverDirectionAt, rasterizeLine } from '../data/rivers.js';
import { drainageLabels, basinMask, accumulation, upstreamMask, flowDirections } from '../hydrology/terrain.js';
import { buildRunoffFields } from '../hydrology/scs.js';
import { cellOf } from '../geo.js';

/**
 * Prétraitements indépendants de la pluie : gravure du réseau, bassin versant.
 * @returns {{ z: Float32Array, mask: Uint8Array, basinCells: number, burned: number, breached: number }}
 */
export function prepareTerrain({ grid, dem, rivers, burnDepth, outlet, upstreamOf, obstacles }) {
  const z = dem.slice();
  const burned = rivers && burnDepth > 0 ? burnRivers(grid, z, rivers, burnDepth) : 0;
  // Ouvrages dessinés par l'utilisateur (absents du MNT, qui est un modèle du sol nu).
  const protect = obstacles?.length ? applyObstacles(grid, z, obstacles) : null;
  const { label, breached, parent, order, filled } = drainageLabels(z, grid.nx, grid.ny, {
    maxDepth: Math.max(2, 0.3 * grid.dx),
    maxLength: Math.max(4, Math.round(300 / grid.dx)),
    protect,
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
    // Bassin versant d'un ou plusieurs points : toutes les mailles en amont (union).
    const pts = Array.isArray(upstreamOf) ? upstreamOf : [upstreamOf];
    const down = flowDirections(filled, parent, order, grid.nx, grid.ny);
    const acc = accumulation(down, order);
    const outletKs = [];
    for (const pt of pts) {
      const k = snapToStream(grid, acc, pt);
      if (k < 0) continue;
      outletKs.push(k);
      const r = upstreamMask(down, order, k);
      if (!mask) mask = r.mask;
      else for (let n = 0; n < mask.length; n++) mask[n] |= r.mask[n];
    }
    if (mask) {
      basinCells = 0;
      for (let n = 0; n < mask.length; n++) basinCells += mask[n];
      return { z, mask, basinCells, burned, breached, outletK: outletKs[0], outletKs, acc };
    }
  }
  return { z, mask, basinCells, burned, breached };
}

/**
 * Ajoute au relief les ouvrages dessinés (coordonnées Lambert 93) :
 *  - bâtiment (polygone) : mailles dont le centre est dedans relevées de `h` (au moins la maille
 *    du centre de gravité pour un petit bâtiment) ; l'eau le contourne ;
 *  - mur (ligne) : mailles traversées (chemin 4-connexe, étanche pour l'écoulement) relevées de `h`.
 * Renvoie le masque des mailles modifiées (protégées du débrèchage).
 */
export function applyObstacles(grid, z, obstacles) {
  const { nx, ny, dx, xmin, ymax } = grid;
  const protect = new Uint8Array(nx * ny);
  const raise = new Float32Array(nx * ny);
  for (const o of obstacles) {
    const h = Math.max(0, Number(o.h) || 0);
    if (!h || !o.pts?.length) continue;
    if (o.type === 'wall') {
      rasterizeLine(grid, o.pts, (k) => {
        raise[k] = Math.max(raise[k], h);
      });
      continue;
    }
    // Polygone : remplissage par lignes (centres de mailles)
    const P = o.pts;
    let ymin = Infinity;
    let ymx = -Infinity;
    for (const [, y] of P) {
      ymin = Math.min(ymin, y);
      ymx = Math.max(ymx, y);
    }
    let any = false;
    const j0 = Math.max(0, Math.floor((ymax - ymx) / dx));
    const j1 = Math.min(ny - 1, Math.ceil((ymax - ymin) / dx));
    for (let j = j0; j <= j1; j++) {
      const yc = ymax - (j + 0.5) * dx;
      const xs = [];
      for (let a = 0, b = P.length - 1; a < P.length; b = a++) {
        const [xa, ya] = P[a];
        const [xb, yb] = P[b];
        if ((ya > yc) !== (yb > yc)) xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
      }
      xs.sort((u, v) => u - v);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const i0 = Math.max(0, Math.ceil((xs[m] - xmin) / dx - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((xs[m + 1] - xmin) / dx - 0.5));
        for (let i = i0; i <= i1; i++) {
          raise[j * nx + i] = Math.max(raise[j * nx + i], h);
          any = true;
        }
      }
    }
    if (!any) {
      const cx = P.reduce((a, p) => a + p[0], 0) / P.length;
      const cy = P.reduce((a, p) => a + p[1], 0) / P.length;
      const c = cellOf(grid, cx, cy);
      if (c) raise[c.k] = Math.max(raise[c.k], h);
    }
  }
  for (let k = 0; k < raise.length; k++)
    if (raise[k] > 0) {
      z[k] += raise[k];
      protect[k] = 1;
    }
  return protect;
}

/** Relief conditionné et réseau d'écoulement D8 (pour délimiter des bassins versants). */
export function flowModel({ grid, dem, rivers, burnDepth }) {
  const z = dem.slice();
  if (rivers && burnDepth > 0) burnRivers(grid, z, rivers, burnDepth);
  const { parent, order, filled } = drainageLabels(z, grid.nx, grid.ny, {
    maxDepth: Math.max(2, 0.3 * grid.dx),
    maxLength: Math.max(4, Math.round(300 / grid.dx)),
  });
  const down = flowDirections(filled, parent, order, grid.nx, grid.ny);
  return { z, down, order, acc: accumulation(down, order) };
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
export function snapToStream(grid, acc, { x, y, areaM2 = 0, minAreaM2 = 0, radiusM = 0, exact = false }) {
  const c = cellOf(grid, x, y);
  if (!c) return -1;
  if (exact) return c.k;
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
