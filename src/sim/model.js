// Préparation des entrées du modèle à partir des données brutes.

import { burnRivers, riverDirectionAt, rasterizeLine, isBurnable, STRUCT_MIN_BUMP } from '../data/rivers.js';
import { drainageLabels, basinMask, accumulation, upstreamMask, flowDirections } from '../hydrology/terrain.js';
import { buildRunoffFields, hortonM0 } from '../hydrology/scs.js';
import { cellOf } from '../geo.js';

/**
 * Prétraitements indépendants de la pluie : gravure du réseau, bassin versant.
 * @returns {{ z: Float32Array, mask: Uint8Array, basinCells: number, burned: number, breached: number }}
 */
export function prepareTerrain({ grid, dem, rivers, burnDepth, outlet, upstreamOf, obstacles, buildings, structures = false }) {
  const z = dem.slice();
  const raw = structures ? [] : null;
  const burned = rivers && burnDepth > 0 ? burnRivers(grid, z, rivers, burnDepth, undefined, raw) : 0;
  // Ouvrages sous les routes : remblai rétabli, l'eau passe par l'ouvrage (capacité limitée)
  const structs = raw?.length ? selectStructures(grid, z, dem, raw) : [];
  // Ouvrages dessinés par l'utilisateur (absents du MNT, qui est un modèle du sol nu).
  let protect = obstacles?.length ? applyObstacles(grid, z, obstacles) : null;
  if (structs.length) {
    protect ??= new Uint8Array(z.length);
    for (const s of structs) for (const k of s.cells) protect[k] = 1;
  }
  // Bâtiments BD TOPO : mailles bâties à plus de moitié relevées ; les autres gardent le
  // passage, avec un frottement accru (renvoyé dans bldFrac).
  let bld = null;
  if (buildings?.length) {
    bld = applyBuildings(grid, z, buildings, rivers);
    if (!protect) protect = bld.protect;
    else for (let k = 0; k < protect.length; k++) protect[k] |= bld.protect[k];
  }
  const extra = bld ? { bldFrac: bld.frac, bldCells: bld.cells, bldCount: buildings.length } : {};
  if (structs.length) extra.structures = structs;
  // Mailles du lit des cours d'eau BD TOPO : frottement d'un lit naturel (voir buildModel)
  if (rivers) extra.channel = channelMask(grid, rivers);
  const { label, breached, parent, order, filled } = drainageLabels(z, grid.nx, grid.ny, {
    maxDepth: Math.max(2, 0.3 * grid.dx),
    maxLength: Math.max(4, Math.round(300 / grid.dx)),
    protect,
  });
  let mask = null;
  let basinCells = grid.nx * grid.ny;
  const c = outlet && cellOf(grid, outlet.x, outlet.y);
  if (c) {
    // L'exutoire est sur l'Arc : on prend la maille de plus faible altitude autour du point
    // pour être sûr d'être dans le lit.
    let best = c.k;
    for (let dj = -3; dj <= 3; dj++)
      for (let di = -3; di <= 3; di++) {
        const i = c.i + di;
        const j = c.j + dj;
        if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
        const k = j * grid.nx + i;
        if (z[k] < z[best]) best = k;
      }
    const r = basinMask(label, best);
    mask = r.mask;
    basinCells = r.cells;
  } else if (upstreamOf) {
    // Bassin versant d'un ou plusieurs points : toutes les mailles en amont (union).
    const pts = Array.isArray(upstreamOf) ? upstreamOf : [upstreamOf];
    const down = flowDirections(filled, parent, order, grid.nx, grid.ny);
    const acc = accumulation(down, order);
    // Surface drainée par chaque ouvrage (pour sa capacité par défaut)
    // (plus forte accumulation autour des mailles amont et aval : derrière le remblai, le
    // relief comblé est plat et l'écoulement D8 peut éviter la maille amont)
    for (const st of structs) {
      let m = 0;
      for (const k0 of [st.up, st.down]) {
        const i0 = k0 % grid.nx;
        const j0 = (k0 - i0) / grid.nx;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const i = i0 + di;
            const j = j0 + dj;
            if (i >= 0 && j >= 0 && i < grid.nx && j < grid.ny) m = Math.max(m, acc[j * grid.nx + i]);
          }
      }
      st.areaKm2 = (m * grid.dx * grid.dx) / 1e6;
    }
    const outletKs = [];
    for (const pt of pts) {
      const k = snapToStream(grid, acc, pt);
      if (k < 0) continue;
      outletKs.push(k);
      const r = upstreamMask(down, order, k);
      if (!mask) mask = r.mask;
      else for (let n = 0; n < mask.length; n++) mask[n] |= r.mask[n];
    }
    if (mask) {
      basinCells = 0;
      for (let n = 0; n < mask.length; n++) basinCells += mask[n];
      return { z, mask, basinCells, burned, breached, outletK: outletKs[0], outletKs, acc, ...extra };
    }
  }
  return { z, mask, basinCells, burned, breached, ...extra };
}

