import { cellOf, toL93, toWgs } from '../geo.js';
import { dequantize } from '../sim/snapshots.js';
import { dequantizeFlow } from '../sim/flux.js';
import { drawChart } from '../ui/chart.js';
import { refreshWater, setGeoJson } from '../map.js';
import { endDiff } from './compareUi.js';
import { $, GAUGE_COLORS, floodThreshold, fmtDepth, fmtH, fmtNum, state } from './core.js';
import { redrawSection, syncDock } from './crossSection.js';
import { ensureWater3d } from './mapUi.js';
import { setViewMode } from './ui.js';

/* ---------- Affichage ---------- */

export function drawQuantized(q, t, flow = null) {
  const run = state.run;
  if (!run?.water) return;
  state.lastFlow = flow;
  // Couleur : hauteur d'eau, ou débit (viridis) si demandé et disponible
  if (state.layerMode === 'flow' && flow) run.water.draw(flow.qf, state.flowLut);
  else run.water.draw(q, state.lut);
  refreshWater(state.map);
  renderArrows();
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

export async function renderCurrent() {
  const run = state.run;
  if (!run?.water) return;
  if (state.diff) endDiff();
  if (state.viewMode === 'max') {
    if (run.maxQ) drawQuantized(run.maxQ, null, await flowMaxOf(run));
    return;
  }
  const idx = Number($('time').value);
  if (!run.store.length) return;
  const q = await run.store.get(idx);
  drawQuantized(q, run.store.timeOf(idx), await run.store.getFlow(idx));
}

/* ---------- Débit : maximum, flèches ---------- */

/** Maximum du débit au fil des instantanés (par maille, et flèche la plus forte par bloc). */
export function accumulateFlowMax(run, flow) {
  if (!run.flowMax) {
    run.flowMax = {
      qf: new Uint8Array(flow.qf.length),
      vec: { ...flow.vec, fx: new Float32Array(flow.vec.fx.length), fy: new Float32Array(flow.vec.fy.length) },
    };
  }
  const m = run.flowMax;
  if (flow.ang && !m.ang) m.ang = new Uint8Array(flow.qf.length);
  for (let k = 0; k < flow.qf.length; k++)
    if (flow.qf[k] > m.qf[k]) {
      m.qf[k] = flow.qf[k];
      if (m.ang && flow.ang) m.ang[k] = flow.ang[k];
    }
  run.flowRef = null; // échelle des flèches à recalculer
  const { fx, fy } = flow.vec;
  for (let b = 0; b < fx.length; b++)
    if (fx[b] * fx[b] + fy[b] * fy[b] > m.vec.fx[b] * m.vec.fx[b] + m.vec.fy[b] * m.vec.fy[b]) {
      m.vec.fx[b] = fx[b];
      m.vec.fy[b] = fy[b];
    }
}

/** Débit maximal (calculé à la demande pour une simulation rouverte). */
export async function flowMaxOf(run) {
  if (run.flowMax || run.flowMaxDone) return run.flowMax || null;
  run.flowMaxDone = true;
  if (!run.store.hasFlow) return null;
  for (let i = 0; i < run.store.length; i++) {
    const f = await run.store.getFlow(i);
    if (f) accumulateFlowMax(run, f);
  }
  return run.flowMax || null;
}

export function addArrowLayer() {
  const map = state.map;
  map.addSource('flow-arrows', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const before = map.getLayer('catchment-fill') ? 'catchment-fill' : undefined;
  // Flèches fines : trait blanc cerné de sombre, lisible sur la photo comme sur les couleurs.
  map.addLayer(
    {
      id: 'flow-arrows-casing',
      type: 'line',
      source: 'flow-arrows',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': 'rgba(8, 22, 40, 0.7)', 'line-width': 3.2 },
    },
    before,
  );
  map.addLayer(
    {
      id: 'flow-arrows',
      type: 'line',
      source: 'flow-arrows',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 1.4 },
    },
    before,
  );
  let timer = null;
  map.on('moveend', () => {
    clearTimeout(timer);
    timer = setTimeout(renderArrows, 120);
  });
}

export const ARROW_SPACING = 22; // px entre deux flèches
export const ARROW_MIN_FLOW = 0.05; // m³/s par m de large : en dessous, pas de flèche (hors du lit)

/** Débit de référence de la simulation (forts débits du maximum) : échelle fixe des longueurs. */
export function flowReference(run, flow) {
  if (run.flowRef) return run.flowRef;
  const src = run.flowMax?.qf || flow.qf;
  const vals = [];
  for (let k = 0; k < src.length; k++) if (src[k]) vals.push(src[k]);
  vals.sort((a, b) => a - b);
  const v = vals.length ? dequantizeFlow(vals[Math.floor(vals.length * 0.98)]) : 1;
  run.flowRef = Math.max(0.2, v);
  return run.flowRef;
}

/**
 * Flèches du courant : une tous les ~22 px, posée sur la maille de plus fort débit de chaque
 * case (donc dans le lit), orientée selon le courant de cette maille ; longueur de 5 à 26 px
 * selon le débit (racine carrée, échelle fixe pour toute la simulation).
 */
export function renderArrows() {
  const map = state.map;
  const src = map?.getSource('flow-arrows');
  if (!src) return;
  const run = state.run;
  const flow = state.lastFlow;
  if (!state.arrows || !flow || !run?.grid) return src.setData({ type: 'FeatureCollection', features: [] });
  const g = run.grid;
  const { nx, ny, dx } = g;
  const lat = map.getCenter().lat;
  const mpp = (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
  const w = Math.max(1, Math.round((ARROW_SPACING * mpp) / dx));
  // Partie visible de la grille
  const b = map.getBounds();
  const corners = [b.getSouthWest(), b.getNorthEast(), b.getNorthWest(), b.getSouthEast()].map((ll) => toL93(ll.lng, ll.lat));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const i0 = Math.max(0, Math.floor((Math.min(...xs) - g.xmin) / dx / w) * w);
  const i1 = Math.min(nx, Math.ceil((Math.max(...xs) - g.xmin) / dx));
  const j0 = Math.max(0, Math.floor((g.ymax - Math.max(...ys)) / dx / w) * w);
  const j1 = Math.min(ny, Math.ceil((g.ymax - Math.min(...ys)) / dx));
  const qmin = ARROW_MIN_FLOW;
  const ref = flowReference(run, flow);
  const vec = flow.vec;
  const feats = [];
  for (let wj = j0; wj < j1; wj += w)
    for (let wi = i0; wi < i1; wi += w) {
      let best = -1;
      let bq = 0;
      for (let j = wj; j < Math.min(wj + w, ny); j++)
        for (let i = wi; i < Math.min(wi + w, nx); i++) {
          const v = flow.qf[j * nx + i];
          if (v > bq) {
            bq = v;
            best = j * nx + i;
          }
        }
      if (best < 0) continue;
      const q = dequantizeFlow(bq);
      if (q < qmin) continue;
      const ci = best % nx;
      const cj = (best - ci) / nx;
      // Direction : celle de la maille (est, sud), sinon la moyenne de son bloc
      let ux;
      let uy;
      if (flow.ang) {
        const th = (flow.ang[best] / 256) * 2 * Math.PI;
        ux = Math.cos(th);
        uy = Math.sin(th);
      } else {
        const bk = Math.floor(cj / vec.B) * vec.bx + Math.floor(ci / vec.B);
        const m = Math.hypot(vec.fx[bk], vec.fy[bk]) || 1;
        ux = vec.fx[bk] / m;
        uy = vec.fy[bk] / m;
      }
      const ex = ux; // vers l'est
      const ey = -uy; // vers le nord
      const Lpx = Math.min(26, 5 + 21 * Math.sqrt(Math.min(1, q / ref)));
      const L = Lpx * mpp;
      const hl = Math.min(5 * mpp, 0.4 * L);
      const cx = g.xmin + (ci + 0.5) * dx;
      const cy = g.ymax - (cj + 0.5) * dx;
      const tail = [cx - (ex * L) / 2, cy - (ey * L) / 2];
      const tip = [cx + (ex * L) / 2, cy + (ey * L) / 2];
      const back = (a) => [tip[0] - hl * (ex * Math.cos(a) - ey * Math.sin(a)), tip[1] - hl * (ey * Math.cos(a) + ex * Math.sin(a))];
      feats.push({
        type: 'Feature',
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [toWgs(...tail), toWgs(...tip)],
            [toWgs(...back(0.5)), toWgs(...tip), toWgs(...back(-0.5))],
          ],
        },
        properties: {},
      });
    }
  src.setData({ type: 'FeatureCollection', features: feats });
}

