// Solveur 2D sur GPU (WebGPU). Même schéma que cpuSolver.js, écrit en WGSL.
// Les pas de temps sont envoyés par lots : chaque pas a ses paramètres (dt, pluie…) dans
// un tampon uniforme adressé par décalage dynamique, ce qui évite un aller-retour CPU par pas.

import { G, H_MIN, FROUDE_MAX, V_MAX, BOUNDARY_SLOPE, THETA, stableDt } from './scheme.js';
import { IA_RATIO, HORTON_P, NO_CAP } from '../hydrology/scs.js';
import { fluxFields } from './flux.js';

const WG = 16;
const STEP_STRIDE = 256; // alignement minimal des décalages dynamiques
const MAX_BATCH = 256;

const COMMON = /* wgsl */ `
struct Consts {
  nx: u32, ny: u32, dx: f32, g: f32,
  hmin: f32, frmax: f32, vmax: f32, theta: f32,
  bslope: f32, ia: f32, p0: f32, p1: f32,
};
struct Step { dt: f32, t: f32, rain: f32, cumP: f32 };
@group(0) @binding(0) var<uniform> C: Consts;
`;

const FLUX_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(1) var<uniform> P: Step;
@group(0) @binding(2) var<storage, read> z: array<f32>;
@group(0) @binding(3) var<storage, read> h: array<f32>;
@group(0) @binding(4) var<storage, read> qxo: array<f32>;
@group(0) @binding(5) var<storage, read> qyo: array<f32>;
@group(0) @binding(6) var<storage, read_write> qx: array<f32>;
@group(0) @binding(7) var<storage, read_write> qy: array<f32>;
@group(0) @binding(8) var<storage, read> nm: array<f32>;

fn faceFlux(q: f32, qm: f32, qp: f32, zL: f32, hL: f32, zR: f32, hR: f32, nL: f32, nR: f32) -> f32 {
  let etaL = zL + hL;
  let etaR = zR + hR;
  let hf = max(etaL, etaR) - max(zL, zR);
  if (hf <= C.hmin) { return 0.0; }
  let dt = P.dt;
  let slope = (etaR - etaL) / C.dx;
  let nf = 0.5 * (nL + nR);
  let qt = C.theta * q + 0.5 * (1.0 - C.theta) * (qm + qp);
  var qn = (qt - C.g * hf * dt * slope) /
           (1.0 + C.g * dt * nf * nf * abs(q) / pow(hf, 2.33333333));
  let vlim = min(C.frmax * sqrt(C.g * hf), C.vmax) * hf;
  return clamp(qn, -vlim, vlim);
}

fn bflux(hh: f32, n: f32) -> f32 {
  if (hh <= C.hmin) { return 0.0; }
  return pow(hh, 1.66666667) * sqrt(C.bslope) / n;
}

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let j = gid.y;
  let nx = C.nx;
  let ny = C.ny;
  if (j < ny && i <= nx) {
    let f = j * (nx + 1u) + i;
    if (i == 0u) {
      let k = j * nx;
      qx[f] = -bflux(h[k], nm[k]);
    } else if (i == nx) {
      let k = j * nx + nx - 1u;
      qx[f] = bflux(h[k], nm[k]);
    } else {
      let kL = j * nx + i - 1u;
      let kR = kL + 1u;
      qx[f] = faceFlux(qxo[f], qxo[f - 1u], qxo[f + 1u], z[kL], h[kL], z[kR], h[kR], nm[kL], nm[kR]);
    }
  }
  if (i < nx && j <= ny) {
    let f = j * nx + i;
    if (j == 0u) {
      qy[f] = -bflux(h[i], nm[i]);
    } else if (j == ny) {
      let k = (ny - 1u) * nx + i;
      qy[f] = bflux(h[k], nm[k]);
    } else {
      let kU = (j - 1u) * nx + i;
      let kD = j * nx + i;
      qy[f] = faceFlux(qyo[f], qyo[f - nx], qyo[f + nx], z[kU], h[kU], z[kD], h[kD], nm[kU], nm[kD]);
    }
  }
}
`;

// Positivité : rapport de réduction des sorties de chaque maille.
const RATIO_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(1) var<uniform> P: Step;
@group(0) @binding(2) var<storage, read> h: array<f32>;
@group(0) @binding(3) var<storage, read> qx: array<f32>;
@group(0) @binding(4) var<storage, read> qy: array<f32>;
@group(0) @binding(5) var<storage, read_write> ratio: array<f32>;

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let j = gid.y;
  let nx = C.nx;
  if (i >= nx || j >= C.ny) { return; }
  let k = j * nx + i;
  let fx = j * (nx + 1u) + i;
  let fy = j * nx + i;
  let out = max(0.0, qx[fx + 1u]) + max(0.0, -qx[fx]) + max(0.0, qy[fy + nx]) + max(0.0, -qy[fy]);
  let vol = out * P.dt;
  let avail = h[k] * C.dx;
  ratio[k] = select(1.0, avail / vol, vol > avail);
}
`;

