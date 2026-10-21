// Coupe en travers : profil du terrain (LiDAR HD à pleine résolution) et de l'eau simulée,
// dessinée comme une vraie coupe (ciel, sol texturé, eau en dégradé) plutôt qu'en fil de fer.

import { LAYERS } from '../config.js';
import { getMapUrl, fetchWithRetry } from '../data/wms.js';
import { cellOf, toWgs } from '../geo.js';

/** Extrémités A et B (Lambert 93) d'une coupe centrée en (cx, cy).
 * orientation : azimut de la ligne en degrés (0 = nord-sud, 90 = ouest-est). A est à l'ouest/au sud. */
export function sectionEnds(cx, cy, orientationDeg, width) {
  const a = (orientationDeg * Math.PI) / 180;
  const ux = Math.sin(a);
  const uy = Math.cos(a);
  const h = width / 2;
  let A = [cx - ux * h, cy - uy * h];
  let B = [cx + ux * h, cy + uy * h];
  if (A[0] > B[0] + 1e-6 || (Math.abs(A[0] - B[0]) < 1e-6 && A[1] > B[1])) [A, B] = [B, A];
  return { A, B };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
function compass(dx, dy) {
  const az = (Math.atan2(dx, dy) * 180) / Math.PI;
  return COMPASS[Math.round(((az + 360) % 360) / 45) % 8];
}

/**
 * Orientation perpendiculaire au vallon : on cherche d'abord l'axe du vallon (la direction
 * le long de laquelle le terrain reste le plus bas autour du centre), puis on tourne de 90°.
 */
export function autoOrientation(grid, z, cx, cy, width) {
  const half = Math.min(width / 2, 120);
  let bestAxis = 0;
  let bestMean = Infinity;
  for (let o = 0; o < 180; o += 5) {
    const a = (o * Math.PI) / 180;
    const ux = Math.sin(a);
    const uy = Math.cos(a);
    let sum = 0;
    let n = 0;
    for (let k = -10; k <= 10; k++) {
      const c = cellOf(grid, cx + (ux * half * k) / 10, cy + (uy * half * k) / 10);
      if (!c || !Number.isFinite(z[c.k])) continue;
      sum += z[c.k];
      n++;
    }
    if (n < 10) continue;
    const mean = sum / n;
    if (mean < bestMean) {
      bestMean = mean;
      bestAxis = o;
    }
  }
  return (bestAxis + 90) % 180;
}

const fineCache = new Map();

/** Profil fin du terrain le long de AB (MNT LiDAR HD, jusqu'à 0,5 m). */
export async function fetchFineProfile(A, B, n) {
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const res = Math.max(0.5, Math.ceil((L / 1800) * 2) / 2);
  const pad = 3 * res;
  const bbox = {
    xmin: Math.floor(Math.min(A[0], B[0]) - pad),
    xmax: Math.ceil(Math.max(A[0], B[0]) + pad),
    ymin: Math.floor(Math.min(A[1], B[1]) - pad),
    ymax: Math.ceil(Math.max(A[1], B[1]) + pad),
  };
  const w = Math.max(2, Math.round((bbox.xmax - bbox.xmin) / res));
  const h = Math.max(2, Math.round((bbox.ymax - bbox.ymin) / res));
  const key = `${bbox.xmin},${bbox.ymin},${w},${h}`;
  let grid = fineCache.get(key);
  if (!grid) {
    const buf = await fetchWithRetry(getMapUrl(LAYERS.dem, bbox, w, h, 'image/x-bil;bits=32'), { tries: 3 });
    grid = { data: new Float32Array(buf), w, h, bbox };
    fineCache.set(key, grid);
    if (fineCache.size > 6) fineCache.delete(fineCache.keys().next().value);
  }
  const out = new Float32Array(n);
  const sx = (grid.bbox.xmax - grid.bbox.xmin) / grid.w;
  const sy = (grid.bbox.ymax - grid.bbox.ymin) / grid.h;
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const x = A[0] + (B[0] - A[0]) * f;
    const y = A[1] + (B[1] - A[1]) * f;
    // interpolation bilinéaire
    const gx = (x - grid.bbox.xmin) / sx - 0.5;
    const gy = (grid.bbox.ymax - y) / sy - 0.5;
    const i0 = Math.max(0, Math.min(grid.w - 2, Math.floor(gx)));
    const j0 = Math.max(0, Math.min(grid.h - 2, Math.floor(gy)));
    const tx = Math.min(1, Math.max(0, gx - i0));
    const ty = Math.min(1, Math.max(0, gy - j0));
    const v = (a, b) => grid.data[(j0 + b) * grid.w + i0 + a];
    const z = (1 - ty) * ((1 - tx) * v(0, 0) + tx * v(1, 0)) + ty * ((1 - tx) * v(0, 1) + tx * v(1, 1));
    out[i] = z > -1000 ? z : NaN;
  }
  return { z: out, res };
}

