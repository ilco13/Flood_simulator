// Hyétogrammes : répartition dans le temps d'un cumul P (mm) sur une durée D (h).
// On travaille avec la pluie cumulée P(t) (mm) pour intégrer exactement sur chaque pas de temps.

export const SHAPES = {
  uniform: 'Uniforme (intensité constante)',
  desbordes: 'Double triangle de Desbordes (pointe centrale)',
  early: 'Orage en début d\'épisode',
  late: 'Orage en fin d\'épisode',
};

/**
 * Construit une fonction intensité i(t) (mm/h) et cumul P(t) (mm), t en secondes.
 * Double triangle (Desbordes) : un triangle « de fond » sur toute la durée et un triangle
 * intense de durée d = D/6 contenant la moitié du cumul, centré sur la position de pointe.
 */
export function makeHyetograph({ totalMm, durationH, shape = 'desbordes' }) {
  const D = durationH * 3600;
  const P = totalMm;
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
