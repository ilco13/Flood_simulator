// Solveur 2D « pluie sur maillage » en JavaScript (référence et repli sans WebGPU).
//
// Inconnues : hauteur d'eau h au centre des mailles, débits unitaires qx, qy (m²/s) sur les faces.
//  qx[j*(nx+1)+i] : face entre la maille (i-1, j) et (i, j). Positif vers l'est.
//  qy[j*nx+i]     : face entre la maille (i, j-1) et (i, j). Positif vers le sud (j croissant).

import { G, H_MIN, FROUDE_MAX, V_MAX, BOUNDARY_SLOPE, THETA } from './scheme.js';
import { IA_RATIO, HORTON_P } from '../hydrology/scs.js';

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

export class CpuSolver {
  /**
   * @param {object} p  { nx, ny, dx, z, S, manning }
   */
  constructor({ nx, ny, dx, z, S, manning, fc = null, m0 = 3, inflow = null }) {
    this.nx = nx;
    this.ny = ny;
    this.dx = dx;
    this.z = z;
    this.S = S;
    this.fc = fc; // capacité d'infiltration finale (m/s) ; null = pas de plafond
    this.m0 = m0;
    // Apport d'une rivière (m³/s) réparti sur quelques mailles de son lit : { cells, Q, ramp }
    this.inflow = inflow?.cells?.length ? inflow : null;
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
    const capDt = fc && rainDepth > 0 ? dt * (1 + (this.m0 - 1) * Math.exp(-cumP / HORTON_P)) : 0;
    let hm = 0;
    let rain = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const fx = j * (nx + 1) + i;
        const fy = j * nx + i;
        let hn = h[k] + c * (qx[fx] - qx[fx + 1] + qy[fy] - qy[fy + nx]);
        const s = S[k];
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
    if (this.inflow) {
      const { cells, Q, ramp } = this.inflow;
      const q = inflowRate(Q, ramp, t - dt / 2);
      const dh = (q * dt) / (cells.length * dx * dx);
      for (let m = 0; m < cells.length; m++) {
        const k = cells[m];
        h[k] += dh;
        if (h[k] > hm) hm = h[k];
      }
      this.rainVolume += q * dt;
    }
    return hm;
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
      return Math.abs(Q);
    });
  }

  storedVolume() {
    let v = 0;
    for (let k = 0; k < this.h.length; k++) v += this.h[k];
    return v * this.dx * this.dx;
  }
}