export let hydroTimer = null;
export function drawHydroThrottled() {
  if (hydroTimer) return;
  hydroTimer = setTimeout(() => {
    hydroTimer = null;
    drawHydro();
  }, 500);
}

export function drawHydro() {
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

export let playTimer = null;
export function togglePlay() {
  if (playTimer) return stopPlay();
  const run = state.run;
  if (!run?.store.length) return;
  setViewMode('t');
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
export function stopPlay() {
  clearInterval(playTimer);
  playTimer = null;
  $('play').textContent = '▶';
  syncDock();
}

/* ---------- Sonde (clic sur la carte) ---------- */

export async function probeAt(lngLat) {
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

export function setupMapTip() {
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
    const thr = state.runoff ? 0.01 : floodThreshold();
    if (h < thr && hm < thr) return (tip.hidden = true);
    const when = state.viewMode === 'max' ? 'maximum atteint' : `à ${$('time-label').textContent}`;
    let html = h >= 0.01 ? `<b>${fmtD(h)}</b> d'eau ${when}` : `Pas d'eau ${when}`;
    if (run.maxima && state.viewMode !== 'max' && hm >= 0.01) html += `<br>max ${fmtD(hm)} à ${fmtH(run.maxima.tmax[c.k])}`;
    else if (run.maxima && state.viewMode === 'max' && hm >= 0.01) html += `<br>atteint à ${fmtH(run.maxima.tmax[c.k])}`;
    const f = state.lastFlow;
    if (f && f.qf[c.k]) html += `<br>débit ${fmtNum(dequantizeFlow(f.qf[c.k]), 2)} m³/s par mètre de large`;
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