const SCALE_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(1) var<storage, read_write> qx: array<f32>;
@group(0) @binding(2) var<storage, read_write> qy: array<f32>;
@group(0) @binding(3) var<storage, read> ratio: array<f32>;

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let j = gid.y;
  let nx = C.nx;
  let ny = C.ny;
  if (j < ny && i <= nx) {
    let f = j * (nx + 1u) + i;
    let q = qx[f];
    if (q > 0.0 && i > 0u) { qx[f] = q * ratio[j * nx + i - 1u]; }
    else if (q < 0.0 && i < nx) { qx[f] = q * ratio[j * nx + i]; }
  }
  if (i < nx && j <= ny) {
    let f = j * nx + i;
    let q = qy[f];
    if (q > 0.0 && j > 0u) { qy[f] = q * ratio[(j - 1u) * nx + i]; }
    else if (q < 0.0 && j < ny) { qy[f] = q * ratio[j * nx + i]; }
  }
}
`;

const DEPTH_WGSL = /* wgsl */ `${COMMON}
@group(0) @binding(1) var<uniform> P: Step;
@group(0) @binding(2) var<storage, read_write> h: array<f32>;
@group(0) @binding(3) var<storage, read> qx: array<f32>;
@group(0) @binding(4) var<storage, read> qy: array<f32>;
@group(0) @binding(5) var<storage, read> S: array<vec2<f32>>; // (rétention SCS, capacité d'infiltration finale)
@group(0) @binding(6) var<storage, read_write> hmaxC: array<f32>;
@group(0) @binding(7) var<storage, read_write> tmaxC: array<f32>;
@group(0) @binding(8) var<storage, read_write> vmaxC: array<f32>;
@group(0) @binding(9) var<storage, read_write> stats: array<atomic<u32>>;

