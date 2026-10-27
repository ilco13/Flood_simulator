import { GAUGES, OUTLET } from '../config.js';
import { GpuSolver, gpuMaxCells } from '../sim/gpuSolver.js';
import { SnapshotStore, quantize } from '../sim/snapshots.js';
import { WaterCanvas } from '../render/water.js';
import { buildModel } from '../sim/model.js';
import { cellOf, toL93, toWgs } from '../geo.js';
import { setGeoJson, setWaterCanvas } from '../map.js';
import { simulate } from '../sim/driver.js';
import { AVAL_RAMP, inflowCells, mainReceiver } from './aval.js';
import { nestBox, boundaryGauges, nestSources } from './nest.js';
import { renderEpisodeCompare } from './episode.js';
import { escHtml } from './compareUi.js';
import { $, CPU_CELL_CAP, GPU_CELL_CAP, fmtH, fmtNum, state } from './core.js';
import { ensureWater3d } from './mapUi.js';
import { obstaclesL93 } from './obstacles.js';
import { chooseEngine, currentGrid, describeRes, expectedSimSeconds, fmtDur, hyetoOf, learnSpeed, params, soilGroup, speedOf, updateRainInfo, workOf } from './params.js';
import { CONNECTING, fmtClock, prog } from './progress.js';
import { accumulateFlowMax, drawHydro, drawHydroThrottled, drawQuantized, probeAt, stopPlay } from './results.js';
import { autoSave, findPlaceName } from './saved.js';
import { studyCands, studyGauges } from './study.js';
import { setLayerVisible, setViewMode, showResults } from './ui.js';

/* ---------- Données ---------- */

/**
 * Explique l'échec d'un worker. Sans message, c'est soit une page ouverte avant une mise à jour
 * du site (les fichiers ont changé de nom), soit un arrêt du navigateur (mémoire).
 */
export async function workerFailure(e, what) {
  if (e?.message) return e.message;
  try {
    const r = await fetch(new URL('../', location.href), { cache: 'no-store' });
    const html = await r.text();
    const current = [...document.scripts].map((x) => x.src).find((src) => /assets\/index-/.test(src));
    const name = current && current.split('/').pop();
    if (name && !html.includes(name)) {
      return "L'application a été mise à jour pendant que la page était ouverte : rechargez la page (Ctrl+F5 ou Cmd+Maj+R).";
    }
  } catch {
    // hors ligne : on retombe sur le message général
  }
  return `Le navigateur a interrompu ${what}, probablement faute de mémoire. Essayez une résolution plus grossière ou une zone plus petite, puis rechargez la page.`;
}


export function loadData(grid, p) {
  const sel = p.zone === 'study' ? studyCands() : [];
  const upstreamOf = sel.length
    ? sel.map((c) =>
        c.kind === 'slope'
          ? { x: c.point.x, y: c.point.y, exact: true }
          : { x: c.point.x, y: c.point.y, areaM2: c.areaKm2 * 1e6, radiusM: Math.max(30, 1.5 * c.dx) },
      )
    : null;
  const gauges = [...studyGauges(p), ...GAUGES];
  const obstacles = obstaclesL93();
  const buildingsBox = p.bdtopo ? buildingsBoxOf(grid) : null;
  const key = JSON.stringify([grid.xmin, grid.ymin, grid.nx, grid.ny, grid.dx, p.burn, upstreamOf, obstacles, gauges.map((g) => [g.id, g.x, g.y]), buildingsBox]);
  if (state.data?.key === key) return Promise.resolve(state.data);
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../data/prepWorker.js', import.meta.url), { type: 'module' });
    state.prepWorker = w;
    state.prepReject = reject;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') prog.set(m.step, m.p, m.detail);
      else if (m.type === 'done') {
        w.terminate();
        state.prepWorker = null;
        resolve({ ...m, key, grid });
      } else if (m.type === 'error') {
        w.terminate();
        state.prepWorker = null;
        reject(new Error(m.message));
      }
    };
    w.onerror = async (e) => {
      w.terminate();
      state.prepWorker = null;
      reject(new Error(await workerFailure(e, 'la préparation des données')));
    };
    const outlet = p.zone === 'basin' ? OUTLET : null;
    w.postMessage({ grid, burnDepth: p.burn, outlet, upstreamOf, obstacles, gauges, buildingsBox });
  });
}

