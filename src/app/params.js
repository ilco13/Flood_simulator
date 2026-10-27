import { buildModel } from '../sim/model.js';
import { drawChart } from '../ui/chart.js';
import { gpuMaxCells } from '../sim/gpuSolver.js';
import { makeGrid } from '../geo.js';
import { makeHyetograph } from '../hydrology/rain.js';
import { meanRunoff, meanRunoffHyeto, runoffMm } from '../hydrology/scs.js';
import { stableDt } from '../sim/scheme.js';
import { avalParams } from './aval.js';
import { nestBox } from './nest.js';
import { episodeParams } from './episode.js';
import { $, CPU_CELL_CAP, GPU_CELL_CAP, STUDY_RESOLUTIONS, fmtNum, state } from './core.js';
import { autoResForStudy, renderStudy, studyCands, studyFrame } from './study.js';

/* ---------- Paramètres saisis ---------- */

export function params() {
  return {
    rainMm: Math.max(0, Number($('rain-mm').value) || 0),
    rainH: Math.max(0.25, Number($('rain-h').value) || 1),
    shape: $('rain-shape').value,
    amc: state.amc,
    soil: soilGroup(),
    soilMode: $('soil').value,
    zone: 'study',
    stopAfterPeak: $('stop-peak').checked,
    res: Number($('res').value),
    tailH: Math.max(0, Number($('tail-h').value) || 0),
    burn: Math.max(0, Number($('burn').value) || 0),
    cnFactor: Math.max(0.1, Number($('cnf').value) || 1),
    capInf: $('cap-inf').checked,
    nest: $('nest-on').checked ? { radius: Number($('nest-r').value), res: Number($('nest-res').value) } : null,
    // Épisode réel chargé : pluie observée heure par heure à la place de la pluie de projet
    ...episodeParams(),
    bdtopo: $('bati-ign').checked,
    ...avalParams(),
    engine: $('engine').value,
  };
}

/** Groupe de sol (1 perméable, 2 moyen, 3 peu perméable) : choisi, ou déduit du lieu. */
export function soilGroup() {
  const v = $('soil').value;
  return v === 'auto' ? (state.study?.soil?.group ?? 2) : Number(v);
}

export function hyetoOf(p) {
  return makeHyetograph({ totalMm: p.rainMm, durationH: p.rainH, shape: p.shape, hourly: p.hourly });
}

/** Grille de calcul : bassins versants retenus autour du lieu étudié. */
export function currentGrid(p) {
  const f = studyFrame(p);
  if (!f || !studyCands().length) return null;
  const snap = (v, fn) => fn(v / p.res) * p.res;
  return makeGrid(
    { xmin: snap(f.xmin, Math.floor), xmax: snap(f.xmax, Math.ceil), ymin: snap(f.ymin, Math.floor), ymax: snap(f.ymax, Math.ceil) },
    p.res,
  );
}

export function chooseEngine(p, cells) {
  const gpuCap = state.gpu ? Math.min(GPU_CELL_CAP, gpuMaxCells(state.gpu.device)) : 0;
  if (p.engine === 'gpu') return state.gpu && cells <= gpuCap ? 'gpu' : null;
  if (p.engine === 'cpu') return cells <= CPU_CELL_CAP ? 'cpu' : null;
  if (state.gpu && cells <= gpuCap) return 'gpu';
  return cells <= CPU_CELL_CAP ? 'cpu' : null;
}

/** Ordre de grandeur du temps de calcul (débits de mailles×pas par seconde mesurés). */
/*
 * Estimation du temps de calcul. Modèle : travail = mailles × durée simulée / pas de temps de
 * référence (eau de 3 m) ; vitesse = « travail » traité par seconde, mesurée sur cet appareil
 * à la fin de chaque simulation (moyenne glissante), avec une valeur de départ prudente.
 * La même formule sert avant le calcul et pendant (temps restant), d'où des chiffres cohérents.
 */
export const SPEED_KEY = 'flood-sim-speed';
export const DEFAULT_SPEED = { gpu: 2e9, cpu: 2.5e7 };

export function speedOf(engine) {
  try {
    const v = JSON.parse(localStorage.getItem(SPEED_KEY) || '{}')[engine];
    if (v > 0) return v;
  } catch {
    /* stockage indisponible */
  }
  return DEFAULT_SPEED[engine];
}

export function learnSpeed(engine, measured) {
  try {
    const all = JSON.parse(localStorage.getItem(SPEED_KEY) || '{}');
    const old = all[engine];
    all[engine] = old > 0 ? Math.exp(0.5 * Math.log(old) + 0.5 * Math.log(measured)) : measured;
    localStorage.setItem(SPEED_KEY, JSON.stringify(all));
  } catch {
    /* rien */
  }
}

export const workOf = (cells, res, simSeconds) => (cells * simSeconds) / stableDt(res, 3);

/** Durée simulée attendue (s) : arrêt après le pic estimé d'après le temps de concentration. */
export function expectedSimSeconds(p) {
  const full = (p.rainH + p.tailH) * 3600;
  if (!p.stopAfterPeak) return full;
  const area = studyCands().reduce((a, c) => a + c.areaKm2, 0) || 1;
  const tcH = Math.max(0.5, 0.6 * area ** 0.4); // temps de concentration approché (h)
  return Math.min(full, (p.rainH + tcH + 1) * 3600);
}

