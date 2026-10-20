import { DOMAIN, OUTLET, GAUGES, RESOLUTIONS } from './config.js';
import { makeGrid, toL93, cellOf, gridCornersWgs } from './geo.js';
import { createMap, setWaterCanvas, refreshWater, setGeoJson } from './map.js';
import { SHAPES, makeHyetograph } from './hydrology/rain.js';
import { buildModel } from './sim/model.js';
import { meanRunoff, runoffMm } from './hydrology/scs.js';
import { simulate } from './sim/driver.js';
import { getGpuDevice, gpuMaxCells, GpuSolver } from './sim/gpuSolver.js';
import { SnapshotStore, quantize, dequantize } from './sim/snapshots.js';
import { WaterCanvas, buildLut, LEGEND } from './render/water.js';
import { drawChart } from './ui/chart.js';
import { cacheClear } from './data/cache.js';
import { stableDt } from './sim/scheme.js';
import { setTerrain3d, setExaggeration, Toggle3dControl } from './terrain3d.js';
import { Water3DLayer } from './render/water3d.js';

const $ = (id) => document.getElementById(id);
const GPU_CELL_CAP = 16e6;
const CPU_CELL_CAP = 2.5e6;
const ZOOM_RESOLUTIONS = [10, 5, 2, 1];
const GAUGE_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#000075'];

const state = {
  map: null,
  overlayIds: [],
  gpu: null,
  data: null, // résultat du worker de préparation
  run: null, // simulation en cours ou terminée
  amc: 2,
  viewMode: 't',
  threshold: 0.1,
  lut: buildLut(0.1),
  hiddenGauges: new Set(),
  probe: null,
};

/* ---------- Mise en forme ---------- */

const fmtH = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s - h * 3600) / 60);
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
};
const fmtNum = (v, d = 0) => v.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtDepth = (h) => (h < 1 ? `${fmtNum(h * 100)} cm` : `${fmtNum(h, 2)} m`);

/* ---------- Paramètres saisis ---------- */

function params() {
  return {
    rainMm: Math.max(0, Number($('rain-mm').value) || 0),
    rainH: Math.max(0.25, Number($('rain-h').value) || 1),
    shape: $('rain-shape').value,
    amc: state.amc,
    soil: Number($('soil').value),
    basinOnly: $('basin-only').checked,
    zone: $('zone').value,
    res: Number($('res').value),
    tailH: Math.max(0, Number($('tail-h').value) || 0),
    burn: Math.max(0, Number($('burn').value) || 0),
    cnFactor: Math.max(0.1, Number($('cnf').value) || 1),
    engine: $('engine').value,
  };
}

function hyetoOf(p) {
  return makeHyetograph({ totalMm: p.rainMm, durationH: p.rainH, shape: p.shape });
}

/** Grille de calcul pour la zone et la résolution choisies. */
function currentGrid(p) {
  if (p.zone === 'basin') return makeGrid(DOMAIN, p.res);
  const b = state.map.getBounds();
  const pts = [b.getSouthWest(), b.getNorthEast(), b.getNorthWest(), b.getSouthEast()].map((ll) =>
    toL93(ll.lng, ll.lat),
  );
  const snap = (v, f) => f(v / p.res) * p.res;
  const bbox = {
    xmin: snap(Math.min(...pts.map((q) => q[0])), Math.floor),
    xmax: snap(Math.max(...pts.map((q) => q[0])), Math.ceil),
    ymin: snap(Math.min(...pts.map((q) => q[1])), Math.floor),
    ymax: snap(Math.max(...pts.map((q) => q[1])), Math.ceil),
  };
  return makeGrid(bbox, p.res);
}

function chooseEngine(p, cells) {
  const gpuCap = state.gpu ? Math.min(GPU_CELL_CAP, gpuMaxCells(state.gpu.device)) : 0;
  if (p.engine === 'gpu') return state.gpu && cells <= gpuCap ? 'gpu' : null;
  if (p.engine === 'cpu') return cells <= CPU_CELL_CAP ? 'cpu' : null;
  if (state.gpu && cells <= gpuCap) return 'gpu';
  return cells <= CPU_CELL_CAP ? 'cpu' : null;
}