/**
 * Ouvrages sous les routes retenus : remblai court (au plus 60 m ou 2 mailles le long du cours
 * d'eau) qui barre vraiment la vallée : pour passer de l'amont à l'aval sans le traverser, l'eau
 * doit monter d'au moins STRUCT_MIN_BUMP (sinon ce n'est qu'une bosse du lit, contournée). Son
 * relief d'origine est rétabli ; une maille ne sert qu'à un ouvrage.
 */
export function selectStructures(grid, z, dem, raw) {
  const { nx, dx, xmin, ymax } = grid;
  const used = new Set();
  const out = [];
  for (const s of raw) {
    if (s.cells.length * dx > Math.max(60, 2 * dx)) continue;
    const ks = [s.up, s.down, ...s.cells];
    if (ks.some((k) => used.has(k))) continue;
    const spill = bypassLevel(grid, dem, s);
    const crest = Math.min(s.crest, spill);
    if (crest - (s.base ?? Math.max(dem[s.up], dem[s.down])) <= STRUCT_MIN_BUMP) continue;
    ks.forEach((k) => used.add(k));
    for (const k of s.cells) z[k] = dem[k];
    const mid = s.cells[s.cells.length >> 1];
    const i = mid % nx;
    const j = (mid - i) / nx;
    out.push({ up: s.up, down: s.down, cells: s.cells, invert: s.invert, crest, x: xmin + (i + 0.5) * dx, y: ymax - (j + 0.5) * dx });
  }
  return out;
}

/**
 * Niveau le plus bas à atteindre pour aller de la maille amont à la maille aval sans passer
 * par le remblai (chemin dont le point le plus haut est le plus bas), dans un carré d'environ
 * 50 m autour ; Infinity si le remblai barre tout le carré.
 */
export function bypassLevel(grid, dem, s) {
  const { nx, ny, dx } = grid;
  const R = Math.max(3, Math.ceil(50 / dx));
  const i0 = s.up % nx;
  const j0 = (s.up - i0) / nx;
  const W = 2 * R + 1;
  const blocked = new Set(s.cells);
  const best = new Float64Array(W * W).fill(Infinity);
  const doneW = new Uint8Array(W * W);
  const loc = (k) => {
    const i = k % nx;
    const j = (k - i) / nx;
    const a = i - i0 + R;
    const b = j - j0 + R;
    return a < 0 || b < 0 || a >= W || b >= W ? -1 : b * W + a;
  };
  const target = loc(s.down);
  if (target < 0) return Infinity;
  best[R * W + R] = dem[s.up];
  for (;;) {
    let m = -1;
    for (let q = 0; q < W * W; q++) if (!doneW[q] && best[q] < Infinity && (m < 0 || best[q] < best[m])) m = q;
    if (m < 0) return Infinity;
    if (m === target) return best[m];
    doneW[m] = 1;
    const a = m % W;
    const b = (m - a) / W;
    for (let db = -1; db <= 1; db++)
      for (let da = -1; da <= 1; da++) {
        if (!da && !db) continue;
        if (da && db) continue; // 4 voisins : pas de passage en diagonale entre deux mailles du remblai
        const aa = a + da;
        const bb = b + db;
        if (aa < 0 || bb < 0 || aa >= W || bb >= W) continue;
        const i = i0 - R + aa;
        const j = j0 - R + bb;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const k = j * nx + i;
        if (blocked.has(k)) continue;
        const q = bb * W + aa;
        const v = Math.max(best[m], dem[k]);
        if (v < best[q]) best[q] = v;
      }
  }
}

