import maplibregl from 'maplibre-gl';
import { DOMAIN, OUTLET, GAUGES, RESOLUTIONS } from './config.js';
import { makeGrid, toL93, toWgs, cellOf, gridCornersWgs } from './geo.js';
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
import { packRun, saveRun, listRuns, loadRun, deleteRun, renameRun, exportRun, importRun, formatSize } from './data/runStore.js';
import { fitBoundsOf } from './map.js';
import { sectionEnds, autoOrientation, fetchFineProfile, sampleSection, drawSection } from './ui/section.js';

const $ = (id) => document.getElementById(id);
const GPU_CELL_CAP = 16e6;
const CPU_CELL_CAP = 2.5e6;
const ZOOM_RESOLUTIONS = [10, 5, 2, 1];
const STUDY_RESOLUTIONS = [50, 25, 15, 10, 5, 2];
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
const fmtArea = (km2) => (km2 < 0.5 ? `${fmtNum(km2 * 100)} ha` : `${fmtNum(km2, km2 < 10 ? 1 : 0)} km²`);
const fmtDepth = (h) => (h < 1 ? `${fmtNum(h * 100)} cm` : `${fmtNum(h, 2)} m`);

/* ---------- Paramètres saisis ---------- */

function params() {
  return {
    rainMm: Math.max(0, Number($('rain-mm').value) || 0),
    rainH: Math.max(0.25, Number($('rain-h').value) || 1),
    shape: $('rain-shape').value,
    amc: state.amc,
    soil: Number($('soil').value),
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
  if (p.zone === 'study') {
    const f = studyFrame();
    if (!f || !studyCands().length) return null;
    const snap = (v, fn) => fn(v / p.res) * p.res;
    return makeGrid(
      { xmin: snap(f.xmin, Math.floor), xmax: snap(f.xmax, Math.ceil), ymin: snap(f.ymin, Math.floor), ymax: snap(f.ymax, Math.ceil) },
      p.res,
    );
  }
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
  const list = p.zone === 'basin' ? RESOLUTIONS : p.zone === 'study' ? STUDY_RESOLUTIONS : ZOOM_RESOLUTIONS;
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
  if (p.zone === 'study') autoResForStudy();
  describeRes();
}

function describeRes() {
  const p = params();
  if (!state.map) return;
  const grid = currentGrid(p);
  if (!grid) {
    $('res-info').textContent = 'Choisissez d\'abord le lieu à étudier.';
    renderStudy();
    return;
  }
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
  $('res-info').innerHTML = txt;
  renderStudy();
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
  setupSection();
  setupCatchment();
  setupSearch();
  $('import-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const meta = await importRun(f);
      await refreshSaved();
      openSaved(meta.id);
    } catch (err) {
      prog.error(`Import impossible : ${err.message || err}`);
    }
  });
  refreshSaved();

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

/**
 * Explique l'échec d'un worker. Sans message, c'est soit une page ouverte avant une mise à jour
 * du site (les fichiers ont changé de nom), soit un arrêt du navigateur (mémoire).
 */
