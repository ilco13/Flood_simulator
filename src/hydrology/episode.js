// Calculs d'un épisode réel (sans interface) : pluie moyenne sur le bassin, fenêtre de pluie,
// humidité du sol avant l'épisode, écarts entre débits simulés et mesurés.

/** Années couvertes par un fichier Météo-France : H_13_1990-1999, H_13_previous-2020-2024, H_13_latest-2025-2026. */
export function yearsOf(url) {
  const m = /[_-](\d{4})-(\d{4})\.csv\.gz$/.exec(url);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const localDay = (ms) => new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : NaN);

/** Début (ms TU) du jour civil `d` (AAAA-MM-JJ) à Paris, heure d'été comprise. */
export function parisDayStart(d) {
  const noon = Date.parse(`${d}T12:00:00Z`);
  const local = Date.parse(`${new Date(noon).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).replace(' ', 'T')}Z`);
  return Date.parse(`${d}T00:00:00Z`) - (local - noon);
}
/** Pluie moyenne sur le bassin, heure par heure : pondération par l'inverse du carré de la distance. */
export function arealHourly(stations, hours) {
  const out = new Float32Array(hours);
  for (let k = 0; k < hours; k++) {
    let sw = 0;
    let s = 0;
    for (const st of stations) {
      const v = st.rr[k];
      if (!(v >= 0)) continue;
      const w = 1 / (st.d + 1) ** 2;
      sw += w;
      s += w * v;
    }
    out[k] = sw ? s / sw : 0;
  }
  return out;
}

/**
 * Fenêtre de l'épisode : du début à la fin de la pluie (2 % et 98 % du cumul), `maxH` heures au plus (48 par défaut)
 * (la plus pluvieuse) ; à chercher à partir de `from`.
 */
export function rainWindow(a, from, maxH = 48) {
  let total = 0;
  for (let k = from; k < a.length; k++) total += a[k];
  if (total <= 0) return null;
  let c = 0;
  let s = from;
  let e = a.length;
  for (let k = from; k < a.length; k++) {
    if (c < 0.02 * total && c + a[k] >= 0.02 * total) s = k;
    c += a[k];
    if (c >= 0.98 * total) {
      e = k + 1;
      break;
    }
  }
  s = Math.max(from, s - 1);
  if (e - s > maxH) {
    let best = s;
    let bestSum = -1;
    for (let k = s; k + maxH <= e; k++) {
      let sum = 0;
      for (let m = k; m < k + maxH; m++) sum += a[m];
      if (sum > bestSum) {
        bestSum = sum;
        best = k;
      }
    }
    s = best;
    e = best + maxH;
  }
  return { s, e };
}

/** Humidité du sol d'après la pluie des 5 jours précédents (seuils SCS, saison de végétation ou non). */
/**
 * Indice de pluies antérieures (mm) : pluie de chacun des `days` jours précédant l'heure `s`,
 * pondérée par k^(n−1) pour le n-ième jour avant (le sol sèche peu à peu) ; voit une période
 * pluvieuse de plusieurs semaines que la règle des 5 jours ignore.
 */
export function antecedentIndex(a, s, days = 30, k = 0.9) {
  let api = 0;
  for (let n = 1; n <= days; n++) {
    let day = 0;
    for (let h = s - n * 24; h < s - (n - 1) * 24; h++) if (h >= 0) day += a[h];
    api += day * k ** (n - 1);
  }
  return api;
}

/**
 * Humidité du sol (1 sec, 2 normal, 3 saturé) d'après l'indice de pluies antérieures : seuils
 * SCS des 5 jours (13 / 28 mm hors saison de végétation, 36 / 53 mm en saison) multipliés par 2,
 * l'indice cumulant l'équivalent d'environ 10 jours de pluie (somme des poids 0,9^n sur 30 jours).
 */
/**
 * Humidité du sol continue, de 1 (sec) à 3 (saturé), pour éviter les sauts de part et d'autre
 * d'un seuil : 1 jusqu'à la moitié du seuil bas, 2 au milieu des deux seuils, 3 à 1,5 fois le
 * seuil haut, linéaire entre ces points.
 */
