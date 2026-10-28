// Solveur 2D « pluie sur maillage » en JavaScript (référence et repli sans WebGPU).
//
// Inconnues : hauteur d'eau h au centre des mailles, débits unitaires qx, qy (m²/s) sur les faces.
//  qx[j*(nx+1)+i] : face entre la maille (i-1, j) et (i, j). Positif vers l'est.
//  qy[j*nx+i]     : face entre la maille (i, j-1) et (i, j). Positif vers le sud (j croissant).

import { G, H_MIN, FROUDE_MAX, V_MAX, BOUNDARY_SLOPE, THETA, CFL } from './scheme.js';
import { IA_RATIO, HORTON_P } from '../hydrology/scs.js';
import { zoneCum } from '../hydrology/rainField.js';
import { applyCulverts } from './culvert.js';

// q : débit de la face au pas précédent ; qm, qp : faces voisines dans la même direction
// (pondération θ de de Almeida et al. 2012, qui amortit les oscillations).
function faceFlux(q, qm, qp, zL, hL, zR, hR, nL, nR, dx, dt) {
  const etaL = zL + hL;
  const etaR = zR + hR;
  const hf = Math.max(etaL, etaR) - Math.max(zL, zR);
  if (hf <= H_MIN) return 0;
  const slope = (etaR - etaL) / dx;
  const nf = 0.5 * (nL + nR);
  const qt = THETA * q + 0.5 * (1 - THETA) * (qm + qp);
  let qn = (qt - G * hf * dt * slope) / (1 + (G * dt * nf * nf * Math.abs(q)) / Math.pow(hf, 7 / 3));
  const vlim = Math.min(FROUDE_MAX * Math.sqrt(G * hf), V_MAX) * hf;
  if (qn > vlim) qn = vlim;
  else if (qn < -vlim) qn = -vlim;
  return qn;
}

function boundaryFlux(h, n) {
  // Sortie libre en régime normal (Manning) : uniquement sortante.
  if (h <= H_MIN) return 0;
  return (Math.pow(h, 5 / 3) * Math.sqrt(BOUNDARY_SLOPE)) / n;
}

/** Débit d'apport (m³/s) au temps t : montée linéaire sur `ramp` secondes, puis constant. */
export const inflowRate = (Q, ramp, t) => (ramp > 0 ? Q * Math.min(1, Math.max(0, t) / ramp) : Q);

/**
 * Apports d'eau (m³/s) répartis sur des mailles : rivière aval, entrées d'une zone fine.
 * Format : [{ cells, t: [s…], Q: [m³/s…] }] (débit interpolé linéairement, constant au-delà).
 * L'ancien format { cells, Q, ramp } (montée linéaire puis constant) est accepté.
 */
export function normalizeSources({ sources, inflow }) {
  const out = [];
  for (const s of sources || []) if (s?.cells?.length && s.t?.length) out.push(s);
  if (inflow?.cells?.length) out.push({ cells: inflow.cells, t: [0, Math.max(1, inflow.ramp || 0), 1e12], Q: [0, inflow.Q, inflow.Q] });
  return out;
}

/** Débit d'une source au temps t (interpolation linéaire). */
export function sourceRate(s, t) {
  const { t: ts, Q } = s;
  const n = ts.length;
  if (t <= ts[0]) return Q[0];
  if (t >= ts[n - 1]) return Q[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (ts[m] <= t) lo = m;
    else hi = m;
  }
  const f = (t - ts[lo]) / (ts[hi] - ts[lo]);
  return Q[lo] + f * (Q[hi] - Q[lo]);
}

/** Mailles de toutes les sources à la suite, et débit par maille (m/s de hauteur) au temps t. */
export function flattenSources(sources) {
  let n = 0;
  for (const s of sources) n += s.cells.length;
  const cells = new Int32Array(n);
  const owner = new Int32Array(n);
  let o = 0;
  sources.forEach((s, i) => {
    cells.set(s.cells, o);
    owner.fill(i, o, o + s.cells.length);
    o += s.cells.length;
  });
  return { cells, owner };
}