async function workerFailure(e, what) {
  if (e?.message) return e.message;
  try {
    const r = await fetch(new URL('./', location.href), { cache: 'no-store' });
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


function loadData(grid, p) {
  const sel = p.zone === 'study' ? studyCands() : [];
  const upstreamOf = sel.length
    ? sel.map((c) =>
        c.kind === 'slope'
          ? { x: c.point.x, y: c.point.y, exact: true }
          : { x: c.point.x, y: c.point.y, areaM2: c.areaKm2 * 1e6, radiusM: Math.max(30, 1.5 * c.dx) },
      )
    : null;
  const gauges = [...studyGauges(), ...GAUGES];
  const key = JSON.stringify([grid.xmin, grid.ymin, grid.nx, grid.ny, grid.dx, p.burn, upstreamOf]);
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
    w.onerror = async (e) => {
      w.terminate();
      state.prepWorker = null;
      reject(new Error(await workerFailure(e, 'la préparation des données')));
    };
    const outlet = p.zone === 'basin' ? OUTLET : null;
    w.postMessage({ grid, burnDepth: p.burn, outlet, upstreamOf, gauges });
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
  // Nom du lieu, cherché pendant le calcul (pour nommer l'enregistrement).
  run.placeP = findPlaceName(grid, p).catch(() => null);
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
      rainOnBasinOnly: !!data.mask,
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
    w.onerror = async (e) => {
      w.terminate();
      reject(new Error(await workerFailure(e, 'le calcul')));
    };
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
  autoSave(run, stopped);
}

/* ---------- Affichage ---------- */

function drawQuantized(q, t) {
  const run = state.run;
  if (!run?.water) return;
  run.water.draw(q, state.lut);
  refreshWater(state.map);
  state.lastQ = q;
  state.cursorT = t;
  redrawSection();
  if (state.is3d) {
    ensureWater3d();
    state.water3d.setDepth(q);
  }
  $('time-label').textContent = t == null ? 'max' : fmtH(t);
  syncDock();
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
  syncDock();
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
  syncDock();
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

/* ---------- Bulle de survol : hauteur d'eau sous la souris ---------- */

function setupMapTip() {
  const tip = $('map-tip');
  let pending = null;
  const fmtD = (h) => (h < 1 ? `${Math.round(h * 100)} cm` : `${h.toFixed(2).replace('.', ',')} m`);
  const show = () => {
    const e = pending;
    pending = null;
    const run = state.run;
    if (!e || !run?.grid || !state.lastQ) return (tip.hidden = true);
    const [x, y] = toL93(e.lngLat.lng, e.lngLat.lat);
    const c = cellOf(run.grid, x, y);
    if (!c) return (tip.hidden = true);
    const h = dequantize(state.lastQ[c.k]);
    const hm = run.maxima ? run.maxima.hmax[c.k] : 0;
    if (h < state.threshold && hm < state.threshold) return (tip.hidden = true);
    const when = state.viewMode === 'max' ? 'maximum atteint' : `à ${$('time-label').textContent}`;
    let html = h >= 0.01 ? `<b>${fmtD(h)}</b> d'eau ${when}` : `Pas d'eau ${when}`;
    if (run.maxima && state.viewMode !== 'max' && hm >= 0.01) html += `<br>max ${fmtD(hm)} à ${fmtH(run.maxima.tmax[c.k])}`;
    else if (run.maxima && state.viewMode === 'max' && hm >= 0.01) html += `<br>atteint à ${fmtH(run.maxima.tmax[c.k])}`;
    tip.innerHTML = html;
    // Bulle placée près du curseur, en restant dans la carte
    const box = state.map.getContainer().getBoundingClientRect();
    const px = Math.min(e.point.x, box.width - 190);
    const py = Math.min(e.point.y, box.height - 60);
    tip.style.left = `${px}px`;
    tip.style.top = `${py}px`;
    tip.hidden = false;
  };
  state.map.on('mousemove', (e) => {
    if (!pending) requestAnimationFrame(show);
    pending = e;
  });
  state.map.on('mouseout', () => {
    pending = null;
    tip.hidden = true;
  });
  state.map.on('movestart', () => (tip.hidden = true));
}

/* ---------- Recherche de lieu (géocodage IGN) ---------- */

function setupSearch() {
  const input = $('place-search');
  const list = $('place-results');
  let timer = null;
  let ctrl = null;
  let items = [];
  let active = -1;
  input.closest('.search').addEventListener('click', (e) => e.stopPropagation());
  const close = () => {
    list.hidden = true;
    active = -1;
  };
  const render = () => {
    list.innerHTML = '';
    items.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = i === active ? 'on' : '';
      const kind = r.country === 'PositionOfInterest' ? (r.poiType?.[0] || r.kind || '') : r.kind === 'street' ? 'voie' : 'adresse';
      li.innerHTML = `<span></span><small></small>`;
      li.firstChild.textContent = r.fulltext;
      li.lastChild.textContent = kind;
      li.onmousedown = (e) => {
        e.preventDefault();
        choose(r);
      };
      list.appendChild(li);
    });
    list.hidden = !items.length;
  };
  const choose = (r) => {
    input.value = r.fulltext;
    close();
    input.blur();
    const poi = r.country === 'PositionOfInterest';
    const big = poi && /commune|ville|village/i.test((r.poiType || []).join(' '));
    state.map.flyTo({ center: [r.x, r.y], zoom: big ? 13 : 15.5, duration: 1200 });
    if (!state.searchMarker) {
      const el = document.createElement('div');
      el.className = 'search-pin';
      state.searchMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' });
    }
    state.searchMarker.setLngLat([r.x, r.y]).addTo(state.map);
    // En mode « lieu étudié », le lieu cherché est analysé directement.
    if (params().zone === 'study' && !state.run?.running) studyPlace(r.x, r.y);
    if (window.matchMedia('(max-width: 760px)').matches) $('panel').classList.add('collapsed');
  };
  const search = async (text) => {
    ctrl?.abort();
    ctrl = new AbortController();
    const q = new URLSearchParams({
      text,
      type: 'PositionOfInterest,StreetAddress',
      maximumResponses: '7',
      lonlat: '5.6,43.47', // priorité aux résultats proches de la vallée de l'Arc
    });
    try {
      const res = await fetch(`https://data.geopf.fr/geocodage/completion?${q}`, { signal: ctrl.signal });
      const json = await res.json();
      items = (json.results || []).filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y));
      active = -1;
      render();
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('Recherche de lieu indisponible', e);
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    ctrl?.abort();
    items = []; // pas de validation d'une suggestion périmée
    close();
    const t = input.value.trim();
    if (t.length < 3) {
      items = [];
      close();
      return;
    }
    timer = setTimeout(() => search(t), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length) choose(items[Math.max(0, active)]);
    } else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('focus', () => items.length && render());
}

/* ---------- Lieu étudié : bassins versants qui peuvent l'atteindre ---------- */

const STUDY_KEY = 'flood-sim-study';
const MAX_STUDY_KM2 = 2000; // au-delà, la crue relève d'un modèle fluvial (débit imposé)

/** Dénivelé (m) sous lequel un débordement du cours d'eau peut atteindre le lieu. */
const reachTolerance = (areaKm2) => 2 + 3 * Math.log10(1 + 10 * areaKm2);