var<workgroup> wgMax: atomic<u32>;

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(local_invocation_index) li: u32) {
  let i = gid.x;
  let j = gid.y;
  let nx = C.nx;
  if (i < nx && j < C.ny) {
    let k = j * nx + i;
    let fx = j * (nx + 1u) + i;
    let fy = j * nx + i;
    var hn = h[k] + P.dt / C.dx * (qx[fx] - qx[fx + 1u] + qy[fy] - qy[fy + nx]);
    let sf = S[k];
    let s = sf.x;
    if (P.rain > 0.0 && s >= 0.0) {
      let x = P.cumP - C.ia * s;
      var r = 0.0;
      if (x > 0.0) {
        r = P.rain * (1.0 - (s * s) / ((x + s) * (x + s)));
      }
      // Plafond d'infiltration (Horton) : l'excédent de pluie ruisselle (C.p0 = m0, C.p1 = P*)
      let cap = sf.y * P.dt * (1.0 + (C.p0 - 1.0) * exp(-P.cumP / C.p1));
      r = max(r, P.rain - cap);
      hn = hn + r;
    }
    hn = max(hn, 0.0);
    h[k] = hn;
    if (hn > hmaxC[k]) {
      hmaxC[k] = hn;
      tmaxC[k] = P.t;
    }
    if (hn > 0.05) {
      let ux = 0.5 * (qx[fx] + qx[fx + 1u]);
      let uy = 0.5 * (qy[fy] + qy[fy + nx]);
      let v = sqrt(ux * ux + uy * uy) / hn;
      if (v > vmaxC[k]) { vmaxC[k] = v; }
    }
    atomicMax(&wgMax, bitcast<u32>(hn));
  }
  workgroupBarrier();
  if (li == 0u) {
    atomicMax(&stats[0], atomicLoad(&wgMax));
  }
}
`;

const GAUGE_WGSL = /* wgsl */ `${COMMON}
struct GC { k: u32, g: u32, wx: f32, wy: f32 };
@group(0) @binding(1) var<storage, read> qx: array<f32>;
@group(0) @binding(2) var<storage, read> qy: array<f32>;
@group(0) @binding(3) var<storage, read> cells: array<GC>;
@group(0) @binding(4) var<storage, read_write> sums: array<atomic<i32>>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  if (m >= arrayLength(&cells)) { return; }
  let c = cells[m];
  let nx = C.nx;
  let i = c.k % nx;
  let j = c.k / nx;
  let ux = qx[j * (nx + 1u) + i + 1u];
  let uy = qy[(j + 1u) * nx + i];
  atomicAdd(&sums[c.g], i32(round((ux * c.wx + uy * c.wy) * 1000.0)));
}
`;

export async function getGpuDevice() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const L = adapter.limits;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
        maxBufferSize: L.maxBufferSize,
        maxStorageBuffersPerShaderStage: Math.max(8, Math.min(L.maxStorageBuffersPerShaderStage, 10)),
      },
    });
    const info = adapter.info || {};
    return { device, adapter, label: [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') };
  } catch (e) {
    console.warn('WebGPU indisponible', e);
    return null;
  }
}

/** Nombre max de mailles que le GPU peut tenir (taille de tampon). */
export function gpuMaxCells(device) {
  return Math.floor(Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) / 4) - 1;
}

export class GpuSolver {
  constructor(device, { nx, ny, dx, z, S, manning, fc = null, m0 = 3 }, gauges) {
    this.device = device;
    // Taille des lots de pas envoyés au GPU, ajustée pour qu'un lot dure ~40 ms (≈ 12 ms quand
    // l'utilisateur déplace la carte) : la carte garde la main pour s'afficher.
    this.batchK = 16;
    this.interactive = false;
    this.nx = nx;
    this.ny = ny;
    this.dx = dx;
    this.N = nx * ny;
    this.t = 0;
    this.hmaxGlobal = 0;
    this.lost = false;
    device.lost?.then(() => {
      this.lost = true;
    });
    const d = device;
    const SB = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const mk = (size, usage = SB) => d.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    const N = this.N;

    this.bufs = {
      consts: mk(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      steps: mk(STEP_STRIDE * MAX_BATCH, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      z: mk(N * 4),
      h: mk(N * 4),
      qx: [mk((nx + 1) * ny * 4), mk((nx + 1) * ny * 4)],
      qy: [mk(nx * (ny + 1) * 4), mk(nx * (ny + 1) * 4)],
      ratio: mk(N * 4),
      n: mk(N * 4),
      S: mk(N * 8),
      hmax: mk(N * 4),
      tmax: mk(N * 4),
      vmax: mk(N * 4),
      stats: mk(16),
      statsRead: mk(16, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
    };
    const q = d.queue;
    const cb = new ArrayBuffer(48);
    const u = new Uint32Array(cb);
    const f = new Float32Array(cb);
    u[0] = nx;
    u[1] = ny;
    f[2] = dx;
    f[3] = G;
    f[4] = H_MIN;
    f[5] = FROUDE_MAX;
    f[6] = V_MAX;
    f[7] = THETA;
    f[8] = BOUNDARY_SLOPE;
    f[9] = IA_RATIO;
    f[10] = m0;
    f[11] = HORTON_P;
    q.writeBuffer(this.bufs.consts, 0, cb);
    q.writeBuffer(this.bufs.z, 0, z);
    q.writeBuffer(this.bufs.n, 0, manning);
    const sfc = new Float32Array(2 * N);
    for (let k = 0; k < N; k++) {
      sfc[2 * k] = S[k];
      sfc[2 * k + 1] = fc ? fc[k] : NO_CAP;
    }
    q.writeBuffer(this.bufs.S, 0, sfc);

    // Sections de contrôle
    const cells = [];
    gauges.forEach((g, gi) => {
      for (let m = 0; m < g.cells.length; m++) cells.push([g.cells[m], gi, g.wx[m], g.wy[m]]);
    });
    this.nGauges = gauges.length;
    const gcb = new ArrayBuffer(Math.max(1, cells.length) * 16);
    const gu = new Uint32Array(gcb);
    const gf = new Float32Array(gcb);
    cells.forEach(([k, gi, wx, wy], m) => {
      gu[4 * m] = k;
      gu[4 * m + 1] = gi;
      gf[4 * m + 2] = wx;
      gf[4 * m + 3] = wy;
    });
    this.nGaugeCells = cells.length;
    this.bufs.gcells = mk(gcb.byteLength);
    q.writeBuffer(this.bufs.gcells, 0, gcb);
    this.bufs.gsums = mk(Math.max(1, this.nGauges) * 4);
    this.bufs.gsumsRead = mk(Math.max(1, this.nGauges) * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

    this.cur = 0; // indice du tampon qx/qy qui contient l'état courant
    this.#buildPipelines();
  }

  #layout(entries) {
    return this.device.createBindGroupLayout({
      entries: entries.map((type, binding) => {
        const e = { binding, visibility: GPUShaderStage.COMPUTE };
        if (type === 'u') e.buffer = { type: 'uniform' };
        else if (type === 'ud') e.buffer = { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 };
        else if (type === 'r') e.buffer = { type: 'read-only-storage' };
        else e.buffer = { type: 'storage' };
        return e;
      }),
    });
  }

  #pipeline(code, layout) {
    return this.device.createComputePipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: this.device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  #buildPipelines() {
    const d = this.device;
    const b = this.bufs;
    const stepBinding = { buffer: b.steps, offset: 0, size: 16 };
    const bg = (layout, list) =>
      d.createBindGroup({
        layout,
        entries: list.map((res, binding) => ({
          binding,
          resource: res === stepBinding ? res : { buffer: res },
        })),
      });

    // Pour chaque parité p : le flux lit q[p] et écrit q[1-p] ; les autres passes utilisent q[1-p].
    const fluxL = this.#layout(['u', 'ud', 'r', 'r', 'r', 'r', 'w', 'w', 'r']);
    const ratioL = this.#layout(['u', 'ud', 'r', 'r', 'r', 'w']);
    const scaleL = this.#layout(['u', 'w', 'w', 'r']);
    const depthL = this.#layout(['u', 'ud', 'w', 'r', 'r', 'r', 'w', 'w', 'w', 'w']);
    const gaugeL = this.#layout(['u', 'r', 'r', 'r', 'w']);
    this.fluxPipe = this.#pipeline(FLUX_WGSL, fluxL);
    this.ratioPipe = this.#pipeline(RATIO_WGSL, ratioL);
    this.scalePipe = this.#pipeline(SCALE_WGSL, scaleL);
    this.depthPipe = this.#pipeline(DEPTH_WGSL, depthL);
    this.gaugePipe = this.#pipeline(GAUGE_WGSL, gaugeL);

    this.fluxBG = [0, 1].map((p) =>
      bg(fluxL, [b.consts, stepBinding, b.z, b.h, b.qx[p], b.qy[p], b.qx[1 - p], b.qy[1 - p], b.n]),
    );
    // Indexés par le tampon qui contient les nouveaux débits.
    this.ratioBG = [0, 1].map((p) => bg(ratioL, [b.consts, stepBinding, b.h, b.qx[p], b.qy[p], b.ratio]));
    this.scaleBG = [0, 1].map((p) => bg(scaleL, [b.consts, b.qx[p], b.qy[p], b.ratio]));
    this.depthBG = [0, 1].map((p) =>
      bg(depthL, [b.consts, stepBinding, b.h, b.qx[p], b.qy[p], b.S, b.hmax, b.tmax, b.vmax, b.stats]),
    );
    this.gaugeBG = [0, 1].map((p) => bg(gaugeL, [b.consts, b.qx[p], b.qy[p], b.gcells, b.gsums]));
  }

  /**
   * Avance la simulation jusqu'à tEnd (s).
   * @param hyeto hyétogramme (cumulative(t) en mm)
   */
  async advance(tEnd, hyeto) {
    const d = this.device;
    const gx = Math.ceil((this.nx + 1) / WG);
    const gy = Math.ceil((this.ny + 1) / WG);
    const params = new ArrayBuffer(STEP_STRIDE * MAX_BATCH);
    const pf = new Float32Array(params);
    while (this.t < tEnd - 1e-6) {
      if (this.lost) throw new Error('Le GPU a été perdu (mémoire insuffisante ?)');
      const dt0 = stableDt(this.dx, this.hmaxGlobal * 1.15 + 0.05);
      let t = this.t;
      let K = 0;
      const kMax = Math.max(1, Math.min(MAX_BATCH, Math.round(this.batchK)));
      const tb = performance.now();
      while (K < kMax && t < tEnd - 1e-6) {
        const dt = Math.min(dt0, tEnd - t);
        const P0 = hyeto.cumulative(t);
        const P1 = hyeto.cumulative(t + dt);
        const o = (K * STEP_STRIDE) / 4;
        pf[o] = dt;
        pf[o + 1] = t + dt;
        pf[o + 2] = (P1 - P0) / 1000;
        pf[o + 3] = 0.5 * (P0 + P1);
        t += dt;
        K++;
      }
      d.queue.writeBuffer(this.bufs.steps, 0, params, 0, K * STEP_STRIDE);
      d.queue.writeBuffer(this.bufs.stats, 0, new Uint32Array(4));
      const enc = d.createCommandEncoder();
      const pass = enc.beginComputePass();
      for (let k = 0; k < K; k++) {
        const off = [k * STEP_STRIDE];
        const nxt = 1 - this.cur;
        pass.setPipeline(this.fluxPipe);
        pass.setBindGroup(0, this.fluxBG[this.cur], off);
        pass.dispatchWorkgroups(gx, gy);
        pass.setPipeline(this.ratioPipe);
        pass.setBindGroup(0, this.ratioBG[nxt], off);
        pass.dispatchWorkgroups(gx, gy);
        pass.setPipeline(this.scalePipe);
        pass.setBindGroup(0, this.scaleBG[nxt]);
        pass.dispatchWorkgroups(gx, gy);
        pass.setPipeline(this.depthPipe);
        pass.setBindGroup(0, this.depthBG[nxt], off);
        pass.dispatchWorkgroups(gx, gy);
        this.cur = nxt;
      }
      pass.end();
      enc.copyBufferToBuffer(this.bufs.stats, 0, this.bufs.statsRead, 0, 16);
      d.queue.submit([enc.finish()]);
      await this.bufs.statsRead.mapAsync(GPUMapMode.READ);
      const bits = new Uint32Array(this.bufs.statsRead.getMappedRange().slice(0));
      this.bufs.statsRead.unmap();
      this.hmaxGlobal = new Float32Array(bits.buffer)[0];
      if (!Number.isFinite(this.hmaxGlobal)) throw new Error('Instabilité numérique détectée');
      this.t = t;
      this.steps = (this.steps || 0) + K;
      // Ajuste la taille du lot suivant d'après la durée de celui-ci.
      const ms = performance.now() - tb;
      const target = this.interactive ? 12 : 40;
      if (K === kMax && ms > 0) this.batchK = Math.max(1, Math.min(MAX_BATCH, kMax * Math.min(2, Math.max(0.25, target / ms))));
      // Pendant un déplacement de la carte, on laisse passer une image entre deux lots.
      if (this.interactive && typeof requestAnimationFrame !== 'undefined') await new Promise((r) => requestAnimationFrame(() => r()));
    }
  }

  async gaugeDischarges() {
    if (!this.nGaugeCells) return [];
    const d = this.device;
    d.queue.writeBuffer(this.bufs.gsums, 0, new Int32Array(this.nGauges));
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.gaugePipe);
    pass.setBindGroup(0, this.gaugeBG[this.cur]);
    pass.dispatchWorkgroups(Math.ceil(this.nGaugeCells / 64));
    pass.end();
    enc.copyBufferToBuffer(this.bufs.gsums, 0, this.bufs.gsumsRead, 0, this.nGauges * 4);
    d.queue.submit([enc.finish()]);
    await this.bufs.gsumsRead.mapAsync(GPUMapMode.READ);
    const v = new Int32Array(this.bufs.gsumsRead.getMappedRange(0, this.nGauges * 4).slice(0));
    this.bufs.gsumsRead.unmap();
    return Array.from(v, (x) => Math.abs(x) / 1000);
  }

  async #read(buf, size) {
    const d = this.device;
    const st = d.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(buf, 0, st, 0, size);
    d.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(st.getMappedRange().slice(0));
    st.unmap();
    st.destroy();
    return out;
  }

  readDepth() {
    return this.#read(this.bufs.h, this.N * 4);
  }

  /** Débit pour l'affichage (intensité par maille, direction par bloc). */
  async readFlux() {
    const qx = await this.#read(this.bufs.qx[this.cur], (this.nx + 1) * this.ny * 4);
    const qy = await this.#read(this.bufs.qy[this.cur], this.nx * (this.ny + 1) * 4);
    return fluxFields(qx, qy, this.nx, this.ny);
  }

  async readMaxima() {
    return {
      hmax: await this.#read(this.bufs.hmax, this.N * 4),
      tmax: await this.#read(this.bufs.tmax, this.N * 4),
      vmax: await this.#read(this.bufs.vmax, this.N * 4),
    };
  }

  destroy() {
    for (const b of Object.values(this.bufs).flat()) b.destroy();
  }
}