export const BLD_RADIUS = 1000; // m : bâtiments BD TOPO chargés autour du lieu étudié

/** Emprise des bâtiments BD TOPO à charger : 1 km autour du lieu, dans la zone de calcul. */
export function buildingsBoxOf(grid) {
  const h = state.study?.house;
  if (!h) return null;
  const b = {
    xmin: Math.max(grid.xmin, h.x - BLD_RADIUS),
    xmax: Math.min(grid.xmin + grid.nx * grid.dx, h.x + BLD_RADIUS),
    ymin: Math.max(grid.ymax - grid.ny * grid.dx, h.y - BLD_RADIUS),
    ymax: Math.min(grid.ymax, h.y + BLD_RADIUS),
  };
  return b.xmax > b.xmin && b.ymax > b.ymin ? b : null;
}

export function showContext(data) {
  const map = state.map;
  setGeoJson(map, 'rivers', data.rivers);
  setGeoJson(map, 'basin', {
    type: 'FeatureCollection',
    features: data.outline.map((ring) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: {} })),
  });
  setGeoJson(map, 'gauges', {
    type: 'FeatureCollection',
    features: data.gauges.flatMap((g) => [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: g.lineWgs }, properties: { name: g.name } },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: g.lineWgs[1] },
        properties: { name: g.name.replace("L'Arc à ", 'Arc · ') },
      },
    ]),
  });
}

/* ---------- Simulation ---------- */

/**
 * Lance une simulation : en une passe, ou en deux temps si la maille fine autour du lieu est
 * demandée (bassin entier à la maille choisie, puis carré autour du lieu à maille fine).
 */
export async function startRun() {
  const p = params();
  const g1 = p.nest && state.study ? currentGrid(p) : null;
  const box = g1 ? nestBox(g1, state.study.house, p.nest.radius, p.nest.res) : null;
  if (!box || p.nest.res > g1.dx) return runOnce({ p });
  const faces = boundaryGauges(g1, box);
  const t0 = performance.now();
  const r1 = await runOnce({ p, grid: g1, extraGauges: faces, gaugeEvery: 120, phase: 'coarse', phaseLabel: `1/2 : bassin entier à ${g1.dx} m` });
  if (!r1?.ok) return r1;
  const c = r1.run;
  const coarseSeconds = (performance.now() - t0) / 1000;
  const coarsePeaks = c.gauges.map((g, i) => ({ id: g.id, name: g.name, peak: c.series[i].reduce((m, q) => Math.max(m, q[1]), 0) }));
  const side = [(box.bbox.xmax - box.bbox.xmin) / 1000, (box.bbox.ymax - box.bbox.ymin) / 1000];
  const p2 = { ...p, res: p.nest.res, nestOf: { coarse: g1.dx, side } };
  return runOnce({
    p: p2,
    grid: box.grid,
    totalTime: c.tEnd ?? c.totalTime,
    phase: 'fine',
    phaseLabel: `2/2 : zone fine à ${p.nest.res} m`,
    makeSources: (grid, data) => nestSources(grid, data.z || data.dem, faces, c.bseries),
    nest: { coarseRes: g1.dx, coarseSeconds, side, coarsePeaks },
  });
}

