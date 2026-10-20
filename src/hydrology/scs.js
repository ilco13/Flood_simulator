// Méthode SCS Curve Number : pluie nette (ruissellement) à partir de la pluie brute.
//   S  = 25400 / CN - 254          (rétention potentielle, mm)
//   Ia = 0,2 S                     (pertes initiales, mm)
//   Q  = (P - Ia)² / (P - Ia + S)  si P > Ia, sinon 0
// Le modèle 2D a besoin du taux instantané : dQ/dP = 1 - S² / (P - Ia + S)².

import { CLASSES } from './landcover.js';

export const IA_RATIO = 0.2;

/** Ajuste le CN selon l'humidité initiale du sol (AMC I = sec, II = normal, III = humide). */
export function adjustCn(cn, amc) {
  if (cn >= 99) return cn;
  if (amc === 1) return cn / (2.281 - 0.01281 * cn);
  if (amc === 3) return cn / (0.427 + 0.00573 * cn);
  return cn;
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
 * @param classes  indices de classe COSIA
 * @param mask     1 = la pluie tombe sur cette maille (bassin versant), 0 sinon ; null = partout
 * @param soilGroup 0..3 pour A..D
 * @param amc      1, 2 ou 3
 * @param cnFactor multiplicateur global de calage sur S (1 = sans calage)
 */
export function buildRunoffFields(classes, mask, soilGroup, amc, cnFactor = 1) {
  const n = classes.length;
  const S = new Float32Array(n);
  const manning = new Float32Array(n);
  const sByClass = CLASSES.map((c) => retentionMm(adjustCn(c.cn[soilGroup], amc)) * cnFactor);
  for (let k = 0; k < n; k++) {
    const c = classes[k];
    S[k] = mask && !mask[k] ? -1 : sByClass[c];
    manning[k] = CLASSES[c].n;
  }
  return { S, manning };
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