/** Mailles traversées par un cours d'eau BD TOPO à ciel ouvert (gravé dans le relief). */
export function channelMask(grid, rivers) {
  const m = new Uint8Array(grid.nx * grid.ny);
  for (const f of rivers?.features || []) {
    if (!isBurnable(f)) continue;
    const g = f.geometry;
    const parts = g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : [];
    for (const part of parts) rasterizeLine(grid, part, (k) => (m[k] = 1));
  }
  return m;
}

/** Frottement (Manning) d'un lit naturel de cours d'eau. */
export const N_CHANNEL = 0.035;

/** Part bâtie de chaque maille (0–1) et hauteur du plus haut bâtiment qui la couvre. */
export function buildingCoverage(grid, buildings) {
  const { nx, ny, dx, xmin, ymax } = grid;
  // Sous-maillage d'environ 1 m (au plus 8 × 8 points par maille)
  const f = Math.max(1, Math.min(8, Math.round(dx)));
  const s = dx / f;
  const W = nx * f;
  const H = ny * f;
  const cnt = new Uint16Array(nx * ny);
  const hmax = new Float32Array(nx * ny);
  for (const b of buildings) {
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const ring of b.rings)
      for (const [, y] of ring) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    const r0 = Math.max(0, Math.floor((ymax - y1) / s));
    const r1 = Math.min(H - 1, Math.ceil((ymax - y0) / s));
    for (let r = r0; r <= r1; r++) {
      const yc = ymax - (r + 0.5) * s;
      const xs = [];
      for (const ring of b.rings)
        for (let a = 0, c = ring.length - 1; a < ring.length; c = a++) {
          const [xa, ya] = ring[a];
          const [xb, yb] = ring[c];
          if ((ya > yc) !== (yb > yc)) xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
        }
      if (xs.length < 2) continue;
      xs.sort((u, v) => u - v);
      const j = Math.floor(r / f);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const c0 = Math.max(0, Math.ceil((xs[m] - xmin) / s - 0.5));
        const c1 = Math.min(W - 1, Math.floor((xs[m + 1] - xmin) / s - 0.5));
        for (let c = c0; c <= c1; c++) {
          const k = j * nx + Math.floor(c / f);
          cnt[k]++;
          if (b.h > hmax[k]) hmax[k] = b.h;
        }
      }
    }
  }
  const frac = new Float32Array(nx * ny);
  const inv = 1 / (f * f);
  for (let k = 0; k < frac.length; k++) frac[k] = Math.min(1, cnt[k] * inv);
  return { frac, hmax };
}

/**
 * Relève les mailles bâties à plus de moitié (hauteur du bâtiment, 15 m au plus), sauf celles
 * d'un cours d'eau BD TOPO (rivière couverte, passage sous un bâtiment).
 */
export function applyBuildings(grid, z, buildings, rivers) {
  const { frac, hmax } = buildingCoverage(grid, buildings);
  const river = new Uint8Array(z.length);
  for (const f of rivers?.features || []) {
    if (!isBurnable(f)) continue;
    const g = f.geometry;
    const parts = g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : [];
    for (const part of parts) rasterizeLine(grid, part, (k) => (river[k] = 1));
  }
  const protect = new Uint8Array(z.length);
  let cells = 0;
  for (let k = 0; k < z.length; k++) {
    if (frac[k] >= 0.5 && !river[k]) {
      z[k] += Math.min(15, hmax[k]);
      protect[k] = 1;
      frac[k] = 1;
      cells++;
    } else if (river[k]) frac[k] = 0;
  }
  return { frac, protect, cells };
}

/**
 * Ajoute au relief les ouvrages dessinés (coordonnées Lambert 93) :
 *  - bâtiment (polygone) : mailles dont le centre est dedans relevées de `h` (au moins la maille
 *    du centre de gravité pour un petit bâtiment) ; l'eau le contourne ;
 *  - mur (ligne) : mailles traversées (chemin 4-connexe, étanche pour l'écoulement) relevées de `h`.
 * Renvoie le masque des mailles modifiées (protégées du débrèchage).
 */
