// Analyse du relief par « priority-flood » (Barnes et al., 2014) :
//  - délimitation du bassin versant : chaque maille hérite de l'étiquette de la maille de
//    bord par laquelle elle s'évacue ; le bassin de l'Arc = l'étiquette de l'exutoire ;
//  - débrèchage contraint (Lindsay, 2016) : les petites cuvettes artificielles créées par le
//    rééchantillonnage du MNT (thalweg plus étroit que la maille, connexion seulement en
//    diagonale…) sont ouvertes en creusant un court passage. Les vraies cuvettes (retenues,
//    carrières, bassins) trop profondes ou trop longues à percer sont conservées.

class MinHeap {
  constructor(capacity) {
    this.keys = new Float32Array(capacity); // altitudes en float32 : pas besoin de plus
    this.vals = new Int32Array(capacity);
    this.size = 0;
  }
  push(key, val) {
    let i = this.size++;
    const { keys, vals } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }
  pop() {
    const { keys, vals } = this;
    const top = vals[0];
    const lastK = keys[--this.size];
    const lastV = vals[this.size];
    let i = 0;
    const n = this.size;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= lastK) break;
      keys[i] = keys[c];
      vals[i] = vals[c];
      i = c;
    }
    keys[i] = lastK;
    vals[i] = lastV;
    return top;
  }
}

/**
 * Retourne pour chaque maille l'indice de la maille de bord vers laquelle elle s'écoule,
 * ainsi que le MNT « rempli » (dépressions comblées).
 * Si `breach` est fourni ({ maxDepth, maxLength }), z est modifié en place pour ouvrir les
 * petites cuvettes, en connexité 4 (celle du modèle hydraulique).
 */
export function drainageLabels(z, nx, ny, breach = null) {
  const N = nx * ny;
  const label = new Int32Array(N).fill(-1);
  const filled = new Float32Array(N);
  const parent = new Int32Array(N).fill(-1);
  const eps = 1e-3;
  let breached = 0;
  // Le tas peut contenir chaque maille une fois.
  const heap = new MinHeap(N);
  for (let i = 0; i < nx; i++) {
    for (const j of [0, ny - 1]) {
      const k = j * nx + i;
      if (label[k] !== -1) continue;
      label[k] = k;
      filled[k] = z[k];
      heap.push(z[k], k);
    }
  }
  for (let j = 1; j < ny - 1; j++) {
    for (const i of [0, nx - 1]) {
      const k = j * nx + i;
      if (label[k] !== -1) continue;
      label[k] = k;
      filled[k] = z[k];
      heap.push(z[k], k);
    }
  }
  const di = [1, -1, 0, 0];
  const dj = [0, 0, 1, -1];
  while (heap.size > 0) {
    const k = heap.pop();
    const i = k % nx;
    const j = (k - i) / nx;
    const level = filled[k];
    for (let d = 0; d < 4; d++) {
      const ii = i + di[d];
      const jj = j + dj[d];
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const kk = jj * nx + ii;
      if (label[kk] !== -1) continue;
      label[kk] = label[k];
      parent[kk] = k;
      const zn = z[kk];
      if (zn >= level) {
        filled[kk] = zn;
      } else if (breach && tryBreach(z, parent, k, zn, breach, eps)) {
        filled[kk] = zn;
        breached++;
      } else {
        filled[kk] = level;
      }
      heap.push(filled[kk], kk);
    }
  }
  return { label, filled, breached };
}

/** Creuse un passage descendant depuis la cuvette (cote zn) en remontant la chaîne `parent`. */
function tryBreach(z, parent, start, zn, { maxDepth, maxLength }, eps) {
  let p = start;
  let i = 1;
  for (;;) {
    const target = zn - eps * i;
    if (z[p] <= target) break; // le passage rejoint un terrain plus bas : ok
    if (z[p] - target > maxDepth || i > maxLength) return false;
    if (parent[p] === -1) break; // bord du domaine : l'eau sort
    p = parent[p];
    i++;
  }
  p = start;
  i = 1;
  while (p !== -1) {
    const target = zn - eps * i;
    if (z[p] <= target) break;
    z[p] = target;
    p = parent[p];
    i++;
  }
  return true;
}

/** Masque (Uint8) des mailles drainées vers la même sortie que la maille `outletK`. */
export function basinMask(label, outletK) {
  const target = label[outletK];
  const mask = new Uint8Array(label.length);
  let area = 0;
  for (let k = 0; k < label.length; k++) {
    if (label[k] === target) {
      mask[k] = 1;
      area++;
    }
  }
  return { mask, cells: area };
}

/** Contour du masque sous forme de segments (pour l'affichage). Renvoie des anneaux grossiers. */
export function maskOutline(mask, nx, ny) {
  // Segments de bord entre maille dedans / dehors, en coordonnées de grille (coins).
  const segs = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!mask[k]) continue;
      if (j === 0 || !mask[k - nx]) segs.push([i, j, i + 1, j]);
      if (j === ny - 1 || !mask[k + nx]) segs.push([i + 1, j + 1, i, j + 1]);
      if (i === 0 || !mask[k - 1]) segs.push([i, j + 1, i, j]);
      if (i === nx - 1 || !mask[k + 1]) segs.push([i + 1, j, i + 1, j + 1]);
    }
  }
  // Chaînage des segments en anneaux.
  const key = (x, y) => y * (nx + 1) + x;
  const starts = new Map();
  for (let s = 0; s < segs.length; s++) {
    const kk = key(segs[s][0], segs[s][1]);
    if (!starts.has(kk)) starts.set(kk, []);
    starts.get(kk).push(s);
  }
  const used = new Uint8Array(segs.length);
  const rings = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    const ring = [[segs[s][0], segs[s][1]]];
    let cur = s;
    while (cur !== -1 && !used[cur]) {
      used[cur] = 1;
      const [, , x1, y1] = segs[cur];
      ring.push([x1, y1]);
      const cands = starts.get(key(x1, y1)) || [];
      cur = -1;
      for (const c of cands) {
        if (!used[c]) {
          cur = c;
          break;
        }
      }
    }
    if (ring.length > 8) rings.push(ring);
  }
  return rings;
}