/** Une passe de calcul. opts : { p, grid, extraGauges, gaugeEvery, totalTime, phase, phaseLabel, makeSources, nest } */
async function runOnce(opts = {}) {
  const p = opts.p ?? params();
  if (p.rainMm <= 0) {
    prog.error('Indiquez un cumul de pluie supérieur à 0 mm.');
    return;
  }
  const grid = opts.grid ?? currentGrid(p);
  if (!grid) {
    prog.error('Choisissez d\'abord le lieu à étudier (bouton « Choisir le lieu étudié » ou recherche), et au moins un bassin.');
    return;
  }
  const cells = grid.nx * grid.ny;
  const engine = chooseEngine(p, cells);
  if (!engine) {
    describeRes();
    const cap = state.gpu ? Math.min(GPU_CELL_CAP, gpuMaxCells(state.gpu.device)) : CPU_CELL_CAP;
    prog.error(
      `Zone trop grande : ${fmtNum(cells / 1e6, 1)} M de mailles (maximum ${fmtNum(cap / 1e6, 1)} M sur cet appareil). ` +
        `Choisissez une résolution plus grossière${p.zone === 'view' ? ' ou zoomez sur la carte' : ''}.`,
    );
    return;
  }
  stopPlay();
  const run = {
    running: true,
    stop: false,
    engine,
    params: p,
    grid,
    store: new SnapshotStore(),
    series: [],
    gaugeT: [],
    follow: true,
    maxQ: null,
    t0: performance.now(),
  };
  // Hauteur d'eau au point étudié, relevée à chaque instantané (comparaison de scénarios)
  const placeCell = state.study ? cellOf(grid, state.study.house.x, state.study.house.y) : null;
  run.placeK = placeCell ? placeCell.k : -1;
  run.placeSeries = [[0, 0]];
  // Nom du lieu, cherché pendant le calcul (pour nommer l'enregistrement).
  run.placeP = findPlaceName(grid, p).catch(() => null);
  state.run = run;
  $('run').textContent = 'Arrêter';
  $('run').classList.add('stop');
  showResults(false);
  if (opts.phase !== 'fine') prog.start();
  const cached = state.data?.key === JSON.stringify([grid.xmin, grid.ymin, grid.nx, grid.ny, grid.dx, p.burn]);
  if (!cached) prog.status(CONNECTING);

  try {
    const data = await loadData(grid, p);
    if (run.stop) throw new Error('Arrêté');
    for (const k of ['dem', 'lc', 'rivers', 'prep']) prog.set(k, 1, cached ? 'déjà chargé' : 'ok');
    prog.status('');
    prog.set('sim', 0, 'démarrage');
    state.data = data;
    showContext(data);
    updateRainInfo();

    const model = buildModel({
      grid,
      terrain: data,
      classes: data.classes,
      spc: data.spc,
      soilGroup: p.soil,
      amc: p.amcIdx ?? p.amc,
      rainOnBasinOnly: !!data.mask,
      cnFactor: p.cnFactor,
      capInfiltration: p.capInf,
    });
    model.sources = [];
    if (p.aval) {
      // En zone fine, la rivière n'est injectée que si son point d'injection y est : sinon son
      // eau entre déjà par le bord, avec les débits du calcul du bassin.
      const r = mainReceiver()?.receiver;
      const cells = r ? inflowCells(grid, data.z || data.dem, r.src) : null;
      if (cells?.length) model.sources.push({ cells, t: [0, AVAL_RAMP, 1e12], Q: [0, p.aval.Q, p.aval.Q] });
      else if (opts.phase !== 'fine') data.warnings = [...(data.warnings || []), 'rivière aval hors de la zone de calcul : non simulée'];
    }
    if (opts.makeSources) {
      const ns = opts.makeSources(grid, data);
      model.sources.push(...ns.sources);
      // Bord fermé là où l'eau entre (relief du calcul seulement : copie, l'affichage garde le vrai)
      if (ns.walls?.length) {
        model.z = model.z.slice();
        for (const k of ns.walls) model.z[k] += 50;
      }
      run.nest = { ...opts.nest, inlets: ns.sources.length, peakIn: ns.peakSum };
    }
    run.gauges = data.gauges;
    run.series = data.gauges.map(() => [[0, 0]]);
    // Points de mesure supplémentaires (bord de la zone fine), hors affichage
    const extra = opts.extraGauges || [];
    run.solverGauges = [...data.gauges, ...extra];
    run.bseries = extra.map(() => [[0, 0]]);
    run.gaugeEvery = opts.gaugeEvery ?? 300;

    // Couche d'eau
    run.water = new WaterCanvas(grid, toWgs, toL93);
    setWaterCanvas(state.map, run.water.canvas, run.water.corners);
    setLayerVisible('water', document.querySelector('[data-layer=water]').checked);
    state.water3dGrid = null;
    state.lastQ = null;
    if (state.is3d) ensureWater3d();

    const hyeto = hyetoOf(p);
    const totalTime = opts.totalTime ?? (p.rainH + p.tailH) * 3600;
    const snapshotEvery = Math.max(600, Math.ceil(totalTime / 150 / 300) * 300);
    run.totalTime = totalTime;
    run.hyeto = hyeto;
    showResults(true);
    setViewMode('t');
    $('time').max = 0;
    $('time').value = 0;
    drawHydro();

    const callbacks = {
      onGauge: (t, Q) => {
        const n = run.series.length;
        Q.forEach((q, i) => (i < n ? run.series[i] : run.bseries[i - n]).push([t, q]));
        drawHydroThrottled();
        if (p.stopAfterPeak && !run.stop && peakPassed(run, t, p)) {
          run.autoStopped = true;
          stopRun();
          prog.status('Pic de crue passé : arrêt du calcul…');
        }
      },
      onSnapshot: async (t, h, flux) => {
        if (run.placeK >= 0) run.placeSeries.push([t, h[run.placeK]]);
        const q = await run.store.add(t, h, flux);
        const idx = run.store.length - 1;
        const flow = await run.store.getFlow(idx);
        if (flow) accumulateFlowMax(run, flow);
        $('time').max = idx;
        if (run.follow) {
          $('time').value = idx;
          if (state.viewMode === 't') drawQuantized(q, t, flow);
        }
      },
      onProgress: (frac, info) => {
        const el = (performance.now() - run.t0) / 1000;
        // Temps restant : même modèle qu'avant le calcul, recalé sur la vitesse observée
        // depuis le début (pondérée par l'avancement).
        const cells = grid.nx * grid.ny;
        let tEndExp = expectedSimSeconds(p);
        if (info.t > tEndExp - 300) tEndExp = Math.min(totalTime, info.t + 3600);
        const remainWork = workOf(cells, p.res, Math.max(0, tEndExp - info.t));
        const doneWork = workOf(cells, p.res, info.t);
        const vModel = speedOf(engine);
        const vSeen = el > 3 ? doneWork / el : vModel;
        const w = Math.min(1, info.t / Math.max(1, tEndExp));
        const eta = remainWork / Math.exp((1 - w) * Math.log(vModel) + w * Math.log(vSeen));
        prog.set(
          'sim',
          frac,
          `${opts.phaseLabel ? `${opts.phaseLabel} · ` : ''}${fmtH(info.t)} / ${fmtH(totalTime)} simulées` +
            ` · reste ≈ ${fmtDur(eta)}${p.stopAfterPeak ? ' (arrêt après le pic estimé)' : ''}` +
            ` · ${engine === 'gpu' ? 'GPU' : 'CPU'}`,
        );
      },
      shouldStop: () => run.stop,
    };

    let maxima;
    let mass = null;
    run.t0 = performance.now();
    if (engine === 'gpu') {
      const solver = new GpuSolver(state.gpu.device, model, run.solverGauges);
      run.solver = solver;
      try {
        const res = await simulate(solver, { hyeto, totalTime, gaugeEvery: run.gaugeEvery, snapshotEvery, ...callbacks });
        maxima = res.maxima;
        run.tEnd = res.t;
      } finally {
        solver.destroy();
      }
    } else {
      ({ maxima, mass } = await runCpu(run, model, p, totalTime, snapshotEvery, callbacks));
    }
    run.maxima = maxima;
    run.maxQ = quantize(maxima.hmax);
    if (opts.phase === 'coarse') {
      // Premier temps du calcul emboîté : pas d'enregistrement ni de bilan.
      run.userStopped = run.stop && !run.autoStopped;
      if (run.autoStopped) run.totalTime = run.tEnd;
      prog.status('Bassin calculé : zone fine autour du lieu…');
    } else finishRun(run, mass);
  } catch (err) {
    console.error(err);
    if (err.message === 'Arrêté') prog.finish('Simulation arrêtée.', false);
    else prog.error(`Erreur : ${err.message}`);
  } finally {
    run.running = false;
    if (opts.phase !== 'coarse' || !run.maxima || run.userStopped) {
      $('run').textContent = 'Lancer la simulation';
      $('run').classList.remove('stop');
    }
  }
  return { run, ok: !!run.maxima && !run.userStopped };
}

