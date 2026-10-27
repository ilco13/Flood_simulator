// Pluie variable dans l'espace (épisodes réels) : le domaine est découpé en blocs rectangulaires
// (≈ 1 km, 2048 au plus) ; chaque bloc reçoit la pluie horaire des stations Météo-France
// interpolée à son centre (inverse du carré de la distance + 1 km, heures manquantes ignorées).
// Les solveurs retrouvent le bloc d'une maille par sa position : aucun tableau par maille.

export const MAX_ZONES = 2048;

/**
 * @param grid     grille de calcul (Lambert 93)
 * @param stations [{ x, y (Lambert 93), rr: pluie de chaque heure (mm, NaN = manquant) }]
 * @param hours    nombre d'heures
 * @returns { bi, bj, nzx, nzy, nz, hours, cum: Float32Array(nz × (hours+1)) } cumul en mm
 */
export function buildRainZones(grid, stations, hours, blockM = 1000) {
  const { nx, ny, dx, xmin, ymax } = grid;
  let b = Math.max(1, Math.round(blockM / dx));
  while (Math.ceil(nx / b) * Math.ceil(ny / b) > MAX_ZONES) b++;
  const nzx = Math.ceil(nx / b);
  const nzy = Math.ceil(ny / b);
  const nz = nzx * nzy;
  const cum = new Float32Array(nz * (hours + 1));
  for (let zj = 0; zj < nzy; zj++)
    for (let zi = 0; zi < nzx; zi++) {
      const z = zj * nzx + zi;
      const cx = xmin + (Math.min(nx, (zi + 0.5) * b) * dx);
      const cy = ymax - (Math.min(ny, (zj + 0.5) * b) * dx);
      const w = stations.map((s) => 1 / (Math.hypot(s.x - cx, s.y - cy) / 1000 + 1) ** 2);
      let c = 0;
      for (let h = 0; h < hours; h++) {
        let sw = 0;
        let sv = 0;
        stations.forEach((s, n) => {
          const v = s.rr[h];
          if (!(v >= 0)) return;
          sw += w[n];
          sv += w[n] * v;
        });
        c += sw ? sv / sw : 0;
        cum[z * (hours + 1) + h + 1] = c;
      }
    }
  return { bi: b, bj: b, nzx, nzy, nz, hours, cum };
}

/** Bloc d'une maille (i, j). */
export const zoneOf = (rz, i, j) => Math.floor(j / rz.bj) * rz.nzx + Math.floor(i / rz.bi);

/** Cumul (mm) du bloc z au temps t (s), linéaire dans chaque heure. */
export function zoneCum(rz, z, t) {
  const H = rz.hours;
  const base = z * (H + 1);
  if (t <= 0) return 0;
  if (t >= H * 3600) return rz.cum[base + H];
  const h = Math.floor(t / 3600);
  const f = t / 3600 - h;
  return rz.cum[base + h] + f * (rz.cum[base + h + 1] - rz.cum[base + h]);
}

/** Pluie moyenne (mm) de tous les blocs : contrôle. */
export function zonesMeanTotal(rz) {
  let s = 0;
  for (let z = 0; z < rz.nz; z++) s += rz.cum[z * (rz.hours + 1) + rz.hours];
  return s / rz.nz;
}