function candidateVerdict(c) {
  if (c.kind === 'slope') return { level: 'ok', text: 'eau qui ruisselle directement vers le lieu' };
  if (!c.complete || c.areaKm2 > MAX_STUDY_KM2)
    return { level: 'warn', text: 'bassin trop grand pour une simulation dans le navigateur' };
  const tol = reachTolerance(c.areaKm2);
  if (c.dz <= 0.5 * tol) return { level: 'warn', text: 'lieu exposé à un débordement' };
  if (c.dz <= tol) return { level: 'ok', text: 'débordement possible jusqu\'au lieu' };
  return { level: 'muted', text: 'lieu nettement au-dessus du lit : débordement peu probable' };
}

/** Choix par défaut : les cours d'eau dont un débordement peut atteindre le lieu. */
function defaultChecked(c) {
  if (c.kind === 'slope') return true;
  if (!c.complete || c.areaKm2 > MAX_STUDY_KM2) return false;
  return c.dz <= reachTolerance(c.areaKm2);
}

const studyCands = () => (state.study?.cands || []).filter((c) => c.checked);

/** Points de suivi du débit au droit du lieu, un par cours d'eau retenu. */
function studyGauges() {
  return studyCands()
    .filter((c) => c.kind === 'stream')
    .map((c, i) => ({
      id: `study${i}`,
      name: `${c.name} (au droit du lieu)`,
      x: c.point.x,
      y: c.point.y,
      river: c.named ? c.name : null,
      halfWidth: Math.round(Math.min(450, Math.max(40, 40 * Math.sqrt(c.areaKm2)))),
    }));
}

/** Emprise (Lambert 93) à simuler : bassins retenus + abords du lieu, avec une marge. */
function studyFrame() {
  const s = state.study;
  if (!s) return null;
  const b = { xmin: s.house.x - 300, xmax: s.house.x + 300, ymin: s.house.y - 300, ymax: s.house.y + 300 };
  for (const c of studyCands()) {
    b.xmin = Math.min(b.xmin, c.bbox.xmin);
    b.xmax = Math.max(b.xmax, c.bbox.xmax);
    b.ymin = Math.min(b.ymin, c.bbox.ymin);
    b.ymax = Math.max(b.ymax, c.bbox.ymax);
  }
  const m = Math.max(150, 0.06 * Math.max(b.xmax - b.xmin, b.ymax - b.ymin));
  return { xmin: b.xmin - m, xmax: b.xmax + m, ymin: b.ymin - m, ymax: b.ymax + m };
}

function setupCatchment() {
  const sync = () => {
    const z = params().zone;
    $('catch-box').hidden = z !== 'study';
    $('zone-hint').textContent =
      z === 'study'
        ? "Choisissez un lieu n'importe où en France : l'application repère les cours d'eau qui peuvent " +
          "l'atteindre, délimite leurs bassins versants et ne simule que ceux-là (la pluie ne tombe que dessus)."
        : z === 'view'
          ? 'Simulation fine de la partie visible de la carte, pluie sur toute la zone. ' +
            "L'eau venant de l'amont hors écran n'est pas comptée."
          : "Préréglage : tout le bassin de l'Arc jusqu'à Aix (Pont de l'Arc) avec ses affluents, " +
            "débits suivis le long de l'Arc et des principaux vallats.";
    if (state.map) describeRes();
  };
  $('zone').addEventListener('input', sync);
  sync();
  $('catch-pick').onclick = () => setCatchMode(!state.catchMode);
  $('catch-fit').onclick = fitStudy;
  $('catch-clear').onclick = clearStudy;
  try {
    const saved = JSON.parse(localStorage.getItem(STUDY_KEY) || 'null');
    if (saved?.house && Array.isArray(saved.cands)) state.study = saved;
  } catch {
    /* stockage indisponible : sans importance */
  }
}

function saveStudy() {
  try {
    if (state.study) localStorage.setItem(STUDY_KEY, JSON.stringify(state.study));
    else localStorage.removeItem(STUDY_KEY);
  } catch {
    /* stockage plein ou interdit */
  }
}

/** Appelé quand la carte est prête. */
function restoreCatchment() {
  if (state.study) {
    showStudy();
    renderStudy();
  }
}

function setCatchMode(on) {
  state.catchMode = on;
  if (on && state.sectionMode) $('section-place').click();
  $('catch-pick').classList.toggle('on', on);
  if (state.map) state.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  if (on) {
    $('catch-info').textContent = 'Cliquez sur la carte à l\'endroit à étudier (une maison, un quartier, un pont…).';
    if (window.matchMedia('(max-width: 760px)').matches) $('panel').classList.add('collapsed');
  } else renderStudy();
}