/**
 * Le pic de crue est-il passé ? Après la fin de la pluie (+ 30 min), à tous les points de suivi
 * ayant un débit notable, le débit est retombé sous 70 % de son maximum, deux mesures de suite.
 */
export function peakPassed(run, t, p) {
  if (t < p.rainH * 3600 + 1800) return false;
  let any = false;
  for (let gi = 0; gi < run.series.length; gi++) {
    // La rivière aval est maintenue en crue : son débit ne retombe pas.
    if (run.gauges?.[gi]?.id === 'aval') continue;
    const s = run.series[gi];
    let peak = 0;
    for (const [, q] of s) if (q > peak) peak = q;
    if (peak < 0.05) continue;
    any = true;
    const n = s.length;
    if (n < 3 || s[n - 1][1] > 0.7 * peak || s[n - 2][1] > 0.7 * peak) return false;
  }
  return any;
}

export function runCpu(run, model, p, totalTime, snapshotEvery, cb) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../sim/cpuWorker.js', import.meta.url), { type: 'module' });
    run.worker = w;
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'gauge') cb.onGauge(m.t, m.Q);
      else if (m.type === 'snapshot') await cb.onSnapshot(m.t, m.h, m.flux);
      else if (m.type === 'progress') cb.onProgress(m.p, m.info);
      else if (m.type === 'done') {
        w.terminate();
        run.tEnd = m.t;
        resolve({ maxima: m.maxima, mass: m.mass });
      } else if (m.type === 'error') {
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.onerror = async (e) => {
      w.terminate();
      reject(new Error(await workerFailure(e, 'le calcul')));
    };
    w.postMessage({
      type: 'run',
      model,
      gauges: (run.solverGauges || run.gauges).map(({ cells, wx, wy, signed }) => ({ cells, wx, wy, signed })),
      rain: { totalMm: p.rainMm, durationH: p.rainH, shape: p.shape, hourly: p.hourly },
      options: { totalTime, gaugeEvery: run.gaugeEvery ?? 300, snapshotEvery },
    });
  });
}