/**
 * Échantillonne la coupe : terrain de la simulation, hauteurs d'eau à l'instant et maximum.
 * @param depthAt fonction k -> hauteur d'eau (m) à l'instant affiché
 * @param maxAt   fonction k -> hauteur maximale (m)
 */
export function sampleSection({ grid, zSim, A, B, n, depthAt, maxAt }) {
  const pts = [];
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const x = A[0] + (B[0] - A[0]) * f;
    const y = A[1] + (B[1] - A[1]) * f;
    const c = cellOf(grid, x, y);
    if (!c) {
      pts.push({ d: f * L, x, y, zc: NaN, zi: NaN, h: 0, hmax: 0 });
      continue;
    }
    pts.push({ d: f * L, x, y, zc: zSim[c.k], zi: bilinear(grid, zSim, x, y), h: depthAt(c.k), hmax: maxAt(c.k) });
  }
  return { pts, L, labels: [compass(A[0] - B[0], A[1] - B[1]), compass(B[0] - A[0], B[1] - A[1])] };
}

/** Altitude interpolée entre les centres de mailles (terrain lissé pour l'affichage). */
function bilinear(grid, z, x, y) {
  const gx = (x - grid.xmin) / grid.dx - 0.5;
  const gy = (grid.ymax - y) / grid.dx - 0.5;
  const i0 = Math.max(0, Math.min(grid.nx - 2, Math.floor(gx)));
  const j0 = Math.max(0, Math.min(grid.ny - 2, Math.floor(gy)));
  const tx = Math.min(1, Math.max(0, gx - i0));
  const ty = Math.min(1, Math.max(0, gy - j0));
  const v = (a, b) => z[(j0 + b) * grid.nx + i0 + a];
  return (1 - ty) * ((1 - tx) * v(0, 0) + tx * v(1, 0)) + ty * ((1 - tx) * v(0, 1) + tx * v(1, 1));
}

/* ---------- Dessin ---------- */

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

