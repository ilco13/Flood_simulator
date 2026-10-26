// Worker « lieu étudié » : à partir d'un lieu cliqué n'importe où en France, repère les cours
// d'eau proches (BD TOPO), délimite le bassin versant amont de chacun et du versant qui domine
// le lieu, et mesure le dénivelé entre le lieu et chaque lit. L'emprise part d'un carré fin
// autour du lieu et s'agrandit (maille plus grossière) tant qu'un bassin touche le bord.

import { LAYERS } from '../config.js';
import { fetchFloatGrid } from './wms.js';
import { fetchRivers, riverCandidates, nearestRiverName } from './rivers.js';
import { flowModel, snapToStream } from '../sim/model.js';
import { upstreamMask } from '../hydrology/terrain.js';
import { makeGrid, cellOf, cellCenter, toWgs } from '../geo.js';
import { outlineWgs } from './outline.js';

// Demi-côté de l'emprise (m) et maille (m) de chaque étape.
const LEVELS = [
  { half: 2000, dx: 10 },
  { half: 5000, dx: 20 },
  { half: 12000, dx: 40 },
  { half: 30000, dx: 100 },
];
const RIVERS_MAX_HALF = 12000; // au-delà, pas de gravure BD TOPO (trop de tronçons)
const SEARCH_RADIUS = 600; // m : cours d'eau pris en compte autour du lieu

const post = (type, data) => self.postMessage({ type, ...data });

const RETRY_WAIT = [5000, 15000, 30000]; // ms : les pannes du service IGN durent parfois ~1 min

async function withRetry(fn) {
  for (let a = 0; ; a++) {
    try {
      return await fn();
    } catch (e) {
      if (a >= RETRY_WAIT.length) throw new Error(`serveur IGN indisponible pour le moment (${e.message || e}) : réessayez dans quelques minutes`);
      await new Promise((r) => setTimeout(r, RETRY_WAIT[a]));
    }
  }
}

/**
 * Maille la plus drainée près du tracé BD TOPO (à 2 mailles près), parmi les points du tracé
 * situés à moins de `near` m de son point le plus proche du lieu : on reste sur ce cours d'eau
 * sans glisser vers une confluence voisine.
 */
function snapAlongTrace(grid, acc, trace, x0, y0, near) {
  let best = -1;
  for (const [x, y] of trace) {
    if (Math.hypot(x - x0, y - y0) > near) continue;
    const c = cellOf(grid, x, y);
    if (!c) continue;
    for (let dj = -2; dj <= 2; dj++)
      for (let di = -2; di <= 2; di++) {
        const i = c.i + di;
        const j = c.j + dj;
        if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
        const k = j * grid.nx + i;
        if (best < 0 || acc[k] > acc[best]) best = k;
      }
  }
  return best;
}

/** Maille la plus proche du tracé (près du lieu) dont la surface drainée atteint `minCells`. */
function snapNearWithArea(grid, acc, trace, x0, y0, minCells, radius) {
  let best = -1;
  let bestD = Infinity;
  const r = Math.ceil(radius / grid.dx);
  for (const [x, y] of trace) {
    if (Math.hypot(x - x0, y - y0) > radius) continue;
    const c = cellOf(grid, x, y);
    if (!c) continue;
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const i = c.i + di;
        const j = c.j + dj;
        if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) continue;
        const k = j * grid.nx + i;
        if (acc[k] < minCells) continue;
        const d = Math.hypot(di, dj);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
  }
  return best;
}

// Rivière aval : on suit la pente depuis le point du cours d'eau jusqu'à la confluence avec une
// branche au moins aussi grande (et d'au moins 1 km²), dans la limite de RECV_MAX_PATH.
const RECV_MAX_PATH = 6000; // m
const RECV_UP = 600; // m : point d'injection du débit de la rivière, en amont de la confluence
const RECV_MAX_LEVEL = 3;
const RECV_DOWN = 1200; // m : longueur de rivière gardée en aval de la confluence