export function stopRun() {
  const run = state.run;
  if (!run) return;
  run.stop = true;
  run.worker?.postMessage({ type: 'stop' });
  if (state.prepWorker) {
    state.prepWorker.terminate();
    state.prepWorker = null;
    state.prepReject?.(new Error('Arrêté'));
  }
  prog.status('Arrêt en cours…');
}

export function finishRun(run, mass) {
  const { grid } = run;
  const el = (performance.now() - run.t0) / 1000;
  const mask = state.data.mask;
  let a50 = 0;
  let a100 = 0;
  for (let k = 0; k < run.maxima.hmax.length; k++) {
    if (mask && !mask[k]) continue;
    const h = run.maxima.hmax[k];
    if (h > 0.5) a50++;
    if (h > 1) a100++;
  }
  const cellKm2 = (grid.dx * grid.dx) / 1e6;
  const peaks = run.gauges
    .map((g, i) => {
      const pk = run.series[i].reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0]);
      return `${g.name} : <strong>${fmtNum(pk[1])} m³/s</strong> à ${fmtH(pk[0])}`;
    })
    .join('<br>');
  let txt = `Calcul terminé en ${fmtNum(el)} s. Surface du bassin sous plus de 50 cm d'eau au maximum : <strong>${fmtNum(a50 * cellKm2, 2)} km²</strong> (plus d'1 m : ${fmtNum(a100 * cellKm2, 2)} km²).<br>${peaks}`;
  if (run.nest) {
    const n = run.nest;
    const cp = n.coarsePeaks.filter((g) => g.id.startsWith('study')).map((g) => `${g.name} : ${fmtNum(g.peak)} m³/s`).join(', ');
    txt =
      `Calcul en deux temps : bassin entier à ${n.coarseRes} m (${fmtNum(n.coarseSeconds)} s), puis zone fine de ${fmtNum(n.side[0], 1)} × ${fmtNum(n.side[1], 1)} km à ${grid.dx} m (${fmtNum(el)} s), ` +
      `alimentée par ${n.inlets} entrée${n.inlets > 1 ? 's' : ''} d'eau sur son bord (jusqu'à ${fmtNum(n.peakIn, 1)} m³/s au total)` +
      `${cp ? ` ; dans le calcul du bassin : ${cp}` : ''}.<br>` +
      txt.replace(/^Calcul terminé en [^.]+\. Surface du bassin/, 'Surface de la zone fine');
  }
  if (mass) {
    const err = mass.rain > 0 ? ((mass.rain - mass.out - mass.stored) / mass.rain) * 100 : 0;
    txt += `<br>Bilan de masse : erreur ${fmtNum(err, 3)} %.`;
  }
  if (state.data.bldCount) txt += `<br>Bâtiments IGN pris en compte : ${fmtNum(state.data.bldCount)} à moins d'1 km du lieu (${fmtNum(state.data.bldCells)} mailles bâties à plus de moitié, relevées ; les autres gardent le passage avec un frottement accru).`;
  if (run.params.aval) {
    const r = mainReceiver()?.receiver;
    txt += `<br>Rivière aval${r?.name ? ` (${escHtml(r.name)})` : ''} maintenue en crue à <strong>${fmtNum(run.params.aval.Q)} m³/s</strong> pendant tout l'épisode.`;
  }
  if (state.data.warnings?.length) txt += `<br><span class="warn">Données : ${state.data.warnings.join(' ; ')}.</span>`;
  $('summary').innerHTML = txt;
  // Vitesse observée sur cet appareil (pour les prochaines estimations), si le calcul a duré.
  if (el > 5 && run.engine && run.tEnd > 0) learnSpeed(run.engine, workOf(grid.nx * grid.ny, grid.dx, run.tEnd) / el);
  const auto = run.autoStopped && run.tEnd != null;
  const stopped = !auto && run.stop && (run.tEnd ?? run.totalTime) < run.totalTime - 1;
  if (auto) run.totalTime = run.tEnd; // la suite de la décrue n'a pas été calculée
  if (!stopped) prog.set('sim', 1, `${fmtH(run.totalTime)} en ${fmtClock(el)}`);
  prog.finish(
    stopped
      ? `Arrêtée à ${fmtH(run.tEnd ?? 0)} : résultats partiels.`
      : auto
        ? `Terminé : pic de crue passé, arrêt à ${fmtH(run.totalTime)}.`
        : `Terminé : ${fmtH(run.totalTime)} simulées.`,
    !stopped,
  );
  drawHydro();
  if (state.probe) probeAt(state.probe);
  run.userStopped = stopped;
  if (run.params.episode) renderEpisodeCompare(run);
  run.saveP = autoSave(run, stopped);
}
