import { applyCalibNear } from './episode.js';
import { fitBoundsOf, setGeoJson } from '../map.js';
import { toL93, toWgs } from '../geo.js';
import { avalSettings, mainReceiver, renderAval } from './aval.js';
import { $, STUDY_RESOLUTIONS, fmtArea, fmtNum, state } from './core.js';
import { chooseEngine, describeRes, estimateSeconds, params } from './params.js';
import { fetchRainRef, renderRainRef } from './rainRef.js';
import { workerFailure } from './run.js';
import { fetchSoil, renderSoilInfo } from './soil.js';

/* ---------- Lieu étudié : bassins versants qui peuvent l'atteindre ---------- */

export const STUDY_KEY = 'flood-sim-study';
export const MAX_STUDY_KM2 = 2000; // au-delà, la crue relève d'un modèle fluvial (débit imposé)

/** Dénivelé (m) sous lequel un débordement du cours d'eau peut atteindre le lieu. */
export const reachTolerance = (areaKm2) => 2 + 3 * Math.log10(1 + 10 * areaKm2);

export function candidateVerdict(c) {
  if (c.kind === 'slope') return { level: 'ok', text: 'eau qui ruisselle directement vers le lieu' };
  if (!c.complete || c.areaKm2 > MAX_STUDY_KM2)
    return { level: 'warn', text: 'bassin trop grand pour une simulation dans le navigateur' };
  const tol = reachTolerance(c.areaKm2);
  if (c.dz <= 0.5 * tol) return { level: 'warn', text: 'lieu exposé à un débordement' };
  if (c.dz <= tol) return { level: 'ok', text: 'débordement possible jusqu\'au lieu' };
  return { level: 'muted', text: 'lieu nettement au-dessus du lit : débordement peu probable' };
}


/** Choix par défaut : les cours d'eau dont un débordement peut atteindre le lieu. */
export function defaultChecked(c) {
  if (c.kind === 'slope') return true;
  if (!c.complete || c.areaKm2 > MAX_STUDY_KM2) return false;
  return c.dz <= reachTolerance(c.areaKm2);
}

export const studyCands = () => (state.study?.cands || []).filter((c) => c.checked);

/** Points de suivi du débit au droit du lieu, un par cours d'eau retenu. */
export function studyGauges(p = null) {
  const out = studyCands()
    .filter((c) => c.kind === 'stream')
    .map((c, i) => ({
      id: `study${i}`,
      name: `${c.name} (au droit du lieu)`,
      x: c.point.x,
      y: c.point.y,
      river: c.named ? c.name : null,
      halfWidth: Math.round(Math.min(450, Math.max(40, 40 * Math.sqrt(c.areaKm2)))),
    }));
  // Rivière aval : point de suivi sous la confluence (le vallat et la rivière réunis).
  const r = (p ?? params()).avalFrame ? mainReceiver()?.receiver : null;
  if (r) {
    const ic = nearestIndex(r.reach, r.conf);
    const [x, y] = r.reach[Math.min(r.reach.length - 1, ic + Math.max(2, Math.round((r.reach.length - 1 - ic) / 3)))];
    out.push({
      id: 'aval',
      name: `${r.name || 'Rivière aval'} (sous la confluence)`,
      x,
      y,
      river: r.name,
      halfWidth: Math.round(Math.min(450, Math.max(40, 40 * Math.sqrt(r.areaKm2)))),
    });
  }
  return out;
}

export const nearestIndex = (pts, [x, y]) => {
  let best = 0;
  pts.forEach(([a, b], i) => Math.hypot(a - x, b - y) < Math.hypot(pts[best][0] - x, pts[best][1] - y) && (best = i));
  return best;
};


/** Emprise (Lambert 93) à simuler : bassins retenus + abords du lieu, avec une marge. */
export function studyFrame(p = null) {
  const s = state.study;
  if (!s) return null;
  const b = { xmin: s.house.x - 300, xmax: s.house.x + 300, ymin: s.house.y - 300, ymax: s.house.y + 300 };
  for (const c of studyCands()) {
    b.xmin = Math.min(b.xmin, c.bbox.xmin);
    b.xmax = Math.max(b.xmax, c.bbox.xmax);
    b.ymin = Math.min(b.ymin, c.bbox.ymin);
    b.ymax = Math.max(b.ymax, c.bbox.ymax);
  }
  // Rivière aval : la zone s'étend jusqu'à la confluence et au tronçon de rivière autour.
  const r = (p ?? params()).avalFrame ? mainReceiver()?.receiver : null;
  if (r)
    for (const [x, y] of r.reach) {
      b.xmin = Math.min(b.xmin, x - 150);
      b.xmax = Math.max(b.xmax, x + 150);
      b.ymin = Math.min(b.ymin, y - 150);
      b.ymax = Math.max(b.ymax, y + 150);
    }
  const m = Math.max(150, 0.06 * Math.max(b.xmax - b.xmin, b.ymax - b.ymin));
  return { xmin: b.xmin - m, xmax: b.xmax + m, ymin: b.ymin - m, ymax: b.ymax + m };
}