/** Ordre de grandeur du temps de calcul (débits de mailles×pas par seconde mesurés). */
function estimateSeconds(p, cells, engine) {
  const T = (p.rainH + p.tailH) * 3600;
  const steps = T / stableDt(p.res, 3);
  const rate = engine === 'gpu' ? 6e8 : 2.5e7;
  return (cells * steps) / rate;
}

function updateResInfo() {
  const p = params();
  const list = p.zone === 'basin' ? RESOLUTIONS : ZOOM_RESOLUTIONS;
  const sel = $('res');
  const prev = Number(sel.value);
  sel.innerHTML = '';
  for (const r of list) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = `${r} m`;
    sel.appendChild(o);
  }
  const def = p.zone === 'basin' ? (state.gpu ? 25 : 50) : state.gpu ? 5 : 10;
  sel.value = list.includes(prev) ? prev : def;
  describeRes();
}

function describeRes() {
  const p = params();
  if (!state.map) return;
  const grid = currentGrid(p);
  const cells = grid.nx * grid.ny;
  const engine = chooseEngine(p, cells);
  const km2 = ((grid.nx * grid.ny * p.res * p.res) / 1e6).toFixed(0);
  let txt = `${fmtNum(grid.nx)} × ${fmtNum(grid.ny)} mailles (${fmtNum(cells / 1e6, 1)} M) sur ${km2} km². `;
  if (!engine) {
    txt += `<span class="warn">Trop de mailles pour ${state.gpu ? 'cet appareil' : 'le calcul sans carte graphique'} : choisissez une résolution plus grossière${p.zone === 'view' ? ' ou zoomez' : ''}.</span>`;
  } else {
    const s = estimateSeconds(p, cells, engine);
    const est = s < 90 ? `${Math.max(10, Math.round(s / 10) * 10)} s` : `${Math.round(s / 60)} min`;
    txt += `Calcul ${engine === 'gpu' ? 'GPU' : 'CPU'}, environ ${est} (ordre de grandeur).`;
  }
  if (p.zone === 'view')
    txt += ' <span class="warn">En mode zone affichée, l\'eau venant de l\'amont hors écran n\'est pas comptée.</span>';
  $('res-info').innerHTML = txt;
}

function updateRainInfo() {
  const p = params();
  const h = hyetoOf(p);
  const pts = [];
  const D = h.durationS;
  for (let k = 0; k <= 200; k++) {
    const t = (k / 200) * D;
    pts.push([t / 3600, h.intensity(t)]);
  }
  drawChart($('hyeto'), {
    series: [{ name: 'i', color: '#2b7de9', points: pts, fill: 'rgba(43,125,233,0.18)' }],
    xMax: p.rainH,
    yLabel: 'mm/h',
    xFormat: (x) => `${+x.toFixed(1)} h`,
  });
  // Ruissellement indicatif pour un sol moyen (prairie / culture / bâti)
  let extra = '';
  if (state.data) {
    const model = buildModel({
      grid: state.data.grid,
      terrain: state.data,
      classes: state.data.classes,
      spc: state.data.spc,
      soilGroup: p.soil,
      amc: p.amc,
      rainOnBasinOnly: true,
      cnFactor: p.cnFactor,
    });
    const q = meanRunoff(model.S, p.rainMm);
    extra = ` Ruissellement moyen attendu sur la zone : <strong>${fmtNum(q)} mm</strong> (${fmtNum((q / Math.max(p.rainMm, 1e-9)) * 100)} % de la pluie).`;
  } else {
    const S = 25400 / 80 - 254;
    extra = ` Pour un sol type (CN 80), environ ${fmtNum(runoffMm(p.rainMm, S))} mm ruissellent.`;
  }
  $('rain-info').innerHTML = `Pointe : <strong>${fmtNum(h.peakMmH(), 1)} mm/h</strong>.${extra}`;
}

