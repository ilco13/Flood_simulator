// Classes COSIA (IGN, occupation du sol par IA) et paramètres hydrologiques associés.
//
// CN : Curve Number SCS pour les groupes hydrologiques de sol A, B, C, D (conditions
// moyennes, AMC II), d'après les tables USDA TR-55 (classes les plus proches).
// n : coefficient de Manning (s/m^(1/3)) pour l'écoulement en nappe à 5-25 m de maille.
// fc : multiplicateur de la capacité d'infiltration du sol (racines et litière des forêts : plus ;
//      croûte de battance des sols cultivés ou nus : moins ; surfaces étanches : 0).

export const CLASSES = [
  // id, nom, couleur légende COSIA, CN [A,B,C,D], n
  { name: 'Bâtiment', rgb: [206, 112, 121], cn: [98, 98, 98, 98], n: 0.1, fc: 0 },
  { name: 'Zone imperméable', rgb: [166, 170, 183], cn: [98, 98, 98, 98], n: 0.015, fc: 0 },
  { name: 'Zone perméable', rgb: [152, 119, 82], cn: [76, 85, 89, 91], n: 0.03, fc: 1.5 },
  { name: 'Piscine', rgb: [98, 208, 255], cn: [98, 98, 98, 98], n: 0.015, fc: 0 },
  { name: 'Serre', rgb: [61, 230, 235], cn: [98, 98, 98, 98], n: 0.02, fc: 0 },
  { name: 'Sol nu', rgb: [187, 176, 150], cn: [77, 86, 91, 94], n: 0.03, fc: 0.6 },
  { name: "Surface d'eau", rgb: [51, 117, 161], cn: [99, 99, 99, 99], n: 0.03, fc: 0 },
  { name: 'Neige', rgb: [233, 239, 254], cn: [98, 98, 98, 98], n: 0.02, fc: 0.5 },
  { name: 'Conifère', rgb: [18, 100, 33], cn: [30, 55, 70, 77], n: 0.12, fc: 5 },
  { name: 'Feuillu', rgb: [76, 145, 41], cn: [30, 55, 70, 77], n: 0.12, fc: 5 },
  { name: 'Coupe', rgb: [228, 142, 77], cn: [45, 66, 77, 83], n: 0.06, fc: 2 },
  { name: 'Broussaille', rgb: [181, 195, 53], cn: [35, 56, 70, 77], n: 0.08, fc: 4 },
  { name: 'Pelouse', rgb: [140, 215, 106], cn: [39, 61, 74, 80], n: 0.035, fc: 2.5 },
  { name: 'Culture', rgb: [222, 207, 85], cn: [67, 78, 85, 89], n: 0.04, fc: 1 },
  { name: 'Terre labourée', rgb: [208, 163, 73], cn: [72, 81, 88, 91], n: 0.035, fc: 0.8 },
  { name: 'Vigne', rgb: [176, 130, 144], cn: [62, 74, 82, 87], n: 0.045, fc: 0.7 },
  { name: 'Autre', rgb: [34, 34, 34], cn: [70, 80, 86, 90], n: 0.04, fc: 1.5 },
];

export const OTHER = CLASSES.length - 1;
export const SOIL_GROUPS = ['A', 'B', 'C', 'D'];

/** Convertit l'image COSIA (RGBA) en indices de classe (couleur la plus proche). */
export function classifyRgba(rgba, n) {
  const out = new Uint8Array(n);
  const memo = new Map();
  for (let k = 0; k < n; k++) {
    const r = rgba[4 * k];
    const g = rgba[4 * k + 1];
    const b = rgba[4 * k + 2];
    const a = rgba[4 * k + 3];
    if (a < 128) {
      out[k] = OTHER;
      continue;
    }
    const key = (r << 16) | (g << 8) | b;
    let c = memo.get(key);
    if (c === undefined) {
      let best = Infinity;
      c = OTHER;
      for (let m = 0; m < CLASSES.length; m++) {
        const p = CLASSES[m].rgb;
        const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
        if (d < best) {
          best = d;
          c = m;
        }
      }
      // Couleur trop éloignée de la légende (bord antialiasé, étiquette…) : « Autre ».
      if (best > 60 * 60) c = OTHER;
      memo.set(key, c);
    }
    out[k] = c;
  }
  return out;
}

/** Statistiques de surface par classe (fractions). */
export function classFractions(classes) {
  const counts = new Float64Array(CLASSES.length);
  for (let k = 0; k < classes.length; k++) counts[classes[k]]++;
  return Array.from(counts, (c) => c / classes.length);
}