/** Analyse d'un lieu : cours d'eau proches, bassins versants, dénivelés. */
function studyPlace(lng, lat) {
  setCatchMode(false);
  const [x, y] = toL93(lng, lat);
  state.catchWorker?.terminate();
  const w = new Worker(new URL('./data/catchmentWorker.js', import.meta.url), { type: 'module' });
  state.catchWorker = w;
  state.study = null;
  $('catch-list').innerHTML = '';
  setGeoJson(state.map, 'catchment', {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { house: 1 } }],
  });
  $('catch-fit').disabled = true;
  $('catch-clear').disabled = false;
  const info = $('catch-info');
  const badge = $('map-status');
  const say = (txt) => {
    info.textContent = txt;
    if (state.run?.running || state.prepWorker) return;
    badge.className = '';
    badge.textContent = txt;
    badge.hidden = false;
  };
  say("Recherche des cours d'eau proches et de leurs bassins versants…");
  const end = () => {
    w.terminate();
    if (state.catchWorker === w) state.catchWorker = null;
    if (!state.run?.running && !state.prepWorker) badge.hidden = true;
  };
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress')
      say(
        m.level === 0
          ? "Recherche des cours d'eau proches (carré de 4 km)…"
          : `Bassins versants plus grands : recherche de l'amont dans un carré de ${fmtNum(m.sizeKm)} km (${m.remaining} en cours)…`,
      );
    else if (m.type === 'done') {
      end();
      state.study = {
        house: m.house,
        houseWgs: m.houseWgs,
        zHouse: m.zHouse,
        cands: m.cands.map((c) => ({ ...c, checked: defaultChecked(c) })),
      };
      saveStudy();
      showStudy();
      autoResForStudy();
      renderStudy();
      describeRes();
      if (window.matchMedia('(max-width: 760px)').matches) $('panel').classList.remove('collapsed');
    } else if (m.type === 'error') {
      end();
      info.innerHTML = `<span class="warn">Analyse impossible : ${m.message}</span>`;
    }
  };
  w.onerror = async (e) => {
    end();
    info.innerHTML = `<span class="warn">${await workerFailure(e, "l'analyse du lieu")}</span>`;
  };
  w.postMessage({ x, y, burnDepth: params().burn });
}

function showStudy() {
  const s = state.study;
  if (!s || !state.map) return;
  setGeoJson(state.map, 'catchment', {
    type: 'FeatureCollection',
    features: [
      ...s.cands.flatMap((c) =>
        c.outline.map((ring) => ({
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [ring] },
          properties: { on: c.checked ? 1 : 0 },
        })),
      ),
      ...s.cands
        .filter((c) => c.kind === 'stream')
        .map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c.pointWgs }, properties: { on: c.checked ? 1 : 0 } })),
      { type: 'Feature', geometry: { type: 'Point', coordinates: s.houseWgs }, properties: { house: 1 } },
    ],
  });
  $('catch-fit').disabled = false;
  $('catch-clear').disabled = false;
}

function renderStudy() {
  const s = state.study;
  const list = $('catch-list');
  const info = $('catch-info');
  if (state.catchMode || state.catchWorker) return;
  list.innerHTML = '';
  if (!s) {
    info.textContent = '';
    return;
  }
  s.cands.forEach((c, i) => {
    const v = candidateVerdict(c);
    const li = document.createElement('li');
    const area = `${fmtArea(c.areaKm2)}${c.complete ? '' : ' et plus'}`;
    const where =
      c.kind === 'slope'
        ? `bassin ${area}`
        : `à ${fmtNum(c.dist)} m, lieu ${c.dz >= 0 ? `${fmtNum(c.dz, 1)} m au-dessus du` : `${fmtNum(-c.dz, 1)} m sous le`} lit · bassin ${area}`;
    li.innerHTML = `<label class="check"><input type="checkbox" ${c.checked ? 'checked' : ''} /><span><strong></strong><small></small><em class="${v.level}"></em></span></label>`;
    li.querySelector('strong').textContent = c.name;
    li.querySelector('small').textContent = where;
    li.querySelector('em').textContent = v.text;
    li.querySelector('input').onchange = (e) => {
      s.cands[i].checked = e.target.checked;
      saveStudy();
      showStudy();
      autoResForStudy();
      renderStudy();
      describeRes();
    };
    list.appendChild(li);
  });
  const sel = studyCands();
  if (!s.cands.some((c) => c.kind === 'stream'))
    info.innerHTML = "Aucun cours d'eau à moins de 600 m : seul le ruissellement local menace le lieu.";
  else info.innerHTML = '';
  if (!sel.length) {
    info.innerHTML += ' <span class="warn">Cochez au moins un bassin à simuler.</span>';
    return;
  }
  const f = studyFrame();
  const km2 = sel.reduce((a, c) => a + c.areaKm2, 0);
  info.innerHTML +=
    ` Bassin à simuler : <strong>${fmtArea(km2)}</strong> (contour orange), ` +
    `zone de calcul ${fmtNum((f.xmax - f.xmin) / 1000, 1)} × ${fmtNum((f.ymax - f.ymin) / 1000, 1)} km.`;
  const r = finestResFor(params(), f);
  if (!r)
    info.innerHTML +=
      ' <span class="warn">Trop grand pour cet appareil, même à 50 m : décochez le plus grand bassin.</span>';
}

/** Choisit la maille la plus fine possible pour le lieu étudié. */
function autoResForStudy() {
  if (params().zone !== 'study' || !studyCands().length) return;
  const r = finestResFor(params(), studyFrame());
  if (r) $('res').value = r;
}

