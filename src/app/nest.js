// Calcul en deux temps (« emboîté ») : tout le bassin à maille grossière, puis un carré autour du
// lieu à maille fine, alimenté par l'eau qui y entrait dans le premier calcul.
//
// 1. Le carré fin est calé sur les mailles grossières (ses bords suivent leurs faces) et sa taille
//    est un multiple de la maille fine.
// 2. Pendant le calcul grossier, chaque face du bord du carré est un point de mesure du débit,
//    signé (positif quand l'eau entre dans le carré).
// 3. Le calcul fin reçoit ces débits entrants comme apports, injectés dans les mailles les plus
//    basses du bord intérieur, face par face ; la pluie tombe sur la partie du bassin dans le carré.

import { makeGrid } from '../geo.js';

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** Carré fin autour de `center` (Lambert 93), demi-côté R, calé sur la grille grossière g1. */
export function nestBox(g1, center, R, rf) {
  const rc = g1.dx;
  // Nombre de mailles grossières multiple de m, pour que le côté soit un multiple de rf.
  const m = rf / gcd(rc, rf);
  const fit = (a, b, n) => {
    a = Math.max(0, a);
    b = Math.min(n, b);
    while ((b - a) % m) {
      if (b < n) b++;
      else if (a > 0) a--;
      else break;
    }
    return [a, b];
  };
  const [i0, i1] = fit(Math.floor((center.x - R - g1.xmin) / rc), Math.ceil((center.x + R - g1.xmin) / rc), g1.nx);
  const [j0, j1] = fit(Math.floor((g1.ymax - (center.y + R)) / rc), Math.ceil((g1.ymax - (center.y - R)) / rc), g1.ny);
  if (i1 - i0 < 2 || j1 - j0 < 2) return null;
  const bbox = { xmin: g1.xmin + i0 * rc, xmax: g1.xmin + i1 * rc, ymax: g1.ymax - j0 * rc, ymin: g1.ymax - j1 * rc };
  return { i0, i1, j0, j1, bbox, grid: makeGrid(bbox, rf) };
}

/**
 * Faces de la grille grossière sur le bord du carré, comme points de mesure signés (entrant > 0).
 * Conventions du solveur : face est (wx) ou sud (wy) de la maille `cells[0]` ; qx > 0 vers l'est,
 * qy > 0 vers le sud.
 */
export function boundaryGauges(g1, box) {
  const { nx, ny, dx, xmin, ymax } = g1;
  const { i0, i1, j0, j1 } = box;
  const out = [];
  const add = (side, k, wx, wy, seg) => out.push({ id: `bord${out.length}`, signed: true, side, seg, cells: Int32Array.of(k), wx: Float32Array.of(wx), wy: Float32Array.of(wy) });
  for (let i = i0; i < i1; i++) {
    const seg = [xmin + i * dx, xmin + (i + 1) * dx];
    if (j0 > 0) add('n', (j0 - 1) * nx + i, 0, dx, seg); // entre par le nord : qy > 0
    if (j1 < ny) add('s', (j1 - 1) * nx + i, 0, -dx, seg); // entre par le sud : qy < 0
  }
  for (let j = j0; j < j1; j++) {
    const seg = [ymax - (j + 1) * dx, ymax - j * dx];
    if (i0 > 0) add('w', j * nx + i0 - 1, dx, 0, seg); // entre par l'ouest : qx > 0
    if (i1 < nx) add('e', j * nx + i1 - 1, -dx, 0, seg); // entre par l'est : qx < 0
  }
  return out;
}

/**
 * Apports du calcul fin : pour chaque face où de l'eau est surtout entrée, ses débits entrants
 * (m³/s) au cours du temps, injectés dans les mailles les plus basses de la 2e rangée. La 1re
 * rangée de ces segments est fermée (`walls`) : sinon l'eau injectée repartirait par le bord, où
 * la sortie est libre. Les segments où l'eau sort restent ouverts.
 * @param faces  boundaryGauges(...)
 * @param series pour chaque face, [[t, Q signé], …]
 */
export function nestSources(g2, z2, faces, series, minPeak = 0.002) {
  const { nx, ny, dx, xmin, ymax } = g2;
  const out = [];
  const walls = [];
  let peakSum = 0;
  faces.forEach((f, n) => {
    const s = series[n];
    let peak = 0;
    let vin = 0;
    let vout = 0;
    for (let m = 1; m < s.length; m++) {
      const q = 0.5 * (s[m][1] + s[m - 1][1]);
      const dt = s[m][0] - s[m - 1][0];
      if (q > 0) vin += q * dt;
      else vout -= q * dt;
    }
    for (const [, q] of s) if (q > peak) peak = q;
    if (peak < minPeak || vin < 5 * vout) return;
    const ks = [];
    const edge = [];
    const row = (j, a, b) => {
      for (let i = Math.max(0, Math.round((a - xmin) / dx)); i < Math.min(nx, Math.round((b - xmin) / dx)); i++) ks.push(j * nx + i);
    };
    const col = (i, a, b) => {
      for (let j = Math.max(0, Math.round((ymax - b) / dx)); j < Math.min(ny, Math.round((ymax - a) / dx)); j++) ks.push(j * nx + i);
    };
    const mark = (fn, ...a) => {
      const n0 = ks.length;
      fn(...a);
      edge.push(...ks.splice(n0));
    };
    if (f.side === 'n') {
      row(Math.min(1, ny - 1), f.seg[0], f.seg[1]);
      mark(row, 0, f.seg[0], f.seg[1]);
    } else if (f.side === 's') {
      row(Math.max(0, ny - 2), f.seg[0], f.seg[1]);
      mark(row, ny - 1, f.seg[0], f.seg[1]);
    } else if (f.side === 'w') {
      col(Math.min(1, nx - 1), f.seg[0], f.seg[1]);
      mark(col, 0, f.seg[0], f.seg[1]);
    } else {
      col(Math.max(0, nx - 2), f.seg[0], f.seg[1]);
      mark(col, nx - 1, f.seg[0], f.seg[1]);
    }
    if (!ks.length) return;
    walls.push(...edge);
    let zmin = Infinity;
    for (const k of ks) zmin = Math.min(zmin, z2[k]);
    const cells = ks.filter((k) => z2[k] <= zmin + 0.3).slice(0, 12);
    out.push({
      cells: Int32Array.from(cells),
      t: Float32Array.from(s, (p) => p[0]),
      Q: Float32Array.from(s, (p) => Math.max(0, p[1])),
    });
    peakSum += peak;
  });
  return { sources: out, peakSum, walls };
}