export function setupCatchment() {
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

export function saveStudy() {
  try {
    if (state.study) localStorage.setItem(STUDY_KEY, JSON.stringify(state.study));
    else localStorage.removeItem(STUDY_KEY);
  } catch {
    /* stockage plein ou interdit */
  }
}

/** Appelé quand la carte est prête. */
export function restoreCatchment() {
  if (state.study) {
    showStudy();
    renderStudy();
    if (!state.study.soil?.group) fetchSoil();
    fetchRainRef(); // résultat en cache après la première fois
  }
  renderSoilInfo();
}

export function setCatchMode(on) {
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
export function studyPlace(lng, lat) {
  setCatchMode(false);
  const [x, y] = toL93(lng, lat);
  state.catchWorker?.terminate();
  const w = new Worker(new URL('../data/catchmentWorker.js', import.meta.url), { type: 'module' });
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
      fetchSoil();
      fetchRainRef();
      applyCalibNear();
      if (window.matchMedia('(max-width: 760px)').matches) $('panel').classList.remove('collapsed');
    } else if (m.type === 'error') {
      end();
      info.innerHTML = `<span class="warn">Analyse impossible : ${m.message}</span> <button type="button" class="ghost" id="catch-retry">Réessayer</button>`;
      $('catch-retry').onclick = () => studyPlace(lng, lat);
    }
  };
  w.onerror = async (e) => {
    end();
    info.innerHTML = `<span class="warn">${await workerFailure(e, "l'analyse du lieu")}</span>`;
  };
  w.postMessage({ x, y, burnDepth: params().burn });
}

export function showStudy() {
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
      ...(() => {
        const r = mainReceiver()?.receiver;
        if (!r?.reachWgs) return [];
        const on = avalSettings().on ? 1 : 0;
        return [
          { type: 'Feature', geometry: { type: 'LineString', coordinates: r.reachWgs }, properties: { aval: 1, on } },
          { type: 'Feature', geometry: { type: 'Point', coordinates: r.srcWgs }, properties: { src: 1, on } },
        ];
      })(),
    ],
  });
  $('catch-fit').disabled = false;
  $('catch-clear').disabled = false;
}

export function renderStudy() {
  const s = state.study;
  if (s) renderAval();
  else $('aval-box').hidden = true;
  const list = $('catch-list');
  const info = $('catch-info');
  $('catch-empty').hidden = !!s || !!state.catchWorker;
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
      renderRainRef();
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
export function autoResForStudy() {
  if (!studyCands().length) return;
  const r = finestResFor(params(), studyFrame());
  if (r) $('res').value = r;
}

export function clearStudy() {
  state.catchWorker?.terminate();
  state.catchWorker = null;
  state.study = null;
  saveStudy();
  setGeoJson(state.map, 'catchment', { type: 'FeatureCollection', features: [] });
  $('catch-fit').disabled = true;
  $('catch-clear').disabled = true;
  $('catch-list').innerHTML = '';
  $('catch-info').textContent = '';
  state.rainWorker?.terminate();
  $('rain-ref').innerHTML = '';
  describeRes();
  renderSoilInfo();
}

/**
 * Résolution la plus fine qui tient sur cet appareil pour une emprise donnée et dont le
 * calcul reste raisonnable (≈ 10 min) ; à défaut, la plus fine qui tient en mémoire.
 */
export function finestResFor(p, bbox, budgetS = 600) {
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

export function fitStudy() {
  const f = studyFrame();
  if (!f) return;
  fitBoundsOf(state.map, [toWgs(f.xmin, f.ymax), toWgs(f.xmax, f.ymax), toWgs(f.xmax, f.ymin), toWgs(f.xmin, f.ymin)]);
}