function clearStudy() {
  state.catchWorker?.terminate();
  state.catchWorker = null;
  state.study = null;
  saveStudy();
  setGeoJson(state.map, 'catchment', { type: 'FeatureCollection', features: [] });
  $('catch-fit').disabled = true;
  $('catch-clear').disabled = true;
  $('catch-list').innerHTML = '';
  $('catch-info').textContent = '';
  describeRes();
}

/**
 * Résolution la plus fine qui tient sur cet appareil pour une emprise donnée et dont le
 * calcul reste raisonnable (≈ 10 min) ; à défaut, la plus fine qui tient en mémoire.
 */
function finestResFor(p, bbox, budgetS = 600) {
  let fallback = null;
  for (const r of [...STUDY_RESOLUTIONS].sort((a, b) => a - b)) {
    const cells = Math.ceil((bbox.xmax - bbox.xmin) / r) * Math.ceil((bbox.ymax - bbox.ymin) / r);
    const q = { ...p, res: r };
    const engine = chooseEngine(q, cells);
    if (!engine) continue;
    if (estimateSeconds(q, cells, engine) <= budgetS) return r;
    fallback = r;
  }
  return fallback;
}

function fitStudy() {
  const f = studyFrame();
  if (!f) return;
  fitBoundsOf(state.map, [toWgs(f.xmin, f.ymax), toWgs(f.xmax, f.ymax), toWgs(f.xmax, f.ymin), toWgs(f.xmin, f.ymin)]);
}

/* ---------- Coupe en travers ---------- */

function setupSection() {
  $('section-place').onclick = () => {
    state.sectionMode = !state.sectionMode;
    if (state.sectionMode && state.catchMode) setCatchMode(false);
    $('section-place').classList.toggle('on', state.sectionMode);
    if (state.map) state.map.getCanvas().style.cursor = state.sectionMode ? 'crosshair' : '';
    $('section-hint').textContent = state.sectionMode
      ? 'Cliquez sur la carte au centre de la coupe (par exemple dans le lit du vallat).'
      : 'Placez une coupe pour voir l\'eau monter à un endroit précis.';
    if (state.sectionMode && window.matchMedia('(max-width: 760px)').matches) $('panel').classList.add('collapsed');
  };
  $('section-auto').onclick = () => {
    const sec = state.section;
    if (!sec || !state.data) return;
    sec.angle = autoOrientation(state.data.grid || state.run.grid, state.data.z || state.data.dem, sec.cx, sec.cy, sec.width);
    $('sec-angle').value = sec.angle;
    updateSection();
  };
  $('section-clear').onclick = () => {
    state.section = null;
    setGeoJson(state.map, 'section', null);
    setGeoJson(state.map, 'section-hover', null);
    $('section-dock').hidden = true;
    $('section-auto').disabled = true;
    $('section-clear').disabled = true;
  };
  $('sec-angle').addEventListener('input', () => {
    if (!state.section) return;
    state.section.angle = Number($('sec-angle').value);
    updateSection();
  });
  $('sec-width').addEventListener('input', () => {
    if (!state.section) return;
    state.section.width = Number($('sec-width').value);
    updateSection();
  });
  $('dock-close').onclick = () => $('section-clear').click();
  $('dock-min').onclick = () => {
    const min = $('section-dock').classList.toggle('min');
    $('dock-min').textContent = min ? '▴' : '▾';
    if (!min) redrawSection(false);
  };
  $('dock-play').onclick = () => togglePlay();
  $('dock-max').onclick = () => $('view-mode').querySelector('button[data-v="max"]').click();
  $('dock-time').addEventListener('input', () => {
    $('time').value = $('dock-time').value;
    $('time').dispatchEvent(new Event('input'));
  });
  const cv = $('section-canvas');
  const hover = (clientX) => {
    const sec = state.section;
    if (!sec?.helper) return;
    const r = cv.getBoundingClientRect();
    sec.hover = sec.helper.indexAt(clientX - r.left);
    const inf = sec.helper.info(sec.hover);
    const fmtD = (h) => (h < 1 ? `${Math.round(h * 100)} cm` : `${h.toFixed(2).replace('.', ',')} m`);
    $('section-info').innerHTML =
      `À ${Math.round(inf.d)} m de A : sol à <strong>${Number.isFinite(inf.ground) ? inf.ground.toFixed(2).replace('.', ',') : '–'} m</strong>` +
      ` · eau ${inf.depth > 0.01 ? `<strong>${fmtD(inf.depth)}</strong>` : 'aucune'}` +
      (inf.maxDepth > 0.01 ? ` · max ${fmtD(inf.maxDepth)}` : '');
    setGeoJson(state.map, 'section-hover', {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: inf.lngLat }, properties: {} }],
    });
    redrawSection(false);
  };
  cv.addEventListener('mousemove', (e) => hover(e.clientX));
  cv.addEventListener('touchmove', (e) => {
    hover(e.touches[0].clientX);
    e.preventDefault();
  }, { passive: false });
  cv.addEventListener('touchstart', (e) => hover(e.touches[0].clientX), { passive: true });
  cv.addEventListener('mouseleave', () => {
    if (!state.section) return;
    state.section.hover = null;
    setGeoJson(state.map, 'section-hover', null);
    redrawSection(false);
  });
  window.addEventListener('resize', () => redrawSection(false));
}

