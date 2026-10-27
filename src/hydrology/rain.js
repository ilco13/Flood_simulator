// Hyétogrammes : répartition dans le temps d'un cumul P (mm) sur une durée D (h).
// On travaille avec la pluie cumulée P(t) (mm) pour intégrer exactement sur chaque pas de temps.

export const SHAPES = {
  uniform: 'Uniforme (intensité constante)',
  desbordes: 'Double triangle de Desbordes (pointe centrale)',
  early: 'Orage en début d\'épisode',
  late: 'Orage en fin d\'épisode',
  chicago: 'Chicago (intensités cohérentes avec les courbes de Montana)',
};

// Exposant b de Montana utilisé pour la forme Chicago (Aix-en-Provence, 100 ans : b = 0,433).
export const MONTANA_B = 0.433;

/**
 * Construit une fonction intensité i(t) (mm/h) et cumul P(t) (mm), t en secondes.
 * Double triangle (Desbordes) : un triangle « de fond » sur toute la durée et un triangle
 * intense de durée d = D/6 contenant la moitié du cumul, centré sur la position de pointe.
 */
export function makeHyetograph({ totalMm, durationH, shape = 'desbordes', montanaB = MONTANA_B, hourly = null }) {
  if (shape === 'observed' && hourly?.length) return observed(hourly);
  const D = durationH * 3600;
  const P = totalMm;
  if (shape === 'chicago') return chicago(P, D, montanaB);
  let parts;
  if (shape === 'uniform') {
    parts = [{ t0: 0, t1: D, tp: null, vol: P }];
  } else {
    const peakPos = shape === 'early' ? 0.2 : shape === 'late' ? 0.8 : 0.5;
    const tp = peakPos * D;
    const d = Math.max(D / 6, 600);
    const f = 0.5;
    const a = Math.max(0, tp - d / 2);
    const b = Math.min(D, a + d);
    parts = [
      { t0: 0, t1: D, tp, vol: P * (1 - f) },
      { t0: a, t1: b, tp: (a + b) / 2, vol: P * f },
    ];
  }

  // Intensité d'un triangle (ou rectangle si tp null) en mm/s.
  const rate = (p, t) => {
    if (t < p.t0 || t > p.t1) return 0;
    const L = p.t1 - p.t0;
    if (p.tp === null) return p.vol / L;
    const peak = (2 * p.vol) / L;
    if (t <= p.tp) return p.tp === p.t0 ? peak : (peak * (t - p.t0)) / (p.tp - p.t0);
    return p.t1 === p.tp ? peak : (peak * (p.t1 - t)) / (p.t1 - p.tp);
  };
  // Cumul d'un triangle entre t0 et t (intégrale analytique).
  const cum = (p, t) => {
    if (t <= p.t0) return 0;
    if (t >= p.t1) return p.vol;
    const L = p.t1 - p.t0;
    if (p.tp === null) return (p.vol * (t - p.t0)) / L;
    const peak = (2 * p.vol) / L;
    const up = p.tp - p.t0;
    if (t <= p.tp) return up > 0 ? (0.5 * peak * (t - p.t0) ** 2) / up : 0;
    const down = p.t1 - p.tp;
    const rest = (p.t1 - t) ** 2;
    return p.vol - (down > 0 ? (0.5 * peak * rest) / down : 0);
  };

  return {
    durationS: D,
    totalMm: P,
    /** intensité en mm/h */
    intensity: (t) => parts.reduce((s, p) => s + rate(p, t), 0) * 3600,
    /** cumul en mm */
    cumulative: (t) => parts.reduce((s, p) => s + cum(p, t), 0),
    peakMmH() {
      let m = 0;
      for (let k = 0; k <= 2000; k++) m = Math.max(m, this.intensity((k / 2000) * D));
      return m;
    },
  };
}

/**
 * Pluie de projet « Chicago » centrée : pour toute durée w autour de la pointe, la hauteur
 * tombée vaut H(w) = P·(w/D)^(1−b), comme le prévoit une loi de Montana i = a·t^(−b).
 * Les intensités sur 6 min, 30 min, 1 h… restent ainsi cohérentes avec la même période de retour.
 */
function chicago(P, D, b) {
  const tp = D / 2;
  const H = (w) => P * Math.pow(Math.min(Math.max(w, 0), D) / D, 1 - b);
  const cumulative = (t) => {
    if (t <= 0) return 0;
    if (t >= D) return P;
    const w = 2 * Math.abs(t - tp);
    return P / 2 + (t >= tp ? 1 : -1) * (H(w) / 2);
  };
  return {
    durationS: D,
    totalMm: P,
    cumulative,
    // intensité moyenne sur 1 min (la loi est infinie à la pointe)
    intensity: (t) => ((cumulative(t + 30) - cumulative(t - 30)) / 60) * 3600,
    peakMmH() {
      return ((cumulative(tp + 180) - cumulative(tp - 180)) / 360) * 3600;
    },
  };
}

/**
 * Pluie observée heure par heure (épisode réel) : hauteur constante dans chaque heure.
 * @param hourly mm tombés pendant chaque heure, depuis t = 0
 */
export function observed(hourly) {
  const n = hourly.length;
  const cum = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) cum[k + 1] = cum[k] + Math.max(0, hourly[k] || 0);
  const D = n * 3600;
  return {
    durationS: D,
    totalMm: cum[n],
    intensity: (t) => (t < 0 || t >= D ? 0 : Math.max(0, hourly[Math.floor(t / 3600)] || 0)),
    cumulative: (t) => {
      if (t <= 0) return 0;
      if (t >= D) return cum[n];
      const k = Math.floor(t / 3600);
      return cum[k] + (cum[k + 1] - cum[k]) * (t / 3600 - k);
    },
    peakMmH: () => Math.max(0, ...hourly),
  };
}