const stepLen = (a, b, nx, dx) => (Math.abs(a - b) === 1 || Math.abs(a - b) === nx ? dx : dx * Math.SQRT2);

/** Maille amont la plus drainée de k (en excluant `skip`). */
function mainUpstream(grid, down, acc, k, skip = -1) {
  const { nx, ny } = grid;
  const i = k % nx;
  const j = (k - i) / nx;
  let best = -1;
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const n = jj * nx + ii;
      if (n !== skip && down[n] === k && (best < 0 || acc[n] > acc[best])) best = n;
    }
  return best;
}

/**
 * Cherche la rivière qui reçoit le cours d'eau calé en k0.
 * @returns null (rien dans la limite), { exits: true } (la grille est trop petite), ou la confluence
 */
function findReceiver(grid, fm, k0) {
  const { nx, dx } = grid;
  const { down, acc } = fm;
  const minCells = 1e6 / (dx * dx);
  let k = k0;
  let len = 0;
  while (len < RECV_MAX_PATH) {
    const kn = down[k];
    if (kn < 0) return { exits: true };
    len += stepLen(k, kn, nx, dx);
    const other = mainUpstream(grid, down, acc, kn, k);
    if (other >= 0 && acc[other] >= Math.max(acc[k], minCells)) {
      // Rivière réceptrice : on remonte sa branche principale, puis on descend sous la confluence.
      const up = [];
      let u = other;
      let lu = 0;
      while (u >= 0 && lu < RECV_UP) {
        up.push(u);
        const nu = mainUpstream(grid, down, acc, u);
        if (nu < 0) break;
        lu += stepLen(u, nu, nx, dx);
        u = nu;
      }
      const dn = [];
      let d = kn;
      let ld = 0;
      while (d >= 0 && ld < RECV_DOWN) {
        dn.push(d);
        const nd = down[d];
        if (nd < 0) break;
        ld += stepLen(d, nd, nx, dx);
        d = nd;
      }
      return { conf: kn, other, distM: len, reach: [...up.reverse(), ...dn] };
    }
    k = kn;
  }
  return null;
}

function touchesEdge(mask, nx, ny) {
  for (let i = 0; i < nx; i++) if (mask[i] || mask[(ny - 1) * nx + i]) return true;
  for (let j = 0; j < ny; j++) if (mask[j * nx] || mask[j * nx + nx - 1]) return true;
  return false;
}

function maskBbox(mask, grid) {
  let imin = grid.nx;
  let imax = -1;
  let jmin = grid.ny;
  let jmax = -1;
  for (let j = 0; j < grid.ny; j++)
    for (let i = 0; i < grid.nx; i++)
      if (mask[j * grid.nx + i]) {
        if (i < imin) imin = i;
        if (i > imax) imax = i;
        if (j < jmin) jmin = j;
        if (j > jmax) jmax = j;
      }
  return {
    xmin: grid.xmin + imin * grid.dx,
    xmax: grid.xmin + (imax + 1) * grid.dx,
    ymin: grid.ymax - (jmax + 1) * grid.dx,
    ymax: grid.ymax - jmin * grid.dx,
  };
}

/** Altitude du lit : minimum du MNT brut autour de la maille (le lit est plus étroit qu'elle). */
function bedLevel(dem, grid, k) {
  const i0 = k % grid.nx;
  const j0 = (k - i0) / grid.nx;
  let z = dem[k];
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      const i = i0 + di;
      const j = j0 + dj;
      if (i >= 0 && j >= 0 && i < grid.nx && j < grid.ny) z = Math.min(z, dem[j * grid.nx + i]);
    }
  return z;
}

