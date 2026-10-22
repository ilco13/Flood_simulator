// Boucle de simulation commune aux moteurs CPU et GPU.

import { CpuSolver } from './cpuSolver.js';
import { stableDt } from './scheme.js';
import { fluxFields } from './flux.js';

/** Adaptateur asynchrone autour du solveur CPU. */
export class CpuBackend {
  constructor(model, gauges) {
    this.solver = new CpuSolver(model);
    this.gauges = gauges;
    this.t = 0;
    this.hm = 0;
    this.steps = 0;
  }
  async advance(tEnd, hyeto) {
    const s = this.solver;
    while (this.t < tEnd - 1e-6) {
      const dt = Math.min(stableDt(s.dx, this.hm * 1.05 + 0.02), tEnd - this.t);
      const P0 = hyeto.cumulative(this.t);
      const P1 = hyeto.cumulative(this.t + dt);
      this.t += dt;
      this.hm = s.step(dt, this.t, (P1 - P0) / 1000, 0.5 * (P0 + P1));
      this.steps++;
      if (!Number.isFinite(this.hm)) throw new Error('Instabilité numérique détectée');
    }
  }
  async gaugeDischarges() {
    return this.solver.gaugeDischarges(this.gauges);
  }
  async readDepth() {
    return this.solver.h.slice();
  }
  async readFlux() {
    const s = this.solver;
    return fluxFields(s.qx, s.qy, s.nx, s.ny);
  }
  async readMaxima() {
    const s = this.solver;
    return { hmax: s.hmax, tmax: s.tmax, vmax: s.vmax };
  }
  massBalance() {
    const s = this.solver;
    return { rain: s.rainVolume, out: s.outflow, stored: s.storedVolume() };
  }
}

/**
 * @param backend   CpuBackend ou GpuSolver
 * @param opts.totalTime     durée simulée (s)
 * @param opts.gaugeEvery    intervalle d'échantillonnage des débits (s)
 * @param opts.snapshotEvery intervalle des instantanés de hauteur d'eau (s)
 */
export async function simulate(backend, opts) {
  const { hyeto, totalTime, gaugeEvery = 300, snapshotEvery = 900 } = opts;
  const t0 = performance.now();
  let t = 0;
  let nextSnap = snapshotEvery;
  while (t < totalTime - 1e-6) {
    const tn = Math.min(totalTime, t + gaugeEvery);
    await backend.advance(tn, hyeto);
    t = tn;
    opts.onGauge?.(t, await backend.gaugeDischarges());
    if (t >= nextSnap - 1e-6 || t >= totalTime - 1e-6) {
      await opts.onSnapshot?.(t, await backend.readDepth(), backend.readFlux ? await backend.readFlux() : null);
      nextSnap += snapshotEvery;
    }
    await opts.onProgress?.(t / totalTime, {
      t,
      steps: backend.steps,
      elapsed: (performance.now() - t0) / 1000,
    });
    if (opts.shouldStop?.()) break;
  }
  return { t, maxima: await backend.readMaxima() };
}