export function applyObstacles(grid, z, obstacles) {
  const { nx, ny, dx, xmin, ymax } = grid;
  const protect = new Uint8Array(nx * ny);
  const raise = new Float32Array(nx * ny);
  for (const o of obstacles) {
    const h = Math.max(0, Number(o.h) || 0);
    if (!h || !o.pts?.length) continue;
    if (o.type === 'wall') {
      rasterizeLine(grid, o.pts, (k) => {
        raise[k] = Math.max(raise[k], h);
      });
      continue;
    }
    // Polygone : remplissage par lignes (centres de mailles)
    const P = o.pts;
    let ymin = Infinity;
    let ymx = -Infinity;
    for (const [, y] of P) {
      ymin = Math.min(ymin, y);
      ymx = Math.max(ymx, y);
    }
    let any = false;
    const j0 = Math.max(0, Math.floor((ymax - ymx) / dx));
    const j1 = Math.min(ny - 1, Math.ceil((ymax - ymin) / dx));
    for (let j = j0; j <= j1; j++) {
      const yc = ymax - (j + 0.5) * dx;
      const xs = [];
      for (let a = 0, b = P.length - 1; a < P.length; b = a++) {
        const [xa, ya] = P[a];
        const [xb, yb] = P[b];
        if ((ya > yc) !== (yb > yc)) xs.push(xa + ((yc - ya) * (xb - xa)) / (yb - ya));
      }
      xs.sort((u, v) => u - v);
      for (let m = 0; m + 1 < xs.length; m += 2) {
        const i0 = Math.max(0, Math.ceil((xs[m] - xmin) / dx - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((xs[m + 1] - xmin) / dx - 0.5));
        for (let i = i0; i <= i1; i++) {
          raise[j * nx + i] = Math.max(raise[j * nx + i], h);
          any = true;
        }
      }
    }
    if (!any) {
      const cx = P.reduce((a, p) => a + p[0], 0) / P.length;
      const cy = P.reduce((a, p) => a + p[1], 0) / P.length;
      const c = cellOf(grid, cx, cy);
      if (c) raise[c.k] = Math.max(raise[c.k], h);
    }
  }
  for (let k = 0; k < raise.length; k++)
    if (raise[k] > 0) {
      z[k] += raise[k];
      protect[k] = 1;
    }
  return protect;
}

/** Relief conditionné et réseau d'écoulement D8 (pour délimiter des bassins versants). */
export function flowModel({ grid, dem, rivers, burnDepth }) {
  const z = dem.slice();
  // Délimitation des bassins : on traverse aussi les barrages (un lac se déverse vers l'aval).
  if (rivers && burnDepth > 0) burnRivers(grid, z, rivers, burnDepth, Infinity);
  const { parent, order, filled } = drainageLabels(z, grid.nx, grid.ny, {
    maxDepth: Math.max(2, 0.3 * grid.dx),
    maxLength: Math.max(4, Math.round(300 / grid.dx)),
  });
  const down = flowDirections(filled, parent, order, grid.nx, grid.ny);
  return { z, down, order, acc: accumulation(down, order) };
}

/**
 * Cale le point choisi sur le cours d'eau voisin, dans un rayon `radiusM` :
 *  - par défaut : la maille la plus drainée (rayon ~60 m) ;
 *  - `areaM2` (surface attendue, connue sur une autre grille) : la maille dont la surface
 *    drainée en est la plus proche ;
 *  - `minAreaM2` (surface minimale, bassin tronqué sur une grille plus petite) : la plus
 *    petite surface drainée qui la dépasse, pour rester sur le même cours d'eau sans sauter
 *    dans une rivière plus grosse toute proche.
 */
export function snapToStream(grid, acc, { x, y, areaM2 = 0, minAreaM2 = 0, radiusM = 0, exact = false }) {
  const c = cellOf(grid, x, y);
  if (!c) return -1;
  if (exact) return c.k;
  const cellArea = grid.dx * grid.dx;
  const r = Math.max(2, Math.round((radiusM || (areaM2 ? 150 : 60)) / grid.dx));
  let best = -1;
  let bestScore = -Infinity;
  for (let dj = -r; dj <= r; dj++)
    for (let di = -r; di <= r; di++) {
      if (di * di + dj * dj > r * r) continue;
      const i = c.i + di;
      const j = c.j + dj;
      if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
      const k = j * grid.nx + i;
      const a = acc[k] * cellArea;
      const dist = Math.hypot(di, dj) / r;
      let score;
      if (areaM2) score = -Math.abs(Math.log(a / areaM2)) - 0.3 * dist;
      else if (minAreaM2) score = a >= 0.9 * minAreaM2 ? -Math.log(a / minAreaM2) - dist : -1e9 + a;
      else score = Math.log(a) - 0.5 * dist;
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
  return best;
}

/** Sections transversales de mesure du débit. */
export function buildGauges(grid, rivers, gaugeDefs) {
  const out = [];
  for (const g of gaugeDefs) {
    const dir = rivers ? riverDirectionAt(rivers, g.x, g.y, g.river) : null;
    const ux = dir ? dir.ux : 1;
    const uy = dir ? dir.uy : 0;
    const cx = dir ? dir.px : g.x;
    const cy = dir ? dir.py : g.y;
    // Ligne perpendiculaire au cours d'eau
    const a = [cx + uy * g.halfWidth, cy - ux * g.halfWidth];
    const b = [cx - uy * g.halfWidth, cy + ux * g.halfWidth];
    const line = new Set();
    rasterizeLine(grid, [a, b], (k) => line.add(k));
    if (!line.size) continue;
    // Débit = somme des flux à travers les faces qui séparent la ligne (maille 4-connexe)
    // des mailles situées côté aval. Chaque écoulement est ainsi compté une seule fois,
    // même quand la ligne en escalier le traverse sur deux mailles.
    // Faces repérées par la maille dont c'est la face est (wx) ou sud (wy) ;
    // qx > 0 vers l'est, qy > 0 vers le sud (j croissant).
    const gx = ux;
    const gy = -uy; // sens de l'écoulement en coordonnées de grille (i, j)
    const { nx, ny, dx } = grid;
    const faces = new Map();
    const add = (k, wx, wy) => {
      const f = faces.get(k) || [0, 0];
      f[0] += wx;
      f[1] += wy;
      faces.set(k, f);
    };
    for (const k of line) {
      const i = k % nx;
      const j = (k - i) / nx;
      if (gx > 1e-3 && i + 1 < nx && !line.has(k + 1)) add(k, dx, 0);
      if (gx < -1e-3 && i > 0 && !line.has(k - 1)) add(k - 1, -dx, 0);
      if (gy > 1e-3 && j + 1 < ny && !line.has(k + nx)) add(k, 0, dx);
      if (gy < -1e-3 && j > 0 && !line.has(k - nx)) add(k - nx, 0, -dx);
    }
    const ks = [...faces.keys()];
    out.push({
      ...g,
      line: [a, b],
      cells: Int32Array.from(ks),
      wx: Float32Array.from(ks, (k) => faces.get(k)[0]),
      wy: Float32Array.from(ks, (k) => faces.get(k)[1]),
    });
  }
  return out;
}

/** Facteur de sur-échantillonnage de l'occupation du sol (pixels par côté de maille). */
export function landcoverOversampling(dx) {
  return Math.max(1, Math.min(4, Math.round(dx / 10)));
}

/**
 * Réordonne une image de classes à résolution dx/f en f² échantillons consécutifs par maille.
 */
export function regroupSamples(sub, grid, f) {
  if (f === 1) return sub;
  const { nx, ny } = grid;
  const W = nx * f;
  const out = new Uint8Array(nx * ny * f * f);
  let o = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++)
      for (let b = 0; b < f; b++)
        for (let a = 0; a < f; a++) out[o++] = sub[(j * f + b) * W + i * f + a];
  return out;
}

/** Champs dépendant du scénario (sol, humidité). */
export function buildModel({ grid, terrain, classes, spc = 1, soilGroup, amc, rainOnBasinOnly, cnFactor, capInfiltration = true }) {
  const { S, manning, fc } = buildRunoffFields(
    classes,
    rainOnBasinOnly ? terrain.mask : null,
    soilGroup,
    amc,
    cnFactor,
    spc,
    capInfiltration,
  );
  // Mailles partiellement bâties (rues étroites à maille grossière) : passage gardé, frottement accru.
  // Lit des cours d'eau : l'eau y coule dans le lit, pas dans la végétation que l'occupation du sol
  // voit au-dessus (ripisylve classée en forêt, frottement 0,12) ; sans cela, aux mailles
  // grossières, la crue est fortement ralentie.
  const ch = terrain.channel;
  if (ch) for (let k = 0; k < manning.length; k++) if (ch[k] && manning[k] > N_CHANNEL) manning[k] = N_CHANNEL;
  const bf = terrain.bldFrac;
  if (bf) for (let k = 0; k < manning.length; k++) if (bf[k] > 0 && bf[k] < 1) manning[k] += 0.2 * bf[k];
  return { nx: grid.nx, ny: grid.ny, dx: grid.dx, z: terrain.z, S, manning, fc, m0: hortonM0(amc) };
}
