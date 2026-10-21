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

const R_EARTH = 6378137;
const toMerc = ([lon, lat]) => [
  (R_EARTH * lon * Math.PI) / 180,
  R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
];
const fromMerc = (x, y) => [(x / R_EARTH) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R_EARTH)) - Math.PI / 2) * (180 / Math.PI)];

/**
 * Image de la hauteur d'eau, reprojetée en Web Mercator (projection de la carte).
 * La grille de calcul est en Lambert 93 : posée telle quelle par ses 4 coins, MapLibre la
 * déformerait de façon affine et l'eau serait décalée jusqu'à ~50 m au milieu d'une grande
 * grille. Ici chaque pixel de l'image (rectangle aligné sur la carte) pointe vers sa maille,
 * via une table calculée une fois (projection exacte sur un treillis, interpolée entre).
 * @param grid  grille Lambert 93 { xmin, ymax, dx, nx, ny }
 * @param toWgs fonction [x, y] L93 -> [lon, lat]
 * @param toL93 fonction (lon, lat) -> [x, y] L93
 */
export class WaterCanvas {
  constructor(grid, toWgs, toL93) {
    const { nx, ny, dx, xmin, ymax } = grid;
    // Emprise Mercator de la grille (bords échantillonnés : ils sont légèrement courbes)
    let mx0 = Infinity;
    let mx1 = -Infinity;
    let my0 = Infinity;
    let my1 = -Infinity;
    const E = 24;
    for (let k = 0; k <= E; k++) {
      for (const [gx, gy] of [[k / E, 0], [k / E, 1], [0, k / E], [1, k / E]]) {
        const [mx, my] = toMerc(toWgs(xmin + gx * nx * dx, ymax - gy * ny * dx));
        mx0 = Math.min(mx0, mx);
        mx1 = Math.max(mx1, mx);
        my0 = Math.min(my0, my);
        my1 = Math.max(my1, my);
      }
    }
    // Taille de pixel : une demi-maille sur les petites grilles (bords nets malgré la rotation),
    // une maille au-delà ; au plus 8192 pixels de côté.
    const lat = fromMerc(0, (my0 + my1) / 2)[1];
    const f = nx * ny <= 1.5e6 ? 2 : 1;
    let pm = dx / f / Math.cos((lat * Math.PI) / 180);
    pm = Math.max(pm, (mx1 - mx0) / 8192, (my1 - my0) / 8192);
    const W = Math.max(1, Math.ceil((mx1 - mx0) / pm));
    const H = Math.max(1, Math.ceil((my1 - my0) / pm));
    mx1 = mx0 + W * pm;
    my0 = my1 - H * pm;
    // Treillis de correspondance pixel -> maille (exact aux nœuds, interpolé entre eux)
    const S = 16;
    const LW = Math.ceil(W / S) + 1;
    const LH = Math.ceil(H / S) + 1;
    const lgx = new Float64Array(LW * LH);
    const lgy = new Float64Array(LW * LH);
    for (let lj = 0; lj < LH; lj++)
      for (let li = 0; li < LW; li++) {
        const [lon, la] = fromMerc(mx0 + li * S * pm, my1 - lj * S * pm);
        const [x, y] = toL93(lon, la);
        lgx[lj * LW + li] = (x - xmin) / dx;
        lgy[lj * LW + li] = (ymax - y) / dx;
      }
    const map = new Int32Array(W * H);
    for (let j = 0; j < H; j++) {
      const fy = (j + 0.5) / S;
      const lj = Math.min(LH - 2, Math.floor(fy));
      const ty = fy - lj;
      for (let i = 0; i < W; i++) {
        const fx = (i + 0.5) / S;
        const li = Math.min(LW - 2, Math.floor(fx));
        const tx = fx - li;
        const a = lj * LW + li;
        const gx =
          (1 - ty) * ((1 - tx) * lgx[a] + tx * lgx[a + 1]) + ty * ((1 - tx) * lgx[a + LW] + tx * lgx[a + LW + 1]);
        const gy =
          (1 - ty) * ((1 - tx) * lgy[a] + tx * lgy[a + 1]) + ty * ((1 - tx) * lgy[a + LW] + tx * lgy[a + LW + 1]);
        const ci = Math.floor(gx);
        const cj = Math.floor(gy);
        map[j * W + i] = ci >= 0 && cj >= 0 && ci < nx && cj < ny ? cj * nx + ci : -1;
      }
    }
    this.map = map;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(W, H);
    this.px = new Uint32Array(this.image.data.buffer);
    // Coins pour MapLibre : NO, NE, SE, SO (rectangle aligné sur la carte)
    const nw = fromMerc(mx0, my1);
    const se = fromMerc(mx1, my0);
    this.corners = [nw, [se[0], nw[1]], se, [nw[0], se[1]]];
  }
  draw(q, lut) {
    const { px, map } = this;
    for (let o = 0; o < map.length; o++) {
      const k = map[o];
      px[o] = k >= 0 ? lut[q[k]] : 0;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
  clear() {
    this.px.fill(0);
    this.ctx.putImageData(this.image, 0, 0);
  }
}