/* ---------- Interface ---------- */

function setupUi() {
  const shapeSel = $('rain-shape');
  for (const [k, v] of Object.entries(SHAPES)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = v;
    shapeSel.appendChild(o);
  }
  shapeSel.value = 'chicago';

  document.querySelectorAll('.chips').forEach((box) => {
    const target = $(box.dataset.target);
    for (const v of box.dataset.values.split(',')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = v;
      b.onclick = () => {
        target.value = v;
        target.dispatchEvent(new Event('input'));
      };
      box.appendChild(b);
    }
  });

  const seg = (id, fn) => {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      fn(b.dataset.v);
    });
  };
  seg('amc', (v) => {
    state.amc = Number(v);
    updateRainInfo();
  });
  seg('view-mode', (v) => {
    state.viewMode = v;
    renderCurrent();
  });

  for (const id of ['rain-mm', 'rain-h', 'rain-shape', 'soil', 'cnf']) $(id).addEventListener('input', updateRainInfo);
  for (const id of ['rain-h', 'tail-h', 'res', 'engine']) $(id).addEventListener('input', describeRes);
  $('zone').addEventListener('input', updateResInfo);

  $('run').onclick = () => (state.run?.running ? stopRun() : startRun());
  $('clear-cache').onclick = async () => {
    await cacheClear();
    state.data = null;
    $('clear-cache').textContent = 'Cache vidé';
  };

  $('time').addEventListener('input', () => {
    if (state.viewMode !== 't') {
      state.viewMode = 't';
      $('view-mode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === 't'));
    }
    if (state.run) state.run.follow = Number($('time').value) === Number($('time').max);
    renderCurrent();
  });
  $('thr').addEventListener('input', () => {
    state.threshold = Number($('thr').value) / 100;
    $('thr-label').textContent = `${$('thr').value} cm`;
    state.lut = buildLut(state.threshold);
    state.water3d?.setThreshold(state.threshold);
    renderCurrent();
  });
  $('relief3d').addEventListener('change', () => toggle3d($('relief3d').checked));
  $('exag').addEventListener('input', () => {
    $('exag-label').textContent = `×${Number($('exag').value).toFixed(1)}`;
    if (state.is3d) setExaggeration(state.map, Number($('exag').value));
  });
  $('play').onclick = togglePlay;

  $('legend').innerHTML = LEGEND.map(
    (l) => `<span><i style="background:rgb(${l.color.join(',')})"></i>${l.label}</span>`,
  ).join('');

  document.querySelectorAll('[data-layer]').forEach((cb) =>
    cb.addEventListener('change', () => setLayerVisible(cb.dataset.layer, cb.checked)),
  );

  const panel = $('panel');
  panel.querySelector('.panel-head').addEventListener('click', () => {
    if (window.matchMedia('(max-width: 760px)').matches) panel.classList.toggle('collapsed');
  });

  window.addEventListener('resize', () => {
    updateRainInfo();
    drawHydro();
  });
}