export function sourceDepthRates(sources, flat, t, dx, out) {
  const per = sources.map((s) => Math.max(0, sourceRate(s, t)) / (s.cells.length * dx * dx));
  for (let m = 0; m < flat.cells.length; m++) out[m] = per[flat.owner[m]];
  return out;
}

export let LTS_CFL = CFL;
export const setLtsCfl = (v) => (LTS_CFL = v);

export class CpuSolver {
  /**
   * @param {object} p  { nx, ny, dx, z, S, manning }
   */
  constructor({ nx, ny, dx, z, S, manning, fc = null, m0 = 3, inflow = null, sources = null, rainZones = null, links = null }) {
    // Ouvrages sous les routes : [{ ku, kd, inv, a, b }]
    this.links = links?.length ? links : null;
    this.linkQmax = this.links ? new Float32Array(2 * this.links.length) : null;
    // Pluie variable dans l'espace : blocs de pluie (épisodes réels), sinon pluie uniforme
    this.rz = rainZones;
    if (rainZones) {
      this.zoneCol = Int32Array.from({ length: nx }, (_, i) => Math.floor(i / rainZones.bi));
      this.zD = new Float64Array(rainZones.nz);
      this.zC = new Float64Array(rainZones.nz);
      this.zCap = new Float64Array(rainZones.nz);
    }
    this.nx = nx;
    this.ny = ny;
    this.dx = dx;
    this.z = z;
    this.S = S;
    this.fc = fc; // capacité d'infiltration finale (m/s) ; null = pas de plafond
    this.m0 = m0;
    // Apport d'une rivière (m³/s) réparti sur quelques mailles de son lit : { cells, Q, ramp }
    this.sources = normalizeSources({ sources, inflow });
    this.flat = this.sources.length ? flattenSources(this.sources) : null;
    this.rates = this.flat ? new Float32Array(this.flat.cells.length) : null;
    this.n = manning;
    const N = nx * ny;
    this.h = new Float32Array(N);
    this.qx = new Float32Array((nx + 1) * ny);
    this.qy = new Float32Array(nx * (ny + 1));
    this.qx2 = new Float32Array((nx + 1) * ny);
    this.qy2 = new Float32Array(nx * (ny + 1));
    this.hmax = new Float32Array(N);
    this.tmax = new Float32Array(N);
    this.vmax = new Float32Array(N);
    this.ratio = new Float32Array(N);
    this.outflow = 0; // m³ sortis par les bords
    this.rainVolume = 0; // m³ de pluie nette injectée
  }

