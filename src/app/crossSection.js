import { autoOrientation, drawSection, fetchFineProfile, sampleSection, sectionEnds } from '../ui/section.js';
import { dequantize } from '../sim/snapshots.js';
import maplibregl from 'maplibre-gl';
import { setGeoJson } from '../map.js';
import { toL93, toWgs } from '../geo.js';
import { $, fmtH, state } from './core.js';
import { obstacleRaise } from './obstacles.js';
import { setCatchMode } from './study.js';

/* ---------- Coupe en travers ---------- */

export function setupSection() {
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
    rebaseSection();
    updateSection();
  };
  $('section-clear').onclick = () => {
    state.section = null;
    state.sectionHandle?.remove();
    setGeoJson(state.map, 'section', null);
    setGeoJson(state.map, 'section-hover', null);
    $('section-dock').hidden = true;
    $('results-dock').classList.remove('with-section');
    $('section-auto').disabled = true;
    $('section-clear').disabled = true;
  };
  $('sec-angle').addEventListener('input', () => {
    if (!state.section) return;
    state.section.angle = Number($('sec-angle').value);
    rebaseSection();
    updateSection();
  });
  $('sec-width').addEventListener('input', () => {
    if (!state.section) return;
    state.section.width = Number($('sec-width').value);
    updateSection();
  });
  // Avancer / reculer : translation perpendiculaire à la coupe (le long du cours d'eau),
  // mesurée depuis la dernière position posée ou glissée.
  $('sec-shift').addEventListener('input', () => {
    const sec = state.section;
    if (!sec) return;
    const d = Number($('sec-shift').value);
    const [px, py] = shiftAxis(sec.angle);
    sec.cx = sec.bx + px * d;
    sec.cy = sec.by + py * d;
    updateSection();
  });
  $('dock-close').onclick = () => $('section-clear').click();
  $('dock-min').onclick = () => {
    const min = $('section-dock').classList.toggle('min');
    $('dock-min').textContent = min ? '▴' : '▾';
    if (!min) redrawSection(false);
  };
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
      (inf.obstacle ? ` · <strong>${['', 'bâtiment ajouté', 'mur ajouté', 'bâtiment (IGN)'][inf.obstacle.kind]}</strong> de ${fmtD(inf.obstacle.h)}` : '') +
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
export function syncDock() {
  if (!$('section-dock') || $('section-dock').hidden) return;
  $('dock-time-label').textContent = state.viewMode === 'max' ? 'maximum atteint' : `à ${$('time-label').textContent}`;
}

/** Direction (vecteur unitaire L93) du curseur « avancer / reculer » : perpendiculaire à la coupe. */
export function shiftAxis(angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  return [Math.cos(a), -Math.sin(a)];
}

/** Nouvelle origine du curseur « avancer / reculer » (après un glisser ou une rotation). */
export function rebaseSection() {
  const sec = state.section;
  if (!sec) return;
  sec.bx = sec.cx;
  sec.by = sec.cy;
  $('sec-shift').value = 0;
}

/** Poignée « main » au centre de la coupe : la glisser déplace la coupe sans la modifier. */
export function sectionHandle() {
  if (state.sectionHandle) return state.sectionHandle;
  const el = document.createElement('div');
  el.className = 'section-handle';
  el.title = 'Glisser pour déplacer la coupe';
  el.innerHTML =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8"/>' +
    '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>';
  const m = new maplibregl.Marker({ element: el, draggable: true });
  let raf = 0;
  m.on('drag', () => {
    const sec = state.section;
    if (!sec) return;
    const ll = m.getLngLat();
    [sec.cx, sec.cy] = toL93(ll.lng, ll.lat);
    rebaseSection();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => updateSection({ fromHandle: true }));
  });
  state.sectionHandle = m;
  return m;
}

export function placeSection(lngLat) {
  state.sectionMode = false;
  $('section-place').classList.remove('on');
  state.map.getCanvas().style.cursor = '';
  const [cx, cy] = toL93(lngLat.lng, lngLat.lat);
  const width = Number($('sec-width').value);
  const first = !state.section;
  state.section = { cx, cy, bx: cx, by: cy, width, angle: Number($('sec-angle').value), fine: null };
  $('sec-shift').value = 0;
  // Première coupe : orientation automatique en travers du vallon
  if (first && state.data) {
    state.section.angle = autoOrientation(state.run?.grid || state.data.grid, state.data.z || state.data.dem, cx, cy, width);
    $('sec-angle').value = state.section.angle;
  }
  $('section-dock').hidden = false;
  $('section-dock').classList.remove('min');
  $('results-dock').classList.add('with-section');
  // Sur téléphone, la fenêtre des résultats se réduit à sa barre de temps pour laisser voir la coupe.
  if (window.matchMedia('(max-width: 760px)').matches) {
    $('results-dock').classList.add('min');
    $('res-min').textContent = '▴';
  }
  syncDock();
  $('section-auto').disabled = false;
  $('section-clear').disabled = false;
  $('section-hint').textContent =
    'La coupe s\'affiche en bas de la carte : réglez son orientation, sa largeur et l\'heure directement dessus.';
  updateSection();
}

export let fineTimer = null;
export function updateSection({ fromHandle = false } = {}) {
  const sec = state.section;
  if (!sec) return;
  $('sec-angle-label').textContent = `${sec.angle}°`;
  const shift = Number($('sec-shift').value);
  const [px, py] = shiftAxis(sec.angle);
  const dir = ['le nord', 'le nord-est', "l'est", 'le sud-est', 'le sud', 'le sud-ouest', "l'ouest", 'le nord-ouest'][
    Math.round(((((Math.atan2(px * Math.sign(shift || 1), py * Math.sign(shift || 1)) * 180) / Math.PI) + 360) % 360) / 45) % 8
  ];
  $('sec-shift-label').textContent = shift ? `${Math.abs(shift)} m vers ${dir}` : '0 m';
  if (!fromHandle) sectionHandle().setLngLat(toWgs(sec.cx, sec.cy)).addTo(state.map);
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

export function redrawSection(resample = true) {
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
  const raise = obstacleRaise(sec.sample.pts);
  $('sec-obs').hidden = !raise.kind.some((k) => k > 0);
  sec.helper = drawSection($('section-canvas'), { ...sec.sample, raise, fine: sec.fine, runoff: state.runoff, timeLabel, hover: sec.hover, cell: grid.dx });
}