function setLayerVisible(name, on) {
  const map = state.map;
  const ids =
    name === 'labels'
      ? state.overlayIds
      : name === 'basin'
        ? ['basin']
        : name === 'rivers'
          ? ['rivers']
          : name === 'shadow'
            ? ['shadow']
            : ['water', 'water3d'];
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

/* ---------- Avancement ---------- */

const STEPS = {
  dem: { label: 'Téléchargement du relief LiDAR HD', weight: 0.12, pct: true },
  lc: { label: "Téléchargement de l'occupation du sol", weight: 0.12, pct: true },
  rivers: { label: 'Téléchargement des cours d\'eau', weight: 0.03 },
  prep: { label: 'Préparation du relief et du bassin versant', weight: 0.05 },
  sim: { label: 'Simulation de la crue', weight: 0.68, pct: true },
};

const CONNECTING = 'Connexion aux services de l\'IGN…';
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Panneau d'avancement + badge sur la carte. */
const prog = {
  st: {},
  timer: null,
  t0: 0,
  note: '',
  el(sel) {
    return $('progress').querySelector(sel);
  },
  start() {
    this.st = {};
    this.note = '';
    this.t0 = performance.now();
    $('progress').hidden = false;
    $('progress').classList.remove('error');
    $('map-status').className = '';
    clearInterval(this.timer);
    this.timer = setInterval(() => this.render(), 1000);
    this.render();
    $('progress').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
  set(step, p, detail) {
    if (this.note === CONNECTING) this.note = '';
    this.st[step] = { p: Math.max(0, Math.min(1, p)), detail };
    this.render();
  },
  status(text) {
    this.note = text;
    this.render();
  },
  overall() {
    let o = 0;
    for (const [k, def] of Object.entries(STEPS)) o += def.weight * (this.st[k]?.p ?? 0);
    return o;
  },
  render() {
    const pct = Math.floor(this.overall() * 100);
    const el = (performance.now() - this.t0) / 1000;
    this.el('.pct').textContent = `${pct} %`;
    this.el('.bar span').style.width = `${pct}%`;
    this.el('.elapsed').textContent = this.timer ? `écoulé ${fmtClock(el)}` : '';
    const active = [];
    for (const [k, def] of Object.entries(STEPS)) {
      const li = $('progress').querySelector(`[data-step="${k}"]`);
      const s = this.st[k];
      li.classList.toggle('done', !!s && s.p >= 1);
      li.classList.toggle('active', !!s && s.p < 1);
      const span = li.querySelector('span');
      if (!s) span.textContent = '';
      else if (s.p >= 1) span.textContent = s.detail || 'ok';
      else {
        span.textContent = [def.pct ? `${Math.floor(s.p * 100)} %` : '…', s.detail].filter(Boolean).join(' · ');
        active.push(def.label + (def.pct ? ` ${Math.floor(s.p * 100)} %` : '') + (s.detail && k !== 'sim' ? ` (${s.detail})` : ''));
      }
    }
    const text = this.note || (active.length ? `${active.join(' · ')}…` : '');
    this.el('.status').textContent = text;
    if (this.timer) {
      const badge = $('map-status');
      badge.hidden = false;
      badge.textContent = `⏳ ${pct} % · ${active[0] || this.note || 'Calcul'} · ${fmtClock(el)}`;
    }
  },
  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
  },
  finish(text, ok = true) {
    this.stopTimer();
    this.note = text;
    this.render();
    const badge = $('map-status');
    badge.hidden = false;
    badge.className = ok ? 'ok' : '';
    badge.textContent = `${ok ? '✓' : '■'} ${text}`;
    setTimeout(() => {
      if (!this.timer) badge.hidden = true;
    }, 8000);
  },
  error(text) {
    this.stopTimer();
    $('progress').hidden = false;
    $('progress').classList.add('error');
    this.note = text;
    this.render();
    const badge = $('map-status');
    badge.hidden = false;
    badge.className = 'error';
    badge.textContent = `⚠ ${text}`;
    $('progress').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
};

/* ---------- Données ---------- */

function loadData(grid, p) {
  const key = JSON.stringify([grid.xmin, grid.ymin, grid.nx, grid.ny, grid.dx, p.burn]);
  if (state.data?.key === key) return Promise.resolve(state.data);
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./data/prepWorker.js', import.meta.url), { type: 'module' });
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
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'Erreur du worker de préparation'));
    };
    const outlet = p.zone === 'basin' ? OUTLET : null;
    w.postMessage({ grid, burnDepth: p.burn, outlet, gauges: GAUGES });
  });
}