  /** Un pas de temps. rainDepth = pluie brute (m) tombée pendant dt, cumP = cumul (mm) au milieu du pas. */
  step(dt, t, rainDepth, cumP) {
    const { nx, ny, dx, z, h, n, S } = this;
    const qxo = this.qx;
    const qyo = this.qy;
    const qx = this.qx2;
    const qy = this.qy2;
    this.qx = qx;
    this.qy = qy;
    this.qx2 = qxo;
    this.qy2 = qyo;
    // 1) Flux sur les faces verticales (direction x)
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      const frow = j * (nx + 1);
      for (let i = 1; i < nx; i++) {
        const kL = row + i - 1;
        const kR = row + i;
        const f = frow + i;
        qx[f] = faceFlux(qxo[f], qxo[f - 1], qxo[f + 1], z[kL], h[kL], z[kR], h[kR], n[kL], n[kR], dx, dt);
      }
      qx[frow] = -boundaryFlux(h[row], n[row]);
      qx[frow + nx] = boundaryFlux(h[row + nx - 1], n[row + nx - 1]);
    }
    // 2) Flux sur les faces horizontales (direction y)
    for (let j = 1; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const kU = (j - 1) * nx + i;
        const kD = j * nx + i;
        const f = j * nx + i;
        qy[f] = faceFlux(qyo[f], qyo[f - nx], qyo[f + nx], z[kU], h[kU], z[kD], h[kD], n[kU], n[kD], dx, dt);
      }
    }
    for (let i = 0; i < nx; i++) {
      qy[i] = -boundaryFlux(h[i], n[i]);
      const kb = (ny - 1) * nx + i;
      qy[ny * nx + i] = boundaryFlux(h[kb], n[kb]);
    }
    // 3) Positivité : si les sorties d'une maille dépassent son volume, on les réduit
    //    toutes dans la même proportion (conservation exacte de la masse).
    const ratio = this.ratio;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const fx = j * (nx + 1) + i;
        const fy = j * nx + i;
        const out =
          Math.max(0, qx[fx + 1]) + Math.max(0, -qx[fx]) + Math.max(0, qy[fy + nx]) + Math.max(0, -qy[fy]);
        const vol = out * dt;
        ratio[k] = vol > h[k] * dx ? (h[k] * dx) / vol : 1;
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const f = j * (nx + 1) + i;
        const q = qx[f];
        if (q > 0 && i > 0) qx[f] = q * ratio[j * nx + i - 1];
        else if (q < 0 && i < nx) qx[f] = q * ratio[j * nx + i];
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const f = j * nx + i;
        const q = qy[f];
        if (q > 0 && j > 0) qy[f] = q * ratio[(j - 1) * nx + i];
        else if (q < 0 && j < ny) qy[f] = q * ratio[j * nx + i];
      }
    }

    // Volume sortant par les bords pendant ce pas
    let out = 0;
    for (let j = 0; j < ny; j++) out += -qx[j * (nx + 1)] + qx[j * (nx + 1) + nx];
    for (let i = 0; i < nx; i++) out += -qy[i] + qy[ny * nx + i];
    this.outflow += out * dx * dt;

    // 4) Continuité + pluie nette (SCS-CN)
    const c = dt / dx;
    const fc = this.fc;
    // Infiltration possible pendant ce pas, par m/s de capacité finale (loi de Horton)
    let capDt = fc && rainDepth > 0 ? dt * (1 + (this.m0 - 1) * Math.exp(-cumP / HORTON_P)) : 0;
    const rz = this.rz;
    if (rz) {
      // Pluie de chaque bloc pendant ce pas (m), cumul au milieu du pas (mm), infiltration possible
      for (let z = 0; z < rz.nz; z++) {
        const a = zoneCum(rz, z, t - dt);
        const b = zoneCum(rz, z, t);
        this.zD[z] = (b - a) / 1000;
        this.zC[z] = 0.5 * (a + b);
        this.zCap[z] = fc ? dt * (1 + (this.m0 - 1) * Math.exp(-this.zC[z] / HORTON_P)) : 0;
      }
    }
    let hm = 0;
    let rain = 0;
    for (let j = 0; j < ny; j++) {
      const zRow = rz ? Math.floor(j / rz.bj) * rz.nzx : 0;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const fx = j * (nx + 1) + i;
        const fy = j * nx + i;
        let hn = h[k] + c * (qx[fx] - qx[fx + 1] + qy[fy] - qy[fy + nx]);
        const s = S[k];
        if (rz) {
          const zz = zRow + this.zoneCol[i];
          rainDepth = this.zD[zz];
          cumP = this.zC[zz];
          capDt = this.zCap[zz];
        }
        if (rainDepth > 0 && s >= 0) {
          const x = cumP - IA_RATIO * s;
          let r = x > 0 ? rainDepth * (1 - (s * s) / ((x + s) * (x + s))) : 0;
          // Pluie plus intense que ce que le sol peut absorber : l'excédent ruisselle.
          if (fc) r = Math.max(r, rainDepth - fc[k] * capDt);
          if (r > 0) {
            hn += r;
            rain += r;
          }
        }
        if (hn < 0) hn = 0;
        h[k] = hn;
        if (hn > hm) hm = hn;
        if (hn > this.hmax[k]) {
          this.hmax[k] = hn;
          this.tmax[k] = t;
        }
        if (hn > 0.05) {
          const ux = 0.5 * (qx[fx] + qx[fx + 1]);
          const uy = 0.5 * (qy[fy] + qy[fy + nx]);
          const v = Math.sqrt(ux * ux + uy * uy) / hn;
          if (v > this.vmax[k]) this.vmax[k] = v;
        }
      }
    }
    this.rainVolume += rain * dx * dx;
    if (this.flat) {
      const { cells } = this.flat;
      const r = sourceDepthRates(this.sources, this.flat, t - dt / 2, dx, this.rates);
      let vol = 0;
      for (let m = 0; m < cells.length; m++) {
        const k = cells[m];
        h[k] += r[m] * dt;
        vol += r[m] * dt;
        if (h[k] > hm) hm = h[k];
      }
      this.rainVolume += vol * dx * dx;
    }
    if (this.links) applyCulverts(h, z, this.links, dt, dx, this.linkQmax);
    return hm;
  }

  /**
   * Pluie de chaque maille sur [ta, tb] : prépare la fonction netRain(k, i, j) (m de pluie nette).
   * rainFn(ta, tb) → [pluie brute (m), cumul au milieu (mm)] pour la pluie uniforme.
   */
  #rainOver(ta, tb, rainFn) {
    const dt = tb - ta;
    const { S, fc, rz } = this;
    let [rainDepth, cumP] = rainFn(ta, tb);
    let capDt = fc && rainDepth > 0 ? dt * (1 + (this.m0 - 1) * Math.exp(-cumP / HORTON_P)) : 0;
    let zD = null;
    let zC = null;
    let zCap = null;
    if (rz) {
      zD = new Float64Array(rz.nz);
      zC = new Float64Array(rz.nz);
      zCap = new Float64Array(rz.nz);
      for (let z = 0; z < rz.nz; z++) {
        const a = zoneCum(rz, z, ta);
        const b = zoneCum(rz, z, tb);
        zD[z] = (b - a) / 1000;
        zC[z] = 0.5 * (a + b);
        zCap[z] = fc ? dt * (1 + (this.m0 - 1) * Math.exp(-zC[z] / HORTON_P)) : 0;
      }
    }
    const zoneCol = this.zoneCol;
    return (k, i, j) => {
      const sk = S[k];
      if (sk < 0) return 0;
      let rd = rainDepth;
      let cp = cumP;
      let cap = capDt;
      if (rz) {
        const zz = Math.floor(j / rz.bj) * rz.nzx + zoneCol[i];
        rd = zD[zz];
        cp = zC[zz];
        cap = zCap[zz];
      }
      if (rd <= 0) return 0;
      const x = cp - IA_RATIO * sk;
      let r = x > 0 ? rd * (1 - (sk * sk) / ((x + sk) * (x + sk))) : 0;
      if (fc) r = Math.max(r, rd - fc[k] * cap);
      return r > 0 ? r : 0;
    };
  }

  /**
   * Pas de temps par zone : R sous-pas de dtF dans les mailles profondes (et 2 mailles autour),
   * un seul pas de R·dtF ailleurs. Les échanges à travers les faces des mailles profondes sont
   * cumulés pour leurs voisines : la masse reste exactement conservée.
   * @param fine  Uint8Array : 1 pour les mailles à petit pas (voir fineMask)
   * @param rainFn (ta, tb) → [pluie brute (m), cumul au milieu (mm)]
   */
  stepLts(dtF, R, t0, rainFn, fine) {
    const { nx, ny, dx, z, h, n } = this;
    const N = nx * ny;
    const dtC = R * dtF;
    const qx = this.qx;
    const qy = this.qy;
    // Faces « fines » : au moins une maille voisine fine (bords compris)
    const fx = [];
    const fy = [];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) if ((i > 0 && fine[j * nx + i - 1]) || (i < nx && fine[j * nx + i])) fx.push(j * (nx + 1) + i);
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) if ((j > 0 && fine[(j - 1) * nx + i]) || (j < ny && fine[j * nx + i])) fy.push(j * nx + i);
    const fineCells = [];
    for (let k = 0; k < N; k++) if (fine[k]) fineCells.push(k);
    // Mailles touchées par une face fine (fines et voisines grossières)
    const touched = new Uint8Array(N);
    for (const f of fx) {
      const j = Math.floor(f / (nx + 1));
      const i = f - j * (nx + 1);
      if (i > 0) touched[j * nx + i - 1] = 1;
      if (i < nx) touched[j * nx + i] = 1;
    }
    for (const f of fy) {
      const j = Math.floor(f / nx);
      const i = f - j * nx;
      if (j > 0) touched[(j - 1) * nx + i] = 1;
      if (j < ny) touched[j * nx + i] = 1;
    }
    const tcells = [];
    for (let k = 0; k < N; k++) if (touched[k]) tcells.push(k);
    const tx = new Float32Array(fx.length);
    const ty = new Float32Array(fy.length);
    const ratio = this.ratio;
    let hm = 0;
    const isSrcFine = this.flat ? Array.from(this.flat.cells, (k) => !!fine[k]) : null;
    // Débit sortant d'une maille par ses faces fines seulement (maille grossière : voisines fines)
    const outFine = (k, i, j) => {
      const ex = j * (nx + 1) + i;
      const ey = j * nx + i;
      let o = 0;
      const fk = fine[k];
      if (fk || (i > 0 && fine[k - 1])) o += Math.max(0, -qx[ex]);
      if (fk || (i < nx - 1 && fine[k + 1]) || (fk && i === nx - 1)) o += Math.max(0, qx[ex + 1]);
      if (fk || (j > 0 && fine[k - nx])) o += Math.max(0, -qy[ey]);
      if (fk || (j < ny - 1 && fine[k + nx]) || (fk && j === ny - 1)) o += Math.max(0, qy[ey + nx]);
      return o;
    };

    for (let s = 0; s < R; s++) {
      const t = t0 + (s + 1) * dtF;
      // 1) flux des faces fines (à partir de l'état précédent : comme le double tampon)
      for (let m = 0; m < fx.length; m++) {
        const f = fx[m];
        const j = Math.floor(f / (nx + 1));
        const i = f - j * (nx + 1);
        const row = j * nx;
        if (i === 0) tx[m] = -boundaryFlux(h[row], n[row]);
        else if (i === nx) tx[m] = boundaryFlux(h[row + nx - 1], n[row + nx - 1]);
        else tx[m] = faceFlux(qx[f], qx[f - 1], qx[f + 1], z[row + i - 1], h[row + i - 1], z[row + i], h[row + i], n[row + i - 1], n[row + i], dx, dtF);
      }
      for (let m = 0; m < fy.length; m++) {
        const f = fy[m];
        const j = Math.floor(f / nx);
        const i = f - j * nx;
        if (j === 0) ty[m] = -boundaryFlux(h[i], n[i]);
        else if (j === ny) ty[m] = boundaryFlux(h[(ny - 1) * nx + i], n[(ny - 1) * nx + i]);
        else {
          const kU = (j - 1) * nx + i;
          const kD = j * nx + i;
          ty[m] = faceFlux(qy[f], f >= nx ? qy[f - nx] : 0, qy[f + nx] ?? 0, z[kU], h[kU], z[kD], h[kD], n[kU], n[kD], dx, dtF);
        }
      }
      for (let m = 0; m < fx.length; m++) qx[fx[m]] = tx[m];
      for (let m = 0; m < fy.length; m++) qy[fy[m]] = ty[m];
      // 2) positivité : sorties par les faces fines limitées à l'eau disponible
      for (const k of tcells) {
        const i = k % nx;
        const j = (k - i) / nx;
        const vol = outFine(k, i, j) * dtF;
        const avail = h[k] * dx;
        ratio[k] = vol > avail ? avail / vol : 1;
      }
      for (const f of fx) {
        const j = Math.floor(f / (nx + 1));
        const i = f - j * (nx + 1);
        const q = qx[f];
        if (q > 0 && i > 0) qx[f] = q * ratio[j * nx + i - 1];
        else if (q < 0 && i < nx) qx[f] = q * ratio[j * nx + i];
      }
      for (const f of fy) {
        const j = Math.floor(f / nx);
        const i = f - j * nx;
        const q = qy[f];
        if (q > 0 && j > 0) qy[f] = q * ratio[(j - 1) * nx + i];
        else if (q < 0 && j < ny) qy[f] = q * ratio[j * nx + i];
      }
      // sorties par les bords (faces fines)
      let out = 0;
      for (const f of fx) {
        const i = f % (nx + 1);
        if (i === 0) out -= qx[f];
        else if (i === nx) out += qx[f];
      }
      for (const f of fy) {
        if (f < nx) out -= qy[f];
        else if (f >= ny * nx) out += qy[f];
      }
      this.outflow += out * dx * dtF;
      // 3) continuité : chaque face fine échange l'eau entre ses deux mailles (les voisines
      //    grossières aussi : leur niveau suit) ; puis pluie des mailles fines
      const c = dtF / dx;
      for (let m = 0; m < fx.length; m++) {
        const f = fx[m];
        const j = Math.floor(f / (nx + 1));
        const i = f - j * (nx + 1);
        const v = c * qx[f];
        if (i > 0) h[j * nx + i - 1] -= v;
        if (i < nx) h[j * nx + i] += v;
      }
      for (let m = 0; m < fy.length; m++) {
        const f = fy[m];
        const j = Math.floor(f / nx);
        const i = f - j * nx;
        const v = c * qy[f];
        if (j > 0) h[(j - 1) * nx + i] -= v;
        if (j < ny) h[j * nx + i] += v;
      }
      for (const k of tcells) if (h[k] < 0) h[k] = 0;
      const netRain = this.#rainOver(t - dtF, t, rainFn);
      let rain = 0;
      for (const k of fineCells) {
        const i = k % nx;
        const j = (k - i) / nx;
        const ex = j * (nx + 1) + i;
        const ey = j * nx + i;
        let hn = h[k];
        const r = netRain(k, i, j);
        hn += r;
        rain += r;
        if (hn < 0) hn = 0;
        h[k] = hn;
        this.#trackMax(k, hn, t, ex, ey);
      }
      this.rainVolume += rain * dx * dx;
      if (this.flat) this.#addSources(t, dtF, isSrcFine, true);
      if (this.links) applyCulverts(h, z, this.links, dtF, dx, this.linkQmax);
    }

    // 4) mailles grossières : un pas de R·dtF sur les autres faces
    const t1 = t0 + dtC;
    const qx2 = this.qx2;
    const qy2 = this.qy2;
    qx2.set(qx);
    qy2.set(qy);
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      const frow = j * (nx + 1);
      for (let i = 0; i <= nx; i++) {
        if ((i > 0 && fine[row + i - 1]) || (i < nx && fine[row + i])) continue;
        const f = frow + i;
        if (i === 0) qx2[f] = -boundaryFlux(h[row], n[row]);
        else if (i === nx) qx2[f] = boundaryFlux(h[row + nx - 1], n[row + nx - 1]);
        else qx2[f] = faceFlux(qx[f], qx[f - 1], qx[f + 1], z[row + i - 1], h[row + i - 1], z[row + i], h[row + i], n[row + i - 1], n[row + i], dx, dtC);
      }
    }
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        if ((j > 0 && fine[(j - 1) * nx + i]) || (j < ny && fine[j * nx + i])) continue;
        const f = j * nx + i;
        if (j === 0) qy2[f] = -boundaryFlux(h[i], n[i]);
        else if (j === ny) qy2[f] = boundaryFlux(h[(ny - 1) * nx + i], n[(ny - 1) * nx + i]);
        else {
          const kU = (j - 1) * nx + i;
          const kD = j * nx + i;
          qy2[f] = faceFlux(qy[f], f >= nx ? qy[f - nx] : 0, qy[f + nx] ?? 0, z[kU], h[kU], z[kD], h[kD], n[kU], n[kD], dx, dtC);
        }
      }
    this.qx = qx2;
    this.qy = qy2;
    this.qx2 = qx;
    this.qy2 = qy;
    const QX = qx2;
    const QY = qy2;
    // positivité des mailles grossières (faces grossières seulement ; l'eau déjà échangée compte)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (fine[k]) {
          ratio[k] = 1;
          continue;
        }
        const ex = j * (nx + 1) + i;
        const ey = j * nx + i;
        let o = 0;
        if (!(i > 0 && fine[k - 1])) o += Math.max(0, -QX[ex]);
        if (!(i < nx - 1 && fine[k + 1])) o += Math.max(0, QX[ex + 1]);
        if (!(j > 0 && fine[k - nx])) o += Math.max(0, -QY[ey]);
        if (!(j < ny - 1 && fine[k + nx])) o += Math.max(0, QY[ey + nx]);
        const vol = o * dtC;
        const avail = h[k] * dx;
        ratio[k] = vol > avail ? avail / vol : 1;
      }
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        if ((i > 0 && fine[j * nx + i - 1]) || (i < nx && fine[j * nx + i])) continue;
        const f = j * (nx + 1) + i;
        const q = QX[f];
        if (q > 0 && i > 0) QX[f] = q * ratio[j * nx + i - 1];
        else if (q < 0 && i < nx) QX[f] = q * ratio[j * nx + i];
      }
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        if ((j > 0 && fine[(j - 1) * nx + i]) || (j < ny && fine[j * nx + i])) continue;
        const f = j * nx + i;
        const q = QY[f];
        if (q > 0 && j > 0) QY[f] = q * ratio[(j - 1) * nx + i];
        else if (q < 0 && j < ny) QY[f] = q * ratio[j * nx + i];
      }
    let out = 0;
    for (let j = 0; j < ny; j++) {
      if (!fine[j * nx]) out -= QX[j * (nx + 1)];
      if (!fine[j * nx + nx - 1]) out += QX[j * (nx + 1) + nx];
    }
    for (let i = 0; i < nx; i++) {
      if (!fine[i]) out -= QY[i];
      if (!fine[(ny - 1) * nx + i]) out += QY[ny * nx + i];
    }
    this.outflow += out * dx * dtC;
    const c = dtC / dx;
    const netRain = this.#rainOver(t0, t1, rainFn);
    let rain = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (fine[k]) {
          if (h[k] > hm) hm = h[k];
          continue;
        }
        const ex = j * (nx + 1) + i;
        const ey = j * nx + i;
        let d = 0;
        if (!(i > 0 && fine[k - 1])) d += QX[ex];
        if (!(i < nx - 1 && fine[k + 1])) d -= QX[ex + 1];
        if (!(j > 0 && fine[k - nx])) d += QY[ey];
        if (!(j < ny - 1 && fine[k + nx])) d -= QY[ey + nx];
        let hn = h[k] + c * d;
        const r = netRain(k, i, j);
        hn += r;
        rain += r;
        if (hn < 0) hn = 0;
        h[k] = hn;
        if (hn > hm) hm = hn;
        this.#trackMax(k, hn, t1, ex, ey);
      }
    this.rainVolume += rain * dx * dx;
    if (this.flat) {
      this.#addSources(t1, dtC, isSrcFine, false);
      for (const k of this.flat.cells) if (h[k] > hm) hm = h[k];
    }
    return hm;
  }

  #trackMax(k, hn, t, ex, ey) {
    if (hn > this.hmax[k]) {
      this.hmax[k] = hn;
      this.tmax[k] = t;
    }
    if (hn > 0.05) {
      const ux = 0.5 * (this.qx[ex] + this.qx[ex + 1]);
      const uy = 0.5 * (this.qy[ey] + this.qy[ey + this.nx]);
      const v = Math.sqrt(ux * ux + uy * uy) / hn;
      if (v > this.vmax[k]) this.vmax[k] = v;
    }
  }

  /** Apports sur les mailles fines (fineOnes) ou grossières, pendant dt finissant à t. */
  #addSources(t, dt, isFine, fineOnes) {
    const { cells } = this.flat;
    const r = sourceDepthRates(this.sources, this.flat, t - dt / 2, this.dx, this.rates);
    let vol = 0;
    for (let m = 0; m < cells.length; m++) {
      if (isFine[m] !== fineOnes) continue;
      this.h[cells[m]] += r[m] * dt;
      vol += r[m] * dt;
    }
    this.rainVolume += vol * this.dx * this.dx;
  }

  /**
   * Mailles à petit pas pour un grand pas dtC : celles dont la profondeur (avec une marge de
   * croissance) l'exigent, élargies de 2 mailles. Renvoie le nombre de mailles fines.
   */
  fineMask(dtC, out, cfl = LTS_CFL) {
    const { nx, ny, dx, h } = this;
    // pas stable avec une marge (CFL réduit) : h' ≤ (cfl·dx/dtC)²/g ; h' = 1,3·h + 0,05
    const hLim = (((cfl * dx) / dtC) ** 2 / G - 0.05) / 1.3;
    const a = this.fineTmp && this.fineTmp.length === nx * ny ? this.fineTmp : (this.fineTmp = new Uint8Array(nx * ny));
    for (let k = 0; k < nx * ny; k++) a[k] = h[k] > hLim ? 1 : 0;
    // élargissement de 2 mailles (carré 5×5), en deux passes séparables
    const b = out;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let v = 0;
        for (let d = -2; d <= 2 && !v; d++) {
          const ii = i + d;
          if (ii >= 0 && ii < nx && a[j * nx + ii]) v = 1;
        }
        b[j * nx + i] = v;
      }
    let count = 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let v = 0;
        for (let d = -2; d <= 2 && !v; d++) {
          const jj = j + d;
          if (jj >= 0 && jj < ny && b[jj * nx + i]) v = 1;
        }
        a[j * nx + i] = v;
        count += v;
      }
    out.set(a);
    return count;
  }

  /** Débits (m³/s) aux sections de contrôle. */
  gaugeDischarges(gauges) {
    const { nx, qx, qy } = this;
    return gauges.map((g) => {
      let Q = 0;
      for (let m = 0; m < g.cells.length; m++) {
        const k = g.cells[m];
        const i = k % nx;
        const j = (k - i) / nx;
        // Face est (qx) et face sud (qy) de la maille.
        const ux = qx[j * (nx + 1) + i + 1];
        const uy = qy[(j + 1) * nx + i];
        Q += ux * g.wx[m] + uy * g.wy[m];
      }
      // Points de suivi : débit sans signe ; faces du bord d'une zone fine : signé (entrant > 0).
      return g.signed ? Q : Math.abs(Q);
    });
  }

  storedVolume() {
    let v = 0;
    for (let k = 0; k < this.h.length; k++) v += this.h[k];
    return v * this.dx * this.dx;
  }
}