let soilPattern = null;
function getSoilPattern(ctx) {
  if (soilPattern) return soilPattern;
  // Texture procédurale : strates ondulées + graviers, répétée en motif.
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 48;
  const g = c.getContext('2d');
  g.fillStyle = '#b48a5c';
  g.fillRect(0, 0, 96, 48);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 4; k++) {
    g.strokeStyle = k % 2 ? 'rgba(120, 82, 48, 0.35)' : 'rgba(205, 168, 120, 0.35)';
    g.lineWidth = 2 + rnd() * 3;
    g.beginPath();
    const y0 = 6 + k * 12;
    for (let x = 0; x <= 96; x += 4) {
      const y = y0 + Math.sin((x / 96) * Math.PI * 2 + k) * 2.5;
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  for (let k = 0; k < 70; k++) {
    g.fillStyle = rnd() > 0.5 ? 'rgba(90, 62, 38, 0.45)' : 'rgba(225, 200, 160, 0.45)';
    g.beginPath();
    g.ellipse(rnd() * 96, rnd() * 48, 0.6 + rnd() * 1.6, 0.5 + rnd() * 1.1, rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  soilPattern = ctx.createPattern(c, 'repeat');
  return soilPattern;
}

/**
 * @param canvas
 * @param s { pts, L, labels, fine?: Float32Array, timeLabel, hover?: index }
 */
export function drawSection(canvas, s) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (!W || !H) return null;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const pad = { l: 42, r: 10, t: 22, b: 22 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const { pts, L } = s;
  const n = pts.length;
  const ground = new Float32Array(n);
  for (let i = 0; i < n; i++) ground[i] = (s.fine && Number.isFinite(s.fine[i]) ? s.fine[i] : pts[i].zi) + (s.raise?.[i] || 0);
  // Niveaux d'eau (surface libre) à l'instant et maximum, tirés de la simulation
  const level = poolLevels(pts, ground, (p) => p.h, 0.05);
  // Le niveau max n'est tracé que là où l'eau a dépassé 10 cm (pas la lame de ruissellement).
  const levelMax = poolLevels(pts, ground, (p) => p.hmax, 0.1);

  let zmin = Infinity;
  let zmax = -Infinity;
  for (let i = 0; i < n; i++) {
    for (const v of [ground[i], level[i], levelMax[i]]) {
      if (Number.isFinite(v)) {
        zmin = Math.min(zmin, v);
        zmax = Math.max(zmax, v);
      }
    }
  }
  if (!Number.isFinite(zmin)) return null;
  const span = Math.max(2, zmax - zmin);
  zmin -= span * 0.25;
  zmax += span * 0.12;
  const X = (d) => pad.l + (d / L) * pw;
  const Y = (z) => pad.t + ph - ((z - zmin) / (zmax - zmin)) * ph;
  // Exagération verticale : pixels par mètre en hauteur / pixels par mètre en distance
  const exag = ph / (zmax - zmin) / (pw / L);

  // Ciel
  const sky = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
  sky.addColorStop(0, dark ? '#0f2234' : '#cfe6fb');
  sky.addColorStop(1, dark ? '#1b3149' : '#f3f8fd');
  ctx.fillStyle = sky;
  ctx.fillRect(pad.l, pad.t, pw, ph);

  // Quadrillage
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = cssVar('--muted', '#667');
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(30,60,90,0.10)';
  ctx.lineWidth = 1;
  const step = niceStep(zmax - zmin, 5);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let z = Math.ceil(zmin / step) * step; z <= zmax; z += step) {
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(z));
    ctx.lineTo(pad.l + pw, Y(z));
    ctx.stroke();
    ctx.fillText(`${+z.toFixed(1)}`, pad.l - 4, Y(z));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const dstep = niceStep(L, 6);
  for (let d = 0; d <= L + 1e-6; d += dstep) ctx.fillText(`${Math.round(d)} m`, X(d), pad.t + ph + 5);

  // Eau : remplissage entre le terrain et la surface libre, là où l'eau est au-dessus du sol
  const drawWater = (lv, fill, surface) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, pw, ph);
    ctx.clip();
    let i = 0;
    while (i < n) {
      while (i < n && !(lv[i] > ground[i])) i++;
      if (i >= n) break;
      const i0 = i;
      while (i < n && lv[i] > ground[i]) i++;
      const i1 = i - 1;
      ctx.beginPath();
      ctx.moveTo(X(pts[i0].d), Y(lv[i0]));
      for (let k = i0; k <= i1; k++) ctx.lineTo(X(pts[k].d), Y(lv[k]));
      for (let k = i1; k >= i0; k--) ctx.lineTo(X(pts[k].d), Y(ground[k]));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (surface) {
        // reflets : fines ondulations claires sous la surface
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        for (let r = 1; r <= 3; r++) {
          ctx.beginPath();
          for (let k = i0; k <= i1; k++) {
            const x = X(pts[k].d);
            const y = Y(lv[k]) + r * 4 + Math.sin(x / 7 + r) * 1.2;
            k === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = '#d9f1ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = i0; k <= i1; k++) (k === i0 ? ctx.moveTo : ctx.lineTo).call(ctx, X(pts[k].d), Y(lv[k]));
        ctx.stroke();
      }
    }
    ctx.restore();
  };
  const waterGrad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
  waterGrad.addColorStop(0, 'rgba(70, 160, 235, 0.85)');
  waterGrad.addColorStop(1, 'rgba(10, 50, 120, 0.92)');

  // Terrain : sol texturé + assombrissement en profondeur + liseré d'herbe
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, pw, ph);
  ctx.clip();
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(ground[i])) continue;
    const x = X(pts[i].d);
    const y = Y(ground[i]);
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    started = true;
  }
  ctx.lineTo(pad.l + pw, pad.t + ph);
  ctx.lineTo(pad.l, pad.t + ph);
  ctx.closePath();
  ctx.fillStyle = getSoilPattern(ctx);
  ctx.fill();
  const shade = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
  shade.addColorStop(0, 'rgba(60, 35, 15, 0)');
  shade.addColorStop(1, 'rgba(40, 22, 8, 0.55)');
  ctx.fillStyle = shade;
  ctx.fill();
  ctx.restore();

  drawWater(level, waterGrad, true);

  // Herbe en surface (par-dessus l'eau côté berges seulement)
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, pw, ph);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#5f8f3a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  started = false;
  for (let i = 0; i < n; i++) {
    const dry = !(level[i] > ground[i]);
    if (!Number.isFinite(ground[i]) || !dry) {
      started = false;
      continue;
    }
    const x = X(pts[i].d);
    const y = Y(ground[i]);
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    started = true;
  }
  ctx.stroke();
  ctx.restore();

  // Niveau maximal atteint : pointillé
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = '#ff6a3d';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  started = false;
  for (let i = 0; i < n; i++) {
    if (!(levelMax[i] > ground[i] - 0.05)) {
      started = false;
      continue;
    }
    const x = X(pts[i].d);
    const y = Y(levelMax[i]);
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    started = true;
  }
  ctx.stroke();
  ctx.restore();

  // Profondeur max actuelle
  let kmax = -1;
  let dmax = 0;
  for (let i = 0; i < n; i++) {
    const d = level[i] - ground[i];
    if (d > dmax) {
      dmax = d;
      kmax = i;
    }
  }
  ctx.fillStyle = dark ? '#fff' : '#0b2540';
  ctx.font = '600 11px system-ui, sans-serif';
  if (kmax >= 0 && dmax > 0.05) {
    const x = X(pts[kmax].d);
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, Y(level[kmax]) - 2);
    ctx.lineTo(x, Y(ground[kmax]) + 2);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${dmax < 1 ? `${Math.round(dmax * 100)} cm` : `${dmax.toFixed(2).replace('.', ',')} m`}`, x + 4, Y(level[kmax]) - 3);
  }

  // Cadre, extrémités A/B et informations
  ctx.strokeStyle = cssVar('--line', '#ccd');
  ctx.strokeRect(pad.l, pad.t, pw, ph);
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillStyle = cssVar('--text', '#123');
  ctx.fillText(`A (${s.labels[0]})`, pad.l, pad.t - 4);
  ctx.textAlign = 'right';
  ctx.fillText(`B (${s.labels[1]})`, pad.l + pw, pad.t - 4);
  ctx.textAlign = 'center';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = cssVar('--muted', '#667');
  ctx.fillText(`${s.timeLabel} · relief ×${exag >= 10 ? Math.round(exag) : exag.toFixed(1).replace('.', ',')}`, pad.l + pw / 2, pad.t - 4);
  if (!s.fine) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('chargement du profil LiDAR fin…', pad.l + pw - 6, pad.t + 6);
  }

  // Survol
  if (s.hover != null && s.hover >= 0 && s.hover < n) {
    const i = s.hover;
    const x = X(pts[i].d);
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + ph);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  return {
    indexAt(px) {
      const d = ((px - pad.l) / pw) * L;
      return Math.max(0, Math.min(n - 1, Math.round((d / L) * (n - 1))));
    },
    info(i) {
      const g = ground[i];
      const lv = level[i];
      const lm = levelMax[i];
      return {
        d: pts[i].d,
        ground: g,
        depth: lv > g ? lv - g : 0,
        maxDepth: lm > g ? lm - g : 0,
        level: lv > g ? lv : NaN,
        lngLat: toWgs(pts[i].x, pts[i].y),
      };
    },
  };
}

/**
 * Surface libre de l'eau le long de la coupe.
 * Pour chaque suite d'échantillons mouillés dans la simulation, le niveau est la cote d'eau
 * simulée (terrain du modèle + hauteur), moyennée en donnant plus de poids aux mailles les plus
 * profondes : la surface est plate en travers, comme dans la réalité. Ce niveau est ensuite posé
 * sur le terrain LiDAR fin et propagé de part et d'autre tant que le terrain reste plus bas que
 * lui : l'eau remplit le fond du lit et passe par-dessus une berge plus basse que la surface,
 * sans jamais « tenir debout » au-dessus d'une berge.
 */
function poolLevels(pts, ground, depthOf, thr) {
  const n = pts.length;
  const out = new Float32Array(n).fill(NaN);
  let i = 0;
  while (i < n) {
    if (!(depthOf(pts[i]) > thr) || !Number.isFinite(pts[i].zc)) {
      i++;
      continue;
    }
    let j = i;
    let sw = 0;
    let swl = 0;
    while (j < n && depthOf(pts[j]) > thr && Number.isFinite(pts[j].zc)) {
      const h = depthOf(pts[j]);
      sw += h;
      swl += h * (pts[j].zc + h);
      j++;
    }
    const L = swl / sw;
    // Point de départ : le terrain fin le plus bas de la poche (s'il est sous le niveau).
    let k0 = i;
    for (let k = i; k < j; k++) if (ground[k] < ground[k0]) k0 = k;
    if (ground[k0] < L) {
      for (const dir of [1, -1]) {
        for (let k = k0; k >= 0 && k < n && ground[k] < L; k += dir) {
          if (!(out[k] >= L)) out[k] = L;
        }
      }
      // Autres creux de la poche séparés par une bosse émergée (îlot) : remplis aussi.
      for (let k = i; k < j; k++) {
        if (Number.isFinite(out[k]) || !(ground[k] < L)) continue;
        for (const dir of [1, -1]) {
          for (let m = k; m >= 0 && m < n && ground[m] < L; m += dir) if (!(out[m] >= L)) out[m] = L;
        }
      }
    }
    i = j;
  }
  return out;
}

function niceStep(range, target) {
  const raw = range / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