/** Recopie l'état du curseur de temps principal dans le panneau de coupe. */
function syncDock() {
  if (!$('section-dock') || $('section-dock').hidden) return;
  $('dock-time').max = $('time').max;
  $('dock-time').value = $('time').value;
  const isMax = state.viewMode === 'max';
  $('dock-time-label').textContent = isMax ? 'max' : $('time-label').textContent;
  $('dock-max').classList.toggle('on', isMax);
  $('dock-play').textContent = $('play').textContent;
}

function placeSection(lngLat) {
  state.sectionMode = false;
  $('section-place').classList.remove('on');
  state.map.getCanvas().style.cursor = '';
  const [cx, cy] = toL93(lngLat.lng, lngLat.lat);
  const width = Number($('sec-width').value);
  const first = !state.section;
  state.section = { cx, cy, width, angle: Number($('sec-angle').value), fine: null };
  // Première coupe : orientation automatique en travers du vallon
  if (first && state.data) {
    state.section.angle = autoOrientation(state.run?.grid || state.data.grid, state.data.z || state.data.dem, cx, cy, width);
    $('sec-angle').value = state.section.angle;
  }
  $('section-dock').hidden = false;
  $('section-dock').classList.remove('min');
  syncDock();
  $('section-auto').disabled = false;
  $('section-clear').disabled = false;
  $('section-hint').textContent =
    'La coupe s\'affiche en bas de la carte : réglez son orientation, sa largeur et l\'heure directement dessus.';
  updateSection();
}

let fineTimer = null;
function updateSection() {
  const sec = state.section;
  if (!sec) return;
  $('sec-angle-label').textContent = `${sec.angle}°`;
  $('sec-width-label').textContent = sec.width >= 1000 ? `${(sec.width / 1000).toFixed(2).replace('.', ',')} km` : `${sec.width} m`;
  const { A, B } = sectionEnds(sec.cx, sec.cy, sec.angle, sec.width);
  sec.A = A;
  sec.B = B;
  sec.n = Math.min(1500, Math.max(200, Math.round(sec.width / 0.5)));
  sec.fine = null;
  const a = toWgs(...A);
  const b = toWgs(...B);
  setGeoJson(state.map, 'section', {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [a, b] }, properties: {} },
      { type: 'Feature', geometry: { type: 'Point', coordinates: a }, properties: { end: 'A' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: b }, properties: { end: 'B' } },
    ],
  });
  redrawSection();
  // Profil LiDAR fin, chargé après un court délai (réglages en cours)
  clearTimeout(fineTimer);
  const key = `${A},${B},${sec.n}`;
  sec.key = key;
  fineTimer = setTimeout(async () => {
    try {
      const { z } = await fetchFineProfile(A, B, sec.n);
      if (state.section?.key !== key) return;
      state.section.fine = z;
      redrawSection();
    } catch (e) {
      console.warn('Profil LiDAR fin indisponible', e);
    }
  }, 350);
}

function redrawSection(resample = true) {
  const sec = state.section;
  const run = state.run;
  if (!sec || !run || !state.data || !state.lastQ) return;
  const grid = run.grid;
  const zSim = state.data.z || state.data.dem;
  if (resample || !sec.sample) {
    const q = state.lastQ;
    sec.sample = sampleSection({
      grid,
      zSim,
      A: sec.A,
      B: sec.B,
      n: sec.n,
      depthAt: (k) => dequantize(q[k]),
      maxAt: (k) => (run.maxima ? run.maxima.hmax[k] : 0),
    });
  }
  const timeLabel = state.viewMode === 'max' || state.cursorT == null ? 'Maximum atteint' : `À ${fmtH(state.cursorT)}`;
  sec.helper = drawSection($('section-canvas'), { ...sec.sample, fine: sec.fine, timeLabel, hover: sec.hover, cell: grid.dx });
}

/* ---------- Simulations enregistrées ---------- */

const AMC_LABEL = { 1: 'sol sec', 2: 'sol normal', 3: 'sol saturé' };
const fmtShort = (v) => String(+Number(v).toFixed(2)).replace('.', ',');

// La carte se charge de façon asynchrone : l'ouverture d'une simulation doit l'attendre.
let resolveMapReady;
const mapReady = new Promise((r) => (resolveMapReady = r));

function runName(p, partial, place) {
  const where = place || (p.zone === 'basin' ? 'Haute vallée de l\'Arc' : 'Zone affichée');
  return `${where} · ${fmtShort(p.rainMm)} mm en ${fmtShort(p.rainH)} h · ${AMC_LABEL[p.amc]} · ${p.res} m${partial ? ' (partielle)' : ''}`;
}

/**
 * Nom lisible du lieu simulé : « Haute vallée de l'Arc » pour le bassin entier, sinon le
 * lieu-dit le plus proche du centre (tuiles Plan IGN déjà chargées) et la commune
 * (géocodage inverse IGN, sans numéro de rue).
 */