function showContext(data) {
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

async function startRun() {
  const p = params();
  if (p.rainMm <= 0) {
    prog.error('Indiquez un cumul de pluie supérieur à 0 mm.');
    return;
  }
  const grid = currentGrid(p);
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
  state.run = run;
  $('run').textContent = 'Arrêter';
  $('run').classList.add('stop');
  $('results').hidden = true;
  prog.start();
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
      amc: p.amc,
      rainOnBasinOnly: p.basinOnly && !!data.mask,
      cnFactor: p.cnFactor,
    });
    run.gauges = data.gauges;
    run.series = data.gauges.map(() => [[0, 0]]);

    // Couche d'eau
    run.water = new WaterCanvas(grid.nx, grid.ny);
    setWaterCanvas(state.map, run.water.canvas, gridCornersWgs(grid));
    setLayerVisible('water', document.querySelector('[data-layer=water]').checked);
    state.water3dGrid = null;
    state.lastQ = null;
    if (state.is3d) ensureWater3d();

    const hyeto = hyetoOf(p);
    const totalTime = (p.rainH + p.tailH) * 3600;
    const snapshotEvery = Math.max(600, Math.ceil(totalTime / 150 / 300) * 300);
    run.totalTime = totalTime;
    run.hyeto = hyeto;
    $('results').hidden = false;
    $('time').max = 0;
    $('time').value = 0;
    drawHydro();

    const callbacks = {
      onGauge: (t, Q) => {
        Q.forEach((q, i) => run.series[i].push([t, q]));
        drawHydroThrottled();
      },
      onSnapshot: async (t, h) => {
        const q = await run.store.add(t, h);
        const idx = run.store.length - 1;
        $('time').max = idx;
        if (run.follow) {
          $('time').value = idx;
          if (state.viewMode === 't') drawQuantized(q, t);
        }
      },
      onProgress: (frac, info) => {
        const el = (performance.now() - run.t0) / 1000;
        const eta = frac > 0.02 ? (el / frac) * (1 - frac) : null;
        prog.set(
          'sim',
          frac,
          `${fmtH(info.t)} / ${fmtH(totalTime)} simulées` +
            (eta != null ? ` · reste ≈ ${eta < 90 ? `${Math.round(eta)} s` : `${Math.round(eta / 60)} min`}` : '') +
            ` · ${engine === 'gpu' ? 'GPU' : 'CPU'}`,
        );
      },
      shouldStop: () => run.stop,
    };

    let maxima;
    let mass = null;
    run.t0 = performance.now();
    if (engine === 'gpu') {
      const solver = new GpuSolver(state.gpu.device, model, data.gauges);
      run.solver = solver;
      try {
        const res = await simulate(solver, { hyeto, totalTime, gaugeEvery: 300, snapshotEvery, ...callbacks });
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
    finishRun(run, mass);
  } catch (err) {
    console.error(err);
    if (err.message === 'Arrêté') prog.finish('Simulation arrêtée.', false);
    else prog.error(`Erreur : ${err.message}`);
  } finally {
    run.running = false;
    $('run').textContent = 'Lancer la simulation';
    $('run').classList.remove('stop');
  }
}

function runCpu(run, model, p, totalTime, snapshotEvery, cb) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./sim/cpuWorker.js', import.meta.url), { type: 'module' });
    run.worker = w;
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'gauge') cb.onGauge(m.t, m.Q);
      else if (m.type === 'snapshot') await cb.onSnapshot(m.t, m.h);
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
    w.onerror = (e) => reject(new Error(e.message || 'Erreur du calcul CPU'));
    w.postMessage({
      type: 'run',
      model,
      gauges: run.gauges.map(({ cells, wx, wy }) => ({ cells, wx, wy })),
      rain: { totalMm: p.rainMm, durationH: p.rainH, shape: p.shape },
      options: { totalTime, gaugeEvery: 300, snapshotEvery },
    });
  });
}