self.onmessage = async (e) => {
  const { x, y, burnDepth = 1 } = e.data;
  try {
    let cands = null;
    let zHouse = null;
    let active = [];
    for (let l = 0; l < LEVELS.length; l++) {
      const { half, dx } = LEVELS[l];
      post('progress', { level: l, levels: LEVELS.length, sizeKm: (2 * half) / 1000, remaining: active.length });
      const snap = (v) => Math.round(v / dx) * dx;
      const grid = makeGrid({ xmin: snap(x - half), ymin: snap(y - half), xmax: snap(x + half), ymax: snap(y + half) }, dx);
      const warnings = [];
      // Le service IGN renvoie parfois des erreurs passagères (502…) : on réessaie l'étape entière.
      const demP = withRetry(() => fetchFloatGrid(grid, LAYERS.dem, LAYERS.demFallback, { warnings }));
      const rbox = { xmin: grid.xmin - 200, ymin: grid.ymin - 200, xmax: grid.xmax + 200, ymax: grid.ymax + 200 };
      const rivP = half <= RIVERS_MAX_HALF ? withRetry(() => fetchRivers(rbox)).catch(() => null) : Promise.resolve(null);
      const [dem, rivers] = await Promise.all([demP, rivP]);
      if (!(dem[cellOf(grid, x, y).k] > -1000)) throw new Error('pas de relief disponible ici (hors France ?)');
      const fm = flowModel({ grid, dem, rivers, burnDepth });

      if (l === 0) {
        const hk = cellOf(grid, x, y).k;
        zHouse = dem[hk];
        cands = (rivers ? riverCandidates(rivers, x, y, SEARCH_RADIUS, 5) : []).map((r) => ({
          kind: 'stream',
          name: r.name || "Cours d'eau sans nom",
          named: !!r.name,
          dist: r.d,
          px: r.x,
          py: r.y,
          x0: r.x,
          y0: r.y,
          trace: r.trace,
        }));
        // Ruissellement du versant qui domine directement le lieu.
        cands.push({ kind: 'slope', name: 'Ruissellement du versant au-dessus du lieu', named: false, dist: 0, px: x, py: y });
        active = cands;
      }

      for (const c of active) {
        const pt =
          c.kind === 'slope'
            ? { x: c.px, y: c.py, exact: true }
            : l === 0
              ? { x: c.px, y: c.py, radiusM: 30 }
              : { x: c.px, y: c.py, minAreaM2: c.areaM2, radiusM: Math.max(2 * dx, 1.5 * LEVELS[l - 1].dx) };
        // Calage d'un cours d'eau : la maille la plus drainée le long de son tracé (±120 m, à 1-2
        // mailles près) — le tracé BD TOPO peut être décalé du fond du lit (gorges…).
        // À chaque palier : on suit le tracé, pour rester sur le même cours d'eau (au premier
        // palier, sa surface est tronquée s'il entre par le bord : elle ne peut pas servir de repère).
        let k =
          c.kind === 'stream' && c.trace?.length
            ? snapAlongTrace(grid, fm.acc, c.trace, c.x0, c.y0, Math.max(40, 2 * dx))
            : snapToStream(grid, fm.acc, pt);
        // Garde-fou : d'un palier à l'autre, le bassin ne peut que grandir. Si le calage le long
        // du tracé s'effondre (lit trop étroit pour la maille), on prend la maille la plus proche
        // du tracé dont la surface atteint celle du palier précédent.
        if (l > 0 && c.kind === 'stream' && k >= 0 && fm.acc[k] * dx * dx < 0.9 * c.areaM2) {
          const k2 = snapNearWithArea(grid, fm.acc, c.trace?.length ? c.trace : [[c.px, c.py]], c.x0 ?? c.px, c.y0 ?? c.py, (0.9 * c.areaM2) / (dx * dx), Math.max(150, 3 * dx));
          k = k2 >= 0 ? k2 : snapToStream(grid, fm.acc, pt);
        }
        if (k < 0) {
          c.failed = true;
          continue;
        }
        if (l === 0 && c.kind === 'stream') c.dz = zHouse - bedLevel(dem, grid, k);
        // Bassin déjà complet à un palier plus fin : on ne cherche plus que la rivière aval.
        if (!c.complete) {
          const { mask, cells } = upstreamMask(fm.down, fm.order, k);
          const i0 = k % grid.nx;
          [c.px, c.py] = cellCenter(grid, i0, (k - i0) / grid.nx);
          c.areaM2 = cells * dx * dx;
          c.dx = dx;
          c.complete = !touchesEdge(mask, grid.nx, grid.ny);
          c.bbox = maskBbox(mask, grid);
          c.outline = outlineWgs(mask, grid);
        }
        if (c.kind === 'stream' && !c.recvDone) {
          const r = findReceiver(grid, fm, k);
          if (!r) c.recvDone = true;
          else if (!r.exits) {
            const um = upstreamMask(fm.down, fm.order, r.other);
            const pt = (n) => {
              const ii = n % grid.nx;
              return cellCenter(grid, ii, (n - ii) / grid.nx);
            };
            const reach = r.reach.map(pt);
            const src = reach[0];
            const name = rivers ? nearestRiverName(rivers, src[0], src[1], 150, c.named ? c.name : null) : null;
            const conf = pt(r.conf);
            const prev = c.receiver;
            // Même confluence qu'à un palier plus fin : on garde son tracé (plus précis), et on ne
            // met à jour que la surface du bassin de la rivière.
            const same = prev && Math.hypot(prev.conf[0] - conf[0], prev.conf[1] - conf[1]) < Math.max(300, 3 * dx);
            c.receiver = {
              ...(same ? prev : { distM: r.distM, conf, src, reach, dx }),
              name: (same && prev.name) || name || prev?.name || null,
              areaKm2: (fm.acc[r.other] * dx * dx) / 1e6,
              complete: !touchesEdge(um.mask, grid.nx, grid.ny),
            };
            if (c.receiver.complete) c.recvDone = true;
          }
        }
      }
      // La recherche de la rivière aval va jusqu'au dernier palier (60 km) ; au-delà, sa surface est un minimum.
      active = active.filter((c) => !c.failed && (!c.complete || (c.kind === 'stream' && !c.recvDone && l < RECV_MAX_LEVEL)));
      if (!active.length) break;
    }
    // Deux points calés sur le même lit (deux noms pour un même tracé) : on garde le premier.
    const seen = new Set();
    const out = [];
    for (const c of cands) {
      if (c.failed) continue;
      if (c.kind === 'stream' && c.areaM2 < 1e4) continue; // moins d'1 ha : pas un vrai cours d'eau ici
      // Même lit qu'un candidat plus proche (affluent calé sur la rivière à la confluence) : doublon.
      if (
        c.kind === 'stream' &&
        out.some(
          (o) =>
            o.kind === 'stream' &&
            Math.abs(o.areaKm2 * 1e6 - c.areaM2) / Math.max(c.areaM2, 1) < 0.03 &&
            Math.hypot(o.point.x - c.px, o.point.y - c.py) < 500,
        )
      )
        continue;
      const key = `${Math.round(c.px)},${Math.round(c.py)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: c.kind,
        name: c.name,
        named: c.named,
        dist: c.dist,
        dz: c.dz ?? 0,
        areaKm2: c.areaM2 / 1e6,
        complete: c.complete,
        dx: c.dx,
        point: { x: c.px, y: c.py },
        pointWgs: toWgs(c.px, c.py),
        bbox: c.bbox,
        outline: c.outline,
        receiver: c.receiver
          ? { ...c.receiver, reachWgs: c.receiver.reach.map(([a, b]) => toWgs(a, b)), confWgs: toWgs(...c.receiver.conf), srcWgs: toWgs(...c.receiver.src) }
          : null,
      });
    }
    post('done', { house: { x, y }, houseWgs: toWgs(x, y), zHouse, cands: out });
  } catch (err) {
    post('error', { message: String(err?.message || err) });
  }
};