async function findPlaceName(grid, p) {
  if (p.zone === 'basin') return 'Haute vallée de l\'Arc';
  const study = p.zone === 'study' ? state.study : null;
  const [lon, lat] = study ? study.houseWgs : toWgs(grid.xmin + (grid.nx * grid.dx) / 2, grid.ymax - (grid.ny * grid.dx) / 2);
  // Lieu étudié : nom du principal cours d'eau retenu en tête.
  const stream = study && studyCands().find((c) => c.kind === 'stream' && c.named)?.name;
  const place = await findLocality(grid, lon, lat, !!study);
  return stream ? (place ? `${stream} · ${place}` : stream) : place;
}

async function findLocality(grid, lon, lat, near) {
  const toM = (a, b) => {
    const dx = (a[0] - b[0]) * 111320 * Math.cos((lat * Math.PI) / 180);
    const dy = (a[1] - b[1]) * 110540;
    return Math.hypot(dx, dy);
  };
  // Lieu-dit le plus proche (dans un rayon de la demi-zone, 2 km au plus)
  let locality = null;
  try {
    const radius = near ? 1500 : Math.min(2000, (Math.max(grid.nx, grid.ny) * grid.dx) / 2 + 200);
    let best = Infinity;
    // Poids : une commune proche l'emporte, puis les lieux-dits bien visibles sur la carte
    // (typographie A), puis les petits lieux-dits ; résidences et monuments en dernier recours.
    const weight = (pr) => {
      const symbo = String(pr.symbo || '');
      const typo = String(pr.txt_typo || '');
      if (symbo.startsWith('COMMUNE')) return 0.3;
      if (symbo.startsWith('LIEU-DIT')) return typo.startsWith('TYPO_A') ? 0.5 : 1;
      return 4;
    };
    for (const f of state.map.querySourceFeatures('plan_ign', { sourceLayer: 'toponyme_localite_ponc' })) {
      const name = f.properties?.texte;
      if (!name || f.geometry.type !== 'Point') continue;
      const d = toM(f.geometry.coordinates, [lon, lat]);
      if (d > radius) continue;
      const score = d * weight(f.properties);
      if (score < best) {
        best = score;
        locality = name;
      }
    }
  } catch {
    // tuiles indisponibles : on se contente de la commune
  }
  let city = null;
  try {
    const res = await fetchWithTimeout(
      `https://data.geopf.fr/geocodage/reverse?lon=${lon}&lat=${lat}&index=address&limit=1`,
      6000,
    );
    city = (await res.json()).features?.[0]?.properties?.city || null;
  } catch {
    // hors ligne
  }
  if (locality && city && locality.toLowerCase() !== city.toLowerCase()) return `${locality} (${city})`;
  return locality || city || null;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function autoSave(run, partial) {
  if (run.restored || !run.maxima || !run.store.length) return;
  let note = $('save-note');
  if (!note) {
    note = document.createElement('p');
    note.id = 'save-note';
    $('summary').after(note);
  }
  note.className = 'hint';
  note.textContent = 'Enregistrement de la simulation…';
  try {
    const rec = await packRun({
      name: runName(run.params, partial, await Promise.race([run.placeP, new Promise((r) => setTimeout(() => r(null), 5000))])),
      params: run.params,
      grid: run.grid,
      totalTime: run.totalTime,
      tEnd: run.tEnd ?? run.totalTime,
      store: run.store,
      series: run.series,
      gauges: run.gauges,
      maxima: run.maxima,
      dem: state.data.dem,
      zSim: state.data.z,
      outline: state.data.outline,
      rivers: state.data.rivers,
      summary: $('summary').innerHTML,
      warnings: state.data.warnings,
    });
    await saveRun(rec);
    run.savedId = rec.meta.id;
    note.textContent = `Simulation enregistrée dans ce navigateur (${formatSize(rec.meta.size)}).`;
  } catch (e) {
    console.error(e);
    note.className = 'hint warn';
    note.textContent = `Enregistrement impossible : ${e.message || e}. Supprimez d'anciennes simulations pour libérer de la place.`;
  }
  refreshSaved();
}

async function refreshSaved() {
  const ul = $('saved-list');
  let runs = [];
  try {
    runs = await listRuns();
  } catch {
    ul.innerHTML = '<li class="empty">Stockage indisponible dans ce navigateur (navigation privée ?).</li>';
    return;
  }
  if (!runs.length) {
    ul.innerHTML = '<li class="empty">Aucune simulation enregistrée pour l\'instant.</li>';
    return;
  }
  ul.innerHTML = '';
  for (const r of runs) {
    const li = document.createElement('li');
    if (state.run?.savedId === r.id) li.className = 'current';
    const d = new Date(r.created);
    li.innerHTML = `<div class="s-name"></div>
      <div class="s-meta">${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${formatSize(r.size)}${r.imported ? ' · importée' : ''}</div>
      <div class="s-actions">
        <button class="open">Ouvrir</button><button class="exp">Exporter</button>
        <button class="ren">Renommer</button><button class="del">Supprimer</button>
      </div>`;
    li.querySelector('.s-name').textContent = r.name;
    li.querySelector('.open').onclick = () => openSaved(r.id);
    li.querySelector('.exp').onclick = async () => {
      const blob = await exportRun(r.id);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${r.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase()}.crue`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    };
    li.querySelector('.ren').onclick = async () => {
      const name = prompt('Nouveau nom :', r.name);
      if (name && name.trim()) {
        await renameRun(r.id, name.trim());
        refreshSaved();
      }
    };
    li.querySelector('.del').onclick = async () => {
      if (!confirm(`Supprimer « ${r.name} » ?`)) return;
      await deleteRun(r.id);
      refreshSaved();
    };
    ul.appendChild(li);
  }
}

/** Rouvre une simulation enregistrée sans rien recalculer. */
async function openSaved(id) {
  if (state.run?.running) {
    prog.error('Une simulation est en cours : arrêtez-la avant d\'en ouvrir une autre.');
    return;
  }
  stopPlay();
  prog.start();
  prog.status('Ouverture de la simulation enregistrée…');
  try {
    await mapReady;
    const r = await loadRun(id);
    const { meta } = r;
    const grid = meta.grid;
    // Paramètres de la simulation, pour mémoire
    const p = meta.params;
    $('rain-mm').value = p.rainMm;
    $('rain-h').value = p.rainH;
    $('rain-shape').value = p.shape;
    $('soil').value = p.soil;
    state.amc = p.amc;
    $('amc').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === p.amc));
    $('tail-h').value = p.tailH;
    updateRainInfo();

    state.data = {
      key: `enregistrée:${id}`,
      grid,
      dem: r.dem,
      z: r.z,
      gauges: r.gauges,
      outline: r.outline,
      rivers: r.rivers,
      warnings: r.warnings,
      mask: null,
    };
    showContext(state.data);
    const store = new SnapshotStore();
    store.items = r.snaps.map((s) => ({ t: s.t, data: s.blob }));
    const run = {
      running: false,
      stop: false,
      restored: true,
      savedId: id,
      params: p,
      grid,
      store,
      series: r.series,
      gauges: r.gauges,
      totalTime: meta.totalTime,
      tEnd: meta.tEnd,
      maxima: r.maxima,
      maxQ: quantize(r.maxima.hmax),
      follow: false,
      t0: performance.now(),
    };
    state.run = run;
    run.water = new WaterCanvas(grid.nx, grid.ny);
    setWaterCanvas(state.map, run.water.canvas, gridCornersWgs(grid));
    setLayerVisible('water', document.querySelector('[data-layer=water]').checked);
    state.water3dGrid = null;
    state.lastQ = null;
    if (state.is3d) ensureWater3d();
    fitBoundsOf(state.map, gridCornersWgs(grid));

    $('gauge-legend').innerHTML = '';
    $('results').hidden = false;
    $('time').max = Math.max(0, store.length - 1);
    $('time').value = $('time').max;
    state.viewMode = 'max';
    $('view-mode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'max'));
    $('summary').innerHTML = r.summary || '';
    if ($('save-note')) $('save-note').textContent = `Simulation enregistrée le ${new Date(meta.created).toLocaleString('fr-FR')}.`;
    await renderCurrent();
    drawHydro();
    for (const k of Object.keys(STEPS)) prog.set(k, 1, 'enregistré');
    prog.finish(`Simulation rouverte : ${meta.name}`);
    refreshSaved();
    $('results').scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (e) {
    console.error(e);
    prog.error(`Ouverture impossible : ${e.message || e}`);
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
  // Portable à deux GPU : Chrome sous Windows ignore la préférence « haute performance »
  // et prend souvent la puce intégrée. On explique comment forcer la carte dédiée.
  if (gpu && /intel/i.test(gpu.label) && /win/i.test(navigator.platform || navigator.userAgent)) {
    $('engine-info').innerHTML +=
      '<br><span class="warn">C\'est la puce graphique intégrée Intel.</span> Si l\'ordinateur a aussi une carte ' +
      'NVIDIA ou AMD : Paramètres Windows → Système → Écran → Graphiques → Google Chrome → Options → ' +
      '« Performances élevées », puis redémarrez Chrome (ou activez chrome://flags/#force-high-performance-gpu).';
    const det = document.querySelector('details');
    if (det) det.open = true;
  }
  updateResInfo();
  state.map.on('moveend', () => {
    if (params().zone === 'view') describeRes();
  });
  restoreCatchment();
  state.map.on('click', (e) => {
    if (state.catchMode) studyPlace(e.lngLat.lng, e.lngLat.lat);
    else if (state.sectionMode) placeSection(e.lngLat);
    else probeAt(e.lngLat);
  });
  setupMapTip();
  // Accès à l'état depuis la console du navigateur (diagnostic).
  window.floodApp = state;
  state.water3d = new Water3DLayer();
  state.water3d.setThreshold(state.threshold);
  state.map.addLayer(state.water3d, 'rivers');
  state.ctrl3d = new Toggle3dControl((on) => toggle3d(on));
  state.map.addControl(state.ctrl3d, 'top-right');
  resolveMapReady();
  if (gpu) {
    gpu.device.lost.then((info) => {
      state.gpu = null;
      $('engine-info').textContent = `Le GPU a été perdu (${info.message || info.reason}). Rechargez la page.`;
    });
  }
}

main();
