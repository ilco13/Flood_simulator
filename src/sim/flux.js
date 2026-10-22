// Débit de l'eau pour l'affichage : intensité par maille (débit par mètre de largeur, m²/s)
// et direction moyenne par blocs de mailles (flèches). Calculés à chaque instantané à partir
// des flux aux faces du solveur (qx vers l'est, qy vers le sud, en m²/s).

// Plafond et seuil de l'échelle quantifiée (racine carrée, comme les hauteurs).
export const FLOW_CAP = 30; // m²/s
const MIN_FLOW = 0.002;
// Nombre de blocs visé sur le plus grand côté (flèches).
const BLOCKS = 240;
// Résolution des vecteurs stockés (m²/s).
const VSCALE = 0.005;

/**
 * @returns {{ qm: Float32Array, ang: Uint8Array, vec: { B, bx, by, fx: Float32Array, fy: Float32Array } }}
 *   qm : débit unitaire par maille ; ang : direction par maille (1/256 de tour, depuis l'est
 *   vers le sud) ; fx, fy : moyenne par bloc (fx vers l'est, fy vers le sud).
 */
export function fluxFields(qx, qy, nx, ny) {
  const N = nx * ny;
  const qm = new Float32Array(N);
  const ang = new Uint8Array(N);
  const B = Math.max(1, Math.ceil(Math.max(nx, ny) / BLOCKS));
  const bx = Math.ceil(nx / B);
  const by = Math.ceil(ny / B);
  const fx = new Float32Array(bx * by);
  const fy = new Float32Array(bx * by);
  const cnt = new Uint16Array(bx * by);
  for (let j = 0; j < ny; j++) {
    const bj = Math.floor(j / B) * bx;
    for (let i = 0; i < nx; i++) {
      const ux = 0.5 * (qx[j * (nx + 1) + i] + qx[j * (nx + 1) + i + 1]);
      const uy = 0.5 * (qy[j * nx + i] + qy[(j + 1) * nx + i]);
      const k = j * nx + i;
      qm[k] = Math.hypot(ux, uy);
      if (qm[k] > MIN_FLOW) ang[k] = Math.round(((Math.atan2(uy, ux) / (2 * Math.PI) + 1) % 1) * 256) & 255;
      const b = bj + Math.floor(i / B);
      fx[b] += ux;
      fy[b] += uy;
      cnt[b]++;
    }
  }
  for (let b = 0; b < fx.length; b++)
    if (cnt[b]) {
      fx[b] /= cnt[b];
      fy[b] /= cnt[b];
    }
  return { qm, ang, vec: { B, bx, by, fx, fy } };
}

export function quantizeFlow(qm) {
  const out = new Uint8Array(qm.length);
  const inv = 1 / FLOW_CAP;
  for (let k = 0; k < qm.length; k++) {
    const v = qm[k];
    if (v < MIN_FLOW) continue;
    out[k] = Math.max(1, Math.min(255, Math.round(Math.sqrt(Math.min(v, FLOW_CAP) * inv) * 255)));
  }
  return out;
}

export function dequantizeFlow(v) {
  const r = v / 255;
  return r * r * FLOW_CAP;
}

/** Vecteurs par bloc → Int16 (x puis y), précision 5 mm²/s. */
export function packVec(vec) {
  const n = vec.fx.length;
  const out = new Int16Array(2 * n);
  for (let b = 0; b < n; b++) {
    out[b] = Math.max(-32767, Math.min(32767, Math.round(vec.fx[b] / VSCALE)));
    out[n + b] = Math.max(-32767, Math.min(32767, Math.round(vec.fy[b] / VSCALE)));
  }
  return out;
}

export function unpackVec(i16, B, bx, by) {
  const n = bx * by;
  const fx = new Float32Array(n);
  const fy = new Float32Array(n);
  for (let b = 0; b < n; b++) {
    fx[b] = i16[b] * VSCALE;
    fy[b] = i16[n + b] * VSCALE;
  }
  return { B, bx, by, fx, fy };
}
