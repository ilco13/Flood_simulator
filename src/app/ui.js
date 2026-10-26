import { PALETTES, SCALES, buildLut, flowLegendStops, legendStops } from '../render/water.js';
import { SHAPES } from '../hydrology/rain.js';
import { cacheClear } from '../data/cache.js';
import { importRun } from '../data/runStore.js';
import { setExaggeration } from '../terrain3d.js';
import { setupAval } from './aval.js';
import { setupCompare } from './compareUi.js';
import { $, COLORS_KEY, floodThreshold, fmtNum, state } from './core.js';
import { redrawSection, setupSection } from './crossSection.js';
import { toggle3d } from './mapUi.js';
import { setupObstacles } from './obstacles.js';
import { describeRes, updateRainInfo } from './params.js';
import { prog } from './progress.js';
import { drawHydro, renderArrows, renderCurrent, togglePlay } from './results.js';
import { startRun, stopRun } from './run.js';
import { openSaved, refreshSaved } from './saved.js';
import { setupSearch } from './search.js';
import { renderSoilInfo } from './soil.js';
import { setupCatchment } from './study.js';

/* ---------- Interface ---------- */

export function setupUi() {
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
  $('show-max').onclick = () => {
    setViewMode(state.viewMode === 'max' ? 't' : 'max');
    renderCurrent();
  };
  $('res-min').onclick = () => {
    const min = $('results-dock').classList.toggle('min');
    $('res-min').textContent = min ? '▴' : '▾';
    if (!min) drawHydro();
  };
  $('layer-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.layerMode = b.dataset.v;
    $('layer-mode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    $('runoff-row').hidden = state.layerMode === 'flow';
    if (state.layerMode === 'flow' && state.run && !state.run.store.hasFlow)
      $('summary').insertAdjacentHTML('afterbegin', '<span class="warn">Débit non enregistré pour cette simulation (calculée avant cette version) : relancez-la.</span><br>');
    renderMapLegend();
    renderCurrent();
  });
  $('arrows').addEventListener('change', () => {
    state.arrows = $('arrows').checked;
    renderArrows();
  });
  $('runoff').addEventListener('change', () => {
    state.runoff = $('runoff').checked;
    applyColors();
    $('sec-runoff').hidden = !state.runoff;
    redrawSection(false);
  });
  setupColors();
  $('soil').addEventListener('input', renderSoilInfo);

  for (const id of ['rain-mm', 'rain-h', 'rain-shape', 'soil', 'cnf', 'cap-inf']) $(id).addEventListener('input', updateRainInfo);
  for (const id of ['rain-h', 'tail-h', 'res', 'engine']) $(id).addEventListener('input', describeRes);

  $('run').onclick = () => (state.run?.running ? stopRun() : startRun());
  $('clear-cache').onclick = async () => {
    await cacheClear();
    state.data = null;
    $('clear-cache').textContent = 'Cache vidé';
  };

  $('time').addEventListener('input', () => {
    setViewMode('t');
    if (state.run) state.run.follow = Number($('time').value) === Number($('time').max);
    renderCurrent();
  });
  $('relief3d').addEventListener('change', () => toggle3d($('relief3d').checked));
  $('exag').addEventListener('input', () => {
    $('exag-label').textContent = `×${Number($('exag').value).toFixed(1)}`;
    if (state.is3d) setExaggeration(state.map, Number($('exag').value));
  });
  $('play').onclick = togglePlay;
  setupSection();
  setupCompare();
  setupAval();
  setupCatchment();
  setupSearch();
  setupObstacles();
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

/* ---------- Couleurs de l'eau et légende ---------- */

export function setupColors() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLORS_KEY) || 'null');
    if (PALETTES[saved?.palette]) state.palette = saved.palette;
    if (SCALES[saved?.scale]) state.scale = saved.scale;
  } catch {
    /* stockage indisponible */
  }
  const fill = (id, table, value) => {
    const sel = $(id);
    for (const [k, v] of Object.entries(table)) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = v.label;
      sel.appendChild(o);
    }
    sel.value = value;
  };
  fill('palette', PALETTES, state.palette);
  fill('scale', SCALES, state.scale);
  for (const id of ['palette', 'scale'])
    $(id).addEventListener('input', () => {
      state[id] = $(id).value;
      try {
        localStorage.setItem(COLORS_KEY, JSON.stringify({ palette: state.palette, scale: state.scale }));
      } catch {
        /* rien */
      }
      applyColors();
    });
  applyColors(false);
}

/** Recalcule la table de couleurs, la légende de la carte et le rendu. */
export function applyColors(render = true) {
  state.lut = buildLut({ runoff: state.runoff, palette: state.palette, scale: state.scale });
  state.water3d?.setThreshold(floodThreshold());
  state.water3d?.setColors(legendStops(state.palette, state.scale));
  renderMapLegend();
  if (render) renderCurrent();
}

export const fmtBreak = (d) => (d < 1 ? `${Math.round(d * 100)} cm` : `${String(d).replace('.', ',')} m`);

/** Légende verticale sur le bord droit de la carte : dégradé et hauteurs associées. */
export function renderMapLegend() {
  const el = $('map-legend');
  const flowMode = state.layerMode === 'flow';
  const stops = flowMode ? flowLegendStops() : legendStops(state.palette, state.scale);
  const n = stops.length;
  const rgb = (c) => `rgb(${c.join(',')})`;
  // Du plus profond (en haut) au plus faible (en bas), intervalles de même hauteur.
  let bar = '';
  for (let i = n - 1; i > 0; i--)
    bar += `<span class="ml-seg" style="background:linear-gradient(to bottom, ${rgb(stops[i].rgb)}, ${rgb(stops[i - 1].rgb)})"></span>`;
  const labels = stops
    .slice()
    .reverse()
    .map(
      (s, i) =>
        `<span style="top:${(i / (n - 1)) * 100}%">${i === 0 ? '≥ ' : ''}${flowMode ? fmtNum(s.d, s.d >= 1 ? 0 : Number.isInteger(Math.round(s.d * 1000) / 100) ? 1 : 2) : fmtBreak(s.d)}</span>`,
    )
    .join('');
  el.innerHTML =
    `<div class="ml-title">${flowMode ? 'Débit<br><small>m³/s par m de large</small>' : "Hauteur d'eau"}</div>` +
    `<div class="ml-scale"><div class="ml-bar">${bar}</div><div class="ml-labels">${labels}</div></div>` +
    (state.runoff && !flowMode
      ? `<div class="ml-runoff"><i style="background:${rgb(RUNOFF.color)}"></i>Ruissellement<br>1 cm – ${fmtBreak(stops[0].d)}</div>`
      : '');
}

/** « Heure par heure » (t) ou « maximum atteint » (max). */
export function setViewMode(v) {
  state.viewMode = v;
  $('show-max').classList.toggle('on', v === 'max');
}

/** Fenêtre des résultats : affichée dès qu'une simulation commence ou est rouverte. */
export function showResults(on) {
  $('results-dock').hidden = !on;
  $('map-legend').hidden = !on;
  if (on) drawHydro();
}

export function setLayerVisible(name, on) {
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
