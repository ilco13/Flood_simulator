// Rendu de la hauteur d'eau (quantifiée 8 bits) en image RGBA bleue semi-transparente.

import { dequantize } from '../sim/snapshots.js';

// Palette : bleu clair (lame d'eau) -> bleu nuit (> 2 m).
const STOPS = [
  [0.0, [140, 205, 255], 0.45],
  [0.2, [80, 160, 240], 0.55],
  [0.5, [30, 110, 220], 0.65],
  [1.0, [15, 70, 180], 0.75],
  [2.0, [8, 40, 120], 0.85],
  [4.0, [5, 20, 70], 0.9],
];

// Ruissellement : lame d'eau mince (1 cm jusqu'au seuil d'inondation), en turquoise clair.
const RUNOFF = { color: [60, 225, 190], a0: 0.28, a1: 0.5 };

export const LEGEND = [
  { label: 'ruissellement < 10 cm', color: RUNOFF.color, runoff: true },
  { label: '10–20 cm', color: STOPS[0][1] },
  { label: '20–50 cm', color: STOPS[1][1] },
  { label: '0,5–1 m', color: STOPS[2][1] },
  { label: '1–2 m', color: STOPS[3][1] },
  { label: '2–4 m', color: STOPS[4][1] },
  { label: '> 4 m', color: STOPS[5][1] },
];

export function colorForDepth(d) {
  let s = STOPS[0];
  for (const st of STOPS) if (d >= st[0]) s = st;
  return s;
}

/**
 * Table de correspondance valeur quantifiée -> pixel RGBA (Uint32, petit-boutiste).
 * Sous le seuil d'inondation, la lame de ruissellement est dessinée en turquoise si `runoff`.
 */
export function buildLut(threshold, runoff = false) {
  const lut = new Uint32Array(256);
  for (let v = 1; v < 256; v++) {
    const d = dequantize(v);
    if (d < threshold) {
      if (runoff && d >= 0.01) {
        const t = Math.min(1, d / threshold);
        const al = Math.round((RUNOFF.a0 + (RUNOFF.a1 - RUNOFF.a0) * t) * 255);
        const [r, g, b] = RUNOFF.color;
        lut[v] = (al << 24) | (b << 16) | (g << 8) | r;
      }
      continue;
    }
    // Interpolation entre le dernier palier atteint et le suivant
    let i = 0;
    while (i < STOPS.length - 1 && d >= STOPS[i + 1][0]) i++;
    const a = STOPS[i];
    const b = STOPS[Math.min(i + 1, STOPS.length - 1)];
    const t = a === b ? 0 : (d - a[0]) / (b[0] - a[0]);
    const r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * t);
    const g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * t);
    const bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * t);
    const al = Math.round((a[2] + (b[2] - a[2]) * t) * 255);
    lut[v] = (al << 24) | (bl << 16) | (g << 8) | r;
  }
  return lut;
}

export class WaterCanvas {
  constructor(nx, ny) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = nx;
    this.canvas.height = ny;
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(nx, ny);
    this.px = new Uint32Array(this.image.data.buffer);
  }
  draw(q, lut) {
    const px = this.px;
    for (let k = 0; k < q.length; k++) px[k] = lut[q[k]];
    this.ctx.putImageData(this.image, 0, 0);
  }
  clear() {
    this.px.fill(0);
    this.ctx.putImageData(this.image, 0, 0);
  }
}