function stopRun() {
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

function finishRun(run, mass) {
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
  if (mass) {
    const err = mass.rain > 0 ? ((mass.rain - mass.out - mass.stored) / mass.rain) * 100 : 0;
    txt += `<br>Bilan de masse : erreur ${fmtNum(err, 3)} %.`;
  }
  if (state.data.warnings?.length) txt += `<br><span class="warn">Données : ${state.data.warnings.join(' ; ')}.</span>`;
  $('summary').innerHTML = txt;
  const stopped = run.stop && (run.tEnd ?? run.totalTime) < run.totalTime - 1;
  if (!stopped) prog.set('sim', 1, `${fmtH(run.totalTime)} en ${fmtClock(el)}`);
  prog.finish(
    stopped ? `Arrêtée à ${fmtH(run.tEnd ?? 0)} : résultats partiels.` : `Terminé : ${fmtH(run.totalTime)} simulées.`,
    !stopped,
  );
  drawHydro();
  if (state.probe) probeAt(state.probe);
}

/* ---------- Affichage ---------- */

function drawQuantized(q, t) {
  const run = state.run;
  if (!run?.water) return;
  run.water.draw(q, state.lut);
  refreshWater(state.map);
  state.lastQ = q;
  if (state.is3d) {
    ensureWater3d();
    state.water3d.setDepth(q);
  }
  $('time-label').textContent = t == null ? 'max' : fmtH(t);
  state.cursorT = t;
  drawHydro();
}

async function renderCurrent() {
  const run = state.run;
  if (!run?.water) return;
  if (state.viewMode === 'max') {
    if (run.maxQ) drawQuantized(run.maxQ, null);
    return;
  }
  const idx = Number($('time').value);
  if (!run.store.length) return;
  const q = await run.store.get(idx);
  drawQuantized(q, run.store.timeOf(idx));
}

let hydroTimer = null;
function drawHydroThrottled() {
  if (hydroTimer) return;
  hydroTimer = setTimeout(() => {
    hydroTimer = null;
    drawHydro();
  }, 500);
}

function drawHydro() {
  const run = state.run;
  if (!run?.gauges) return;
  const series = run.gauges
    .map((g, i) => ({
      name: g.name,
      color: GAUGE_COLORS[i % GAUGE_COLORS.length],
      points: run.series[i].map(([t, q]) => [t / 3600, q]),
      hidden: state.hiddenGauges.has(g.id),
    }))
    .filter((s) => !s.hidden);
  drawChart($('hydro'), {
    series,
    xMax: run.totalTime / 3600,
    xFormat: (x) => `${+x.toFixed(1)} h`,
    cursor: state.cursorT != null ? state.cursorT / 3600 : null,
  });
  const lg = $('gauge-legend');
  if (lg.childElementCount !== run.gauges.length) {
    lg.innerHTML = '';
    run.gauges.forEach((g, i) => {
      const b = document.createElement('button');
      b.innerHTML = `<i style="background:${GAUGE_COLORS[i % GAUGE_COLORS.length]}"></i>${g.name}`;
      b.onclick = () => {
        if (state.hiddenGauges.has(g.id)) state.hiddenGauges.delete(g.id);
        else state.hiddenGauges.add(g.id);
        b.classList.toggle('off', state.hiddenGauges.has(g.id));
        drawHydro();
      };
      lg.appendChild(b);
    });
  }
}

let playTimer = null;
function togglePlay() {
  if (playTimer) return stopPlay();
  const run = state.run;
  if (!run?.store.length) return;
  if (state.viewMode !== 't') {
    state.viewMode = 't';
    $('view-mode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === 't'));
  }
  if (Number($('time').value) >= Number($('time').max)) $('time').value = 0;
  $('play').textContent = '❚❚';
  let busy = false;
  playTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    const v = Number($('time').value);
    if (v >= Number($('time').max)) {
      stopPlay();
    } else {
      $('time').value = v + 1;
      run.follow = false;
      await renderCurrent();
    }
    busy = false;
  }, 160);
}
function stopPlay() {
  clearInterval(playTimer);
  playTimer = null;
  $('play').textContent = '▶';
}

/* ---------- Sonde (clic sur la carte) ---------- */

