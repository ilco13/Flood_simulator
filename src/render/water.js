// Rendu de la hauteur d'eau (quantifiée 8 bits) en image RGBA bleue semi-transparente.

import { dequantize } from '../sim/snapshots.js';

// Palettes de couleurs (de la lame d'eau la plus faible à la plus profonde).
export const PALETTES = {
  bleus: { label: 'Bleus (défaut)', colors: [[140, 205, 255], [80, 160, 240], [30, 110, 220], [15, 70, 180], [8, 40, 120], [5, 20, 70]] },
  viridis: { label: 'Viridis (jaune → violet)', colors: [[253, 231, 37], [122, 209, 81], [34, 168, 132], [42, 120, 142], [65, 68, 135], [68, 1, 84]] },
  alerte: { label: 'Alerte (jaune → rouge → violet)', colors: [[255, 237, 111], [254, 178, 76], [253, 106, 50], [227, 26, 28], [160, 0, 70], [80, 0, 90]] },
  cividis: { label: 'Cividis (lisible par les daltoniens)', colors: [[253, 234, 69], [190, 175, 111], [124, 123, 120], [83, 92, 136], [33, 62, 112], [0, 32, 77]] },
  turbo: { label: 'Arc-en-ciel (contraste maximal)', colors: [[70, 200, 250], [40, 240, 160], [190, 250, 50], [250, 190, 40], [240, 90, 20], [150, 20, 10]] },
};

// Paliers de hauteur (m) : chaque intervalle occupe la même part de la palette.
export const SCALES = {
  standard: { label: 'Standard : 10 cm à 4 m', breaks: [0.1, 0.2, 0.5, 1, 2, 4] },
  resserre: { label: 'Resserrés : 10 cm à 2 m, pas fins', breaks: [0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2] },
  fin: { label: 'Très resserrés : 5 cm à 1 m', breaks: [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1] },
  etendu: { label: 'Étendus : 10 cm à 8 m', breaks: [0.1, 0.5, 1, 2, 4, 8] },
};

// Ruissellement : lame d'eau mince (1 cm jusqu'au seuil d'inondation), en turquoise clair.
export const RUNOFF = { color: [60, 225, 190], a0: 0.28, a1: 0.5 };

const lerp = (a, b, t) => a + (b - a) * t;

/** Couleur de la palette à la position t ∈ [0, 1]. */
function paletteAt(colors, t) {
  const x = Math.min(1, Math.max(0, t)) * (colors.length - 1);
  const i = Math.min(colors.length - 2, Math.floor(x));
  const f = x - i;
  return colors[i].map((c, k) => Math.round(lerp(c, colors[i + 1][k], f)));
}

/** Position (0 à 1) d'une hauteur sur l'échelle : linéaire dans chaque intervalle. */
function scalePos(breaks, d) {
  if (d <= breaks[0]) return 0;
  for (let i = 0; i < breaks.length - 1; i++) {
    if (d <= breaks[i + 1]) return (i + (d - breaks[i]) / (breaks[i + 1] - breaks[i])) / (breaks.length - 1);
  }
  return 1;
}

/** Couleur RGB et opacité d'une hauteur d'eau pour une palette et une échelle. */
export function colorForDepth(d, palette = 'bleus', scale = 'standard') {
  const t = scalePos(SCALES[scale].breaks, d);
  return { rgb: paletteAt(PALETTES[palette].colors, t), alpha: lerp(0.5, 0.9, t) };
}

/** Paliers de la légende : hauteur et couleur à chaque limite d'intervalle. */
export function legendStops(palette = 'bleus', scale = 'standard') {
  const { breaks } = SCALES[scale];
  return breaks.map((d, i) => ({ d, rgb: paletteAt(PALETTES[palette].colors, i / (breaks.length - 1)) }));
}

/**
 * Table de correspondance valeur quantifiée -> pixel RGBA (Uint32, petit-boutiste).
 * L'inondation commence au premier palier de l'échelle ; en dessous, la lame de ruissellement
 * est dessinée en turquoise si `runoff`.
 */
export function buildLut({ runoff = false, palette = 'bleus', scale = 'standard' } = {}) {
  const threshold = SCALES[scale].breaks[0];
  const lut = new Uint32Array(256);
  for (let v = 1; v < 256; v++) {
    const d = dequantize(v);
    let r;
    let g;
    let b;
    let al;
    if (d < threshold) {
      if (!runoff || d < 0.01) continue;
      const t = Math.min(1, d / threshold);
      [r, g, b] = RUNOFF.color;
      al = Math.round(lerp(RUNOFF.a0, RUNOFF.a1, t) * 255);
    } else {
      const c = colorForDepth(d, palette, scale);
      [r, g, b] = c.rgb;
      al = Math.round(c.alpha * 255);
    }
    lut[v] = (al << 24) | (b << 16) | (g << 8) | r;
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
