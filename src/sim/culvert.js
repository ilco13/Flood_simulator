// Ouvrages sous les routes (buses, ponts sous remblai) : l'eau passe de la maille amont à la
// maille aval par l'ouvrage, avec un débit limité par ses dimensions ; au-delà, elle monte et
// passe par-dessus la route (calcul 2D ordinaire sur le remblai, gardé dans le relief).
//
// Débit d'un ouvrage d'ouverture b (largeur) × a (hauteur), radier à la cote inv :
//  - entrée libre (charge H = η_amont − inv < 1,2 a) : contrôle à l'entrée, Q = 1,7·b·y^1,5
//    (y = min(H, a)), limité si l'aval est noyé : Q ≤ 0,8·b·y·√(2g·(η_amont − max(η_aval, inv))) ;
//  - en charge (H ≥ 1,2 a) : orifice, Q = Cd·b·a·√(2g·(η_amont − max(η_aval, inv + a/2))),
//    Cd = 0,46 pour raccorder les deux régimes sans saut.
// Le sens suit la plus haute des deux surfaces d'eau.

import { floodQuantiles } from '../hydrology/flood.js';

export const G = 9.81;
export const CD_PRESSURE = 0.46;
export const Q_SMOOTH = 60; // s : lissage du débit maximal affiché

export function culvertQ(etaHi, etaLo, inv, a, b) {
  const H = etaHi - inv;
  if (H <= 0 || a <= 0 || b <= 0) return 0;
  if (H < 1.2 * a) {
    const y = Math.min(H, a);
    const free = 1.7 * b * y ** 1.5;
    const sub = 0.8 * b * y * Math.sqrt(2 * G * Math.max(0, etaHi - Math.max(etaLo, inv)));
    return Math.min(free, sub);
  }
  return CD_PRESSURE * b * a * Math.sqrt(2 * G * Math.max(0, etaHi - Math.max(etaLo, inv + 0.5 * a)));
}

/**
 * Un pas de temps pour tous les ouvrages (moteur processeur).
 * links : [{ ku, kd, inv, a, b }] ; qmax : [débit lissé sur ≈ 1 min, débit lissé maximal] par
 * ouvrage (mis à jour ; le lissage efface les à-coups d'un pas à l'autre).
 * Volume transféré plafonné (moitié de l'eau de la maille amont, quart de l'écart de niveaux) :
 * stable quel que soit le pas de temps.
 */
export function applyCulverts(h, z, links, dt, dx, qmax) {
  const A = dx * dx;
  for (let n = 0; n < links.length; n++) {
    const L = links[n];
    const eu = z[L.ku] + h[L.ku];
    const ed = z[L.kd] + h[L.kd];
    const [hi, lo, eHi, eLo] = eu >= ed ? [L.ku, L.kd, eu, ed] : [L.kd, L.ku, ed, eu];
    const q = culvertQ(eHi, eLo, L.inv, L.a, L.b);
    const v = q <= 0 ? 0 : Math.min(q * dt, 0.5 * h[hi] * A, 0.25 * (eHi - eLo) * A);
    if (v > 0) {
      h[hi] -= v / A;
      h[lo] += v / A;
    }
    if (qmax) {
      qmax[2 * n] += (Math.max(0, v) / dt - qmax[2 * n]) * Math.min(1, dt / Q_SMOOTH);
      if (qmax[2 * n] > qmax[2 * n + 1]) qmax[2 * n + 1] = qmax[2 * n];
    }
  }
}

/**
 * Dimensions par défaut d'un ouvrage : il laisse passer la crue centennale estimée de son bassin
 * (CRUPEDIX + gradex, voir flood.js) avec l'entrée juste pleine ; hauteur au plus 80 % de celle
 * du remblai (0,5 à 4 m), ouverture carrée pour les petits débits, plus large que haute pour les
 * grands.
 */
export function defaultOpening(crest, invert, areaKm2, pj10 = 80, pj100 = 120) {
  let a = Math.min(4, Math.max(0.5, 0.8 * (crest - invert)));
  const qd = Math.max(0.2, floodQuantiles(Math.max(0.01, areaKm2 || 0.1), pj10, pj100).q100);
  const s = (qd / 1.7) ** 0.4;
  if (s < a) a = Math.max(0.5, s);
  const b = Math.min(40, Math.max(0.5, qd / (1.7 * a ** 1.5)));
  return { a: Math.round(a * 10) / 10, b: Math.round(b * 10) / 10, qd };
}