async function probeAt(lngLat) {
  state.probe = lngLat;
  setGeoJson(state.map, 'probe', {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] }, properties: {} }],
  });
  const run = state.run;
  const data = state.data;
  if (!run || !data) return;
  const [x, y] = toL93(lngLat.lng, lngLat.lat);
  const c = cellOf(run.grid, x, y);
  if (!c) {
    $('probe-info').textContent = 'Point hors de la zone simulée.';
    $('probe-chart').hidden = true;
    return;
  }
  const k = c.k;
  const lines = [`Altitude du terrain : <strong>${fmtNum(data.dem[k], 1)} m</strong>`];
  if (run.store.length) {
    const idx = Number($('time').value);
    const q = await run.store.get(idx);
    lines.push(`Hauteur d'eau à ${fmtH(run.store.timeOf(idx))} : <strong>${fmtDepth(dequantize(q[k]))}</strong>`);
  }
  if (run.maxima) {
    const hm = run.maxima.hmax[k];
    lines.push(
      hm > 0.01
        ? `Maximum : <strong>${fmtDepth(hm)}</strong> à ${fmtH(run.maxima.tmax[k])}, vitesse max ${fmtNum(run.maxima.vmax[k], 1)} m/s`
        : 'Pas d\'eau significative à ce point.',
    );
  }
  $('probe-info').innerHTML = lines.join('<br>');
  if (run.store.length > 1) {
    $('probe-info').innerHTML += '<br><em>Calcul de l\'évolution au point…</em>';
    const s = await run.store.series(k);
    $('probe-info').innerHTML = lines.join('<br>');
    $('probe-chart').hidden = false;
    drawChart($('probe-chart'), {
      series: [{ name: 'h', color: '#1f6fe0', points: s.map(([t, h]) => [t / 3600, h]), fill: 'rgba(31,111,224,0.2)' }],
      xMax: run.totalTime / 3600,
      yLabel: 'hauteur (m)',
      xFormat: (x) => `${+x.toFixed(0)} h`,
    });
  }
}

/* ---------- Vue 3D ---------- */

/** (Re)construit le maillage de la nappe 3D pour la simulation courante. */
function ensureWater3d() {
  const run = state.run;
  if (!run?.grid || !state.data?.dem || state.water3dGrid === run.grid) return;
  state.water3d.setGrid(run.grid, state.data.dem);
  state.water3dGrid = run.grid;
  if (state.lastQ) state.water3d.setDepth(state.lastQ);
}

function toggle3d(on) {
  state.is3d = on;
  $('relief3d').checked = on;
  state.ctrl3d.set(on);
  setTerrain3d(state.map, on, Number($('exag').value));
  // En 3D, la couche drapée s'efface au profit de la nappe en volume.
  if (state.map.getLayer('water')) state.map.setPaintProperty('water', 'raster-opacity', on ? 0.45 : 1);
  if (on) {
    ensureWater3d();
    if (state.lastQ) state.water3d.setDepth(state.lastQ);
  }
}

/* ---------- Démarrage ---------- */

async function main() {
  setupUi();
  updateRainInfo();
  const [map, gpu] = await Promise.all([createMap($('map')), getGpuDevice()]);
  state.map = map.map;
  state.overlayIds = map.overlayIds;
  state.gpu = gpu;
  $('engine-info').textContent = gpu
    ? `Carte graphique détectée${gpu.label ? ` : ${gpu.label}` : ''}.`
    : 'WebGPU indisponible dans ce navigateur : calcul sur le processeur (plus lent, résolution plus grossière).';
  updateResInfo();
  state.map.on('moveend', () => {
    if (params().zone === 'view') describeRes();
  });
  state.map.on('click', (e) => probeAt(e.lngLat));
  // Accès à l'état depuis la console du navigateur (diagnostic).
  window.floodApp = state;
  state.water3d = new Water3DLayer();
  state.water3d.setThreshold(state.threshold);
  state.map.addLayer(state.water3d, 'rivers');
  state.ctrl3d = new Toggle3dControl((on) => toggle3d(on));
  state.map.addControl(state.ctrl3d, 'top-right');
  if (gpu) {
    gpu.device.lost.then((info) => {
      state.gpu = null;
      $('engine-info').textContent = `Le GPU a été perdu (${info.message || info.reason}). Rechargez la page.`;
    });
  }
}

main();
