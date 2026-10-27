// Méthode SCS Curve Number : pluie nette (ruissellement) à partir de la pluie brute.
//   S  = 25400 / CN - 254          (rétention potentielle, mm)
//   Ia = 0,2 S                     (pertes initiales, mm)
//   Q  = (P - Ia)² / (P - Ia + S)  si P > Ia, sinon 0
// Le modèle 2D a besoin du taux instantané : dQ/dP = 1 - S² / (P - Ia + S)².

import { CLASSES } from './landcover.js';

export const IA_RATIO = 0.2;

/*
 * Plafond d'infiltration selon l'intensité (ruissellement « hortonien ») : la méthode SCS ne
 * regarde que le cumul de pluie ; or un sol ne peut absorber qu'un certain débit, même s'il
 * n'est pas plein. Capacité (loi de Horton, exprimée en pluie cumulée plutôt qu'en temps) :
 *   f = fc · (1 + (m0 − 1) · e^(−P / HORTON_P))
 * fc : capacité finale du groupe de sol A..D (mm/h), × multiplicateur de l'occupation du sol ;
 * m0 : capacité initiale / finale (3, ou 1,5 sur sol déjà saturé). Toute pluie au-delà de f
 * ruisselle : r = max(ruissellement SCS, pluie − f·dt).
 */
export const FC_MM_H = [30, 15, 7, 3]; // sol nu ou peu couvert ; ordres de grandeur des conductivités à saturation
export const HORTON_P = 20; // mm
export const hortonM0 = (amc) => (amc <= 2 ? 3 : amc >= 3 ? 1.5 : 3 - 1.5 * (amc - 2));
/** Capacité « illimitée » quand le plafond est désactivé (m/s). */
export const NO_CAP = 1e9;
/** Capacité d'infiltration (m/s) pour fc (m/s) et une pluie cumulée P (mm). */
export const infiltrationCap = (fc, P, m0) => fc * (1 + (m0 - 1) * Math.exp(-P / HORTON_P));

/** Ajuste le CN selon l'humidité initiale du sol (AMC I = sec, II = normal, III = humide). */
export function adjustCn(cn, amc) {
  if (cn >= 99) return cn;
  const c1 = cn / (2.281 - 0.01281 * cn);
  const c3 = cn / (0.427 + 0.00573 * cn);
  // Humidité continue (épisodes réels) : interpolation entre les classes I, II et III
  if (amc <= 1) return c1;
  if (amc >= 3) return c3;
  return amc < 2 ? c1 + (cn - c1) * (amc - 1) : cn + (c3 - cn) * (amc - 2);
}

export function retentionMm(cn) {
  return 25400 / Math.max(cn, 1) - 254;
}

/** Ruissellement cumulé Q (mm) pour une pluie cumulée P (mm). */
export function runoffMm(P, S) {
  const ia = IA_RATIO * S;
  if (P <= ia) return 0;
  return (P - ia) ** 2 / (P - ia + S);
}

/** Coefficient de ruissellement instantané dQ/dP. */
export function runoffRate(P, S) {
  const x = P - IA_RATIO * S;
  if (x <= 0) return 0;
  return 1 - (S * S) / ((x + S) * (x + S));
}

/**
 * Calcule pour chaque maille la rétention S (mm, -1 = pas de pluie) et le Manning n.
 * @param classes  indices de classe COSIA, `spc` échantillons consécutifs par maille
 *                 (CN et n moyennés par surface sur ces échantillons)
 * @param mask     1 = la pluie tombe sur cette maille (bassin versant), 0 sinon ; null = partout
 * @param soilGroup 0..3 pour A..D
 * @param amc      1, 2 ou 3
 * @param cnFactor multiplicateur global de calage de la capacité d'absorption du sol : rétention S
 *                 et capacité d'infiltration (1 = sans calage)
 */
export function buildRunoffFields(classes, mask, soilGroup, amc, cnFactor = 1, spc = 1, capInfiltration = true) {
  const n = classes.length / spc;
  const S = new Float32Array(n);
  const manning = new Float32Array(n);
  const fc = new Float32Array(n);
  const fcByClass = CLASSES.map((c) => (capInfiltration ? (FC_MM_H[soilGroup] * (c.fc ?? 1)) / 3.6e6 : NO_CAP));
  const cnByClass = CLASSES.map((c) => adjustCn(c.cn[soilGroup], amc));
  const nByClass = CLASSES.map((c) => c.n);
  for (let k = 0; k < n; k++) {
    let cn = 0;
    let nm = 0;
    let f = 0;
    for (let m = k * spc; m < (k + 1) * spc; m++) {
      cn += cnByClass[classes[m]];
      nm += nByClass[classes[m]];
      f += fcByClass[classes[m]];
    }
    fc[k] = (f / spc) * cnFactor;
    S[k] = mask && !mask[k] ? -1 : retentionMm(cn / spc) * cnFactor;
    manning[k] = nm / spc;
  }
  return { S, manning, fc };
}

/**
 * Ruissellement moyen (mm) sur le bassin pour un hyétogramme, plafond d'infiltration compris
 * (diagnostic, sans écoulement). Les mailles sont regroupées par couple (S, fc) arrondi.
 */
export function meanRunoffHyeto(S, fc, m0, hyeto, durationS, step = 300) {
  const groups = new Map();
  for (let k = 0; k < S.length; k++) {
    if (S[k] < 0) continue;
    const key = `${Math.round(S[k])}|${fc ? Math.round(fc[k] * 3.6e7) : -1}`;
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { s: Math.round(S[k]), fc: fc ? Math.round(fc[k] * 3.6e7) / 3.6e7 : null, n: 1 });
  }
  let sum = 0;
  let cnt = 0;
  for (const g of groups.values()) {
    let q = 0;
    for (let t = 0; t < durationS; t += step) {
      const dt = Math.min(step, durationS - t);
      const P0 = hyeto.cumulative(t);
      const P1 = hyeto.cumulative(t + dt);
      let r = runoffMm(P1, g.s) - runoffMm(P0, g.s);
      if (g.fc != null && g.fc < NO_CAP) r = Math.max(r, P1 - P0 - infiltrationCap(g.fc, 0.5 * (P0 + P1), m0) * dt * 1000);
      q += r;
    }
    sum += q * g.n;
    cnt += g.n;
  }
  return cnt ? sum / cnt : 0;
}

/** Ruissellement moyen (mm) attendu sur le bassin pour une pluie totale P (diagnostic). */
export function meanRunoff(S, P) {
  let sum = 0;
  let cnt = 0;
  for (let k = 0; k < S.length; k++) {
    if (S[k] < 0) continue;
    sum += runoffMm(P, S[k]);
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}