export function estimateSeconds(p, cells, engine) {
  return workOf(cells, p.res, expectedSimSeconds(p)) / speedOf(engine);
}

export const fmtDur = (s) =>
  s < 90 ? `${Math.max(10, Math.round(s / 10) * 10)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`;

export function updateResInfo() {
  const sel = $('res');
  const prev = Number(sel.value);
  sel.innerHTML = '';
  for (const r of STUDY_RESOLUTIONS) {
    const o = document.createElement('option');
    o.value = r;
    o.textContent = `${r} m`;
    sel.appendChild(o);
  }
  sel.value = STUDY_RESOLUTIONS.includes(prev) ? prev : state.gpu ? 5 : 10;
  autoResForStudy();
  describeRes();
}

/** Libellés des mailles avec le temps de calcul estimé, et avertissements. */
export function describeRes() {
  const p = params();
  if (!state.map) return;
  const f = studyFrame();
  const has = f && studyCands().length;
  for (const o of $('res').options) {
    const r = Number(o.value);
    o.disabled = false;
    if (!has) {
      o.textContent = `${r} m`;
      continue;
    }
    const cells = Math.ceil((f.xmax - f.xmin) / r) * Math.ceil((f.ymax - f.ymin) / r);
    const q = { ...p, res: r };
    const engine = chooseEngine(q, cells);
    o.textContent = engine
      ? `${r} m · environ ${fmtDur(estimateSeconds(q, cells, engine))}`
      : `${r} m · trop de mailles pour cet appareil`;
    o.disabled = !engine;
  }
  const grid = currentGrid(p);
  if (!grid) {
    $('res-info').textContent = "Choisissez d'abord le lieu à étudier.";
    renderStudy();
    return;
  }
  const cells = grid.nx * grid.ny;
  const engine = chooseEngine(p, cells);
  let txt = `${fmtNum(cells / 1e6, 1)} M de mailles, calcul ${engine === 'gpu' ? 'sur la carte graphique' : 'sur le processeur'}.`;
  if (!engine) {
    txt = `<span class="warn">${fmtNum(cells / 1e6, 1)} M de mailles : trop pour la mémoire de ${state.gpu ? 'cet appareil' : 'ce navigateur sans carte graphique'}. Choisissez une maille plus grossière.</span>`;
  } else {
    const s = estimateSeconds(p, cells, engine);
    if (s > 900)
      txt +=
        ` <span class="warn">Calcul long : environ ${fmtDur(s)}.</span> Vous pouvez l'arrêter à tout moment, ` +
        'les résultats déjà calculés sont conservés.';
  }
  if (engine && p.nest && state.study) txt += ' ' + describeNest(p, grid, engine);
  $('res-info').innerHTML = txt;
  $('nest-opts').hidden = !p.nest;
  $('res-label').textContent = p.nest ? 'Maille du bassin' : 'Maille de calcul';
  renderStudy();
}

/** Temps estimé du calcul en deux temps (bassin puis zone fine). */
function describeNest(p, g1, engine1) {
  const box = nestBox(g1, state.study.house, p.nest.radius, p.nest.res);
  if (!box || p.nest.res >= g1.dx) return '<span class="warn">Zone fine : choisissez une maille fine plus petite que celle du bassin.</span>';
  const p2 = { ...p, res: p.nest.res };
  const cells2 = box.grid.nx * box.grid.ny;
  const engine2 = chooseEngine(p2, cells2);
  if (!engine2) return `<span class="warn">Zone fine trop grande pour cet appareil à ${p.nest.res} m : réduisez-la ou grossissez sa maille.</span>`;
  const s1 = estimateSeconds(p, g1.nx * g1.ny, engine1);
  const s2 = estimateSeconds(p2, cells2, engine2);
  const km = (box.bbox.xmax - box.bbox.xmin) / 1000;
  return (
    `Calcul en deux temps : bassin à ${g1.dx} m (≈ ${fmtDur(s1)}), puis zone fine ${fmtNum(km, 1)} × ${fmtNum((box.bbox.ymax - box.bbox.ymin) / 1000, 1)} km ` +
    `à ${p.nest.res} m (${fmtNum(cells2 / 1e6, 1)} M de mailles, ≈ ${fmtDur(s2)}) : <strong>≈ ${fmtDur(s1 + s2)}</strong> en tout.`
  );
}

export function updateRainInfo() {
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
      amc: p.amcIdx ?? p.amc,
      rainOnBasinOnly: true,
      cnFactor: p.cnFactor,
      capInfiltration: p.capInf,
    });
    const q0 = meanRunoff(model.S, p.rainMm);
    const q = p.capInf ? meanRunoffHyeto(model.S, model.fc, model.m0, h, p.rainH * 3600) : q0;
    extra = ` Ruissellement moyen attendu sur la zone : <strong>${fmtNum(q)} mm</strong> (${fmtNum((q / Math.max(p.rainMm, 1e-9)) * 100)} % de la pluie)`;
    extra += q - q0 >= 1 ? `, dont ${fmtNum(q - q0)} mm parce que la pluie tombe plus vite que le sol n'absorbe.` : '.';
  } else {
    const S = 25400 / 80 - 254;
    extra = ` Pour un sol type (CN 80), environ ${fmtNum(runoffMm(p.rainMm, S))} mm ruissellent.`;
  }
  $('rain-info').innerHTML = `Pointe : <strong>${fmtNum(h.peakMmH(), 1)} mm/h</strong>.${extra}`;
}
