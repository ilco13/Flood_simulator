// Web Worker : exécute le solveur CPU hors du fil principal pour garder la carte fluide.

import { CpuBackend, simulate } from './driver.js';
import { makeHyetograph } from '../hydrology/rain.js';

let stop = false;

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'stop') {
    stop = true;
    return;
  }
  if (msg.type !== 'run') return;
  stop = false;
  try {
    const backend = new CpuBackend(msg.model, msg.gauges);
    const hyeto = makeHyetograph(msg.rain);
    const res = await simulate(backend, {
      ...msg.options,
      hyeto,
      onGauge: (t, Q) => self.postMessage({ type: 'gauge', t, Q }),
      onSnapshot: (t, h, flux) =>
        self.postMessage(
          { type: 'snapshot', t, h, flux },
          flux ? [h.buffer, flux.qm.buffer, flux.ang.buffer, flux.vec.fx.buffer, flux.vec.fy.buffer] : [h.buffer],
        ),
      onProgress: async (p, info) => {
        self.postMessage({ type: 'progress', p, info });
        // Rend la main à la boucle d'événements pour recevoir un éventuel « stop ».
        await new Promise((r) => setTimeout(r, 0));
      },
      shouldStop: () => stop,
    });
    const { hmax, tmax, vmax } = res.maxima;
    self.postMessage(
      { type: 'done', t: res.t, maxima: { hmax, tmax, vmax }, mass: backend.massBalance() },
      [hmax.buffer, tmax.buffer, vmax.buffer],
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
