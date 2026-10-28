// Débits de crue de référence d'une rivière, en ordre de grandeur, à partir de la surface de son
// bassin et des pluies journalières du lieu (stations Météo-France).
//
// Q10 : formule CRUPEDIX (Cemagref, 1980) : Q10 = R · S^0,8 · (Pj10 / 80)², débit de pointe
//       décennal (m³/s) d'un bassin de S km², Pj10 pluie journalière décennale (mm), R coefficient
//       régional (1 par défaut, de 0,5 à 2 selon les régions).
// Q100 : méthode du gradex, simplifiée : au-delà de la décennale, tout supplément de pluie
//        ruisselle ; Q100 = Q10 + ΔP(tc) · S / (3,6 · tc), où ΔP(tc) est l'écart entre pluies
//        centennale et décennale sur la durée tc (temps de concentration), déduit de l'écart
//        journalier (× 1,13 pour 24 h glissantes) par une loi en (tc / 24)^0,6.

export const concentrationH = (areaKm2) => Math.max(1, 0.6 * Math.max(0.01, areaKm2) ** 0.4);

export function floodQuantiles(areaKm2, pj10 = 80, pj100 = 120, R = 1) {
  const q10 = R * areaKm2 ** 0.8 * (pj10 / 80) ** 2;
  const tc = concentrationH(areaKm2);
  const dP = Math.max(0, (pj100 - pj10) * 1.13) * Math.min(1, (tc / 24) ** 0.6);
  const q100 = q10 + (dP * areaKm2) / (3.6 * tc);
  return { q10, q100, tc };
}

/**
 * Maxima annuels d'une chronique de maxima journaliers [[AAAA-MM-JJ, Q]] : années hydrologiques
 * de septembre à août (les crues d'automne restent dans la même année) ; années incomplètes
 * (moins de `minDays` jours mesurés) écartées.
 */
export function annualMaxima(days, minDays = 290) {
  const by = new Map();
  for (const [d, q] of days) {
    if (!(q >= 0)) continue;
    const y = Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) < 9 ? 1 : 0);
    const e = by.get(y) || { year: y, q: 0, n: 0 };
    e.q = Math.max(e.q, q);
    e.n++;
    by.set(y, e);
  }
  return [...by.values()].filter((e) => e.n >= minDays).sort((a, b) => a.year - b.year);
}

/**
 * Loi de Gumbel ajustée par les moments sur des maxima annuels : débits de période de retour
 * 10 et 100 ans.
 */
export function gumbelQuantiles(values) {
  const n = values.length;
  const m = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  const a = (sd * Math.sqrt(6)) / Math.PI;
  const u = m - 0.5772 * a;
  const q = (T) => u - a * Math.log(-Math.log(1 - 1 / T));
  return { q10: q(10), q100: q(100) };
}

export const MIN_STATION_YEARS = 15;
/** Transposition d'un débit de crue d'une station à un autre point du cours d'eau : Q ∝ S^0,8. */
export const transposeQ = (q, fromKm2, toKm2) => q * (toKm2 / fromKm2) ** 0.8;