export function amcIndex(mm, month) {
  const growing = month >= 4 && month <= 10;
  const [lo, hi] = growing ? [72, 106] : [26, 56];
  const a = 0.5 * lo;
  const m = 0.5 * (lo + hi);
  const b = 1.5 * hi;
  if (mm <= a) return 1;
  if (mm >= b) return 3;
  return mm < m ? 1 + (mm - a) / (m - a) : 2 + (mm - m) / (b - m);
}

export function amcFromAntecedent(mm, month) {
  const growing = month >= 4 && month <= 10;
  const [lo, hi] = growing ? [72, 106] : [26, 56];
  return mm < lo ? 1 : mm > hi ? 3 : 2;
}

/** Écarts simulé / mesuré d'une simulation d'épisode. */
export function episodeScores(run, ep) {
  const gi = Math.max(0, run.gauges.findIndex((g) => String(g.id).startsWith('study')));
  const sim = run.series[gi].map(([t, q]) => [ep.t0 + t * 1000, q]);
  const tEnd = sim[sim.length - 1][0];
  let simPeak = 0;
  let simPeakT = ep.t0;
  for (const [t, q] of sim) if (q > simPeak) [simPeak, simPeakT] = [q, t];
  const days = ep.obs.daily.filter((d) => d.date >= localDay(ep.t0) && d.date <= localDay(tEnd));
  const obsPeakDay = days.reduce((a, d) => (d.max > (a?.max ?? -1) ? d : a), null);
  const curve = ep.csv || ep.obs.curve;
  let obsPeak = obsPeakDay?.max ?? NaN;
  let obsPeakT = null;
  let nse = null;
  if (curve) {
    const inWin = curve.filter(([t]) => t >= ep.t0 && t <= tEnd);
    if (inWin.length > 3) {
      const m = inWin.reduce((a, b) => (b[1] > a[1] ? b : a));
      obsPeak = m[1];
      obsPeakT = m[0];
      // Nash : simulé interpolé aux instants mesurés
      const at = (t) => {
        let k = sim.findIndex((p) => p[0] >= t);
        if (k <= 0) return sim[Math.max(0, k)][1];
        const [t0, q0] = sim[k - 1];
        const [t1, q1] = sim[k];
        return q0 + ((q1 - q0) * (t - t0)) / (t1 - t0);
      };
      const mean = inWin.reduce((a, p) => a + p[1], 0) / inWin.length;
      let num = 0;
      let den = 0;
      for (const [t, q] of inWin) {
        num += (at(t) - q) ** 2;
        den += (q - mean) ** 2;
      }
      nse = den > 0 ? 1 - num / den : null;
    }
  }
  // Volume de crue sur les jours entièrement simulés : débit moyen au-dessus du débit de base
  // (moyenne du jour précédant la simulation, ou la plus faible de la fenêtre).
  const before = ep.obs.daily.find((d) => d.date === localDay(ep.t0 - 864e5))?.mean;
  const base = Number.isFinite(before) ? before : Math.min(...days.map((d) => d.mean ?? Infinity));
  let vObs = 0;
  let vSim = 0;
  for (const d of days) {
    const d0 = parisDayStart(d.date);
    if (d0 < ep.t0 || d0 + 864e5 > tEnd || !Number.isFinite(d.mean)) continue;
    vObs += Math.max(0, d.mean - (Number.isFinite(base) ? base : 0)) * 86400;
    for (let k = 1; k < sim.length; k++) {
      const [ta, qa] = sim[k - 1];
      const [tb, qb] = sim[k];
      const a = Math.max(ta, d0);
      const b = Math.min(tb, d0 + 864e5);
      if (b > a) vSim += 0.5 * (qa + qb) * ((b - a) / 1000);
    }
  }
  return {
    sim,
    simPeak,
    simPeakT,
    obsPeak,
    obsPeakT,
    obsPeakDay: obsPeakDay?.date ?? null,
    peakErr: pct(simPeak, obsPeak),
    timeErrH: obsPeakT ? (simPeakT - obsPeakT) / 3600e3 : null,
    volErr: vObs > 0 ? pct(vSim, vObs) : null,
    nse,
    days,
    curve,
  };
}

