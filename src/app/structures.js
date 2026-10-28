// Ponts et buses sous les routes : repérés à la préparation du relief (remblai court traversé
// par un cours d'eau BD TOPO), dimensions estimées ou saisies, débit et débordement après calcul.

import maplibregl from 'maplibre-gl';
import { toWgs } from '../geo.js';
import { culvertQ, defaultOpening } from '../sim/culvert.js';
import { $, fmtNum, state } from './core.js';
import { escHtml } from './compareUi.js';

const KEY = 'flood-sim-structures';
const EMPTY = { type: 'FeatureCollection', features: [] };

function loadOverrides() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function saveOverrides(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* stockage indisponible : réglage gardé pour cette session seulement */
  }
}

/** Dimensions saisies pour un ouvrage proche (le centre bouge un peu avec la maille). */
function overrideNear(list, x, y, dx) {
  const tol = Math.max(30, 1.5 * dx);
  let best = null;
  let bd = tol;
  for (const o of list) {
    const d = Math.hypot(o.x - x, o.y - y);
    if (d <= bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

/** Maille la plus grossière où un remblai routier est assez bien représenté pour être repéré. */
export const STRUCT_MAX_DX = 10;

/** Ponts et buses demandés et maille assez fine (au-delà, le lit reste creusé sous les routes). */
export const structuresOn = (p, grid) => !!p.structures && grid.dx <= STRUCT_MAX_DX;

/** Part de l'ouverture bouchée (embâcles) : 0 à 1. */
export const obstruction = () => Number($('ouvr-obst')?.value || 0);

/**
 * Ouvrages du calcul : [{ ku, kd, inv, a, b }] (largeur réduite par l'obstruction) et leur
 * description pour l'affichage.
 */
export function buildLinks(data, grid, p) {
  if (!structuresOn(p, grid) || !data.structures?.length) return { links: null, info: [] };
  const list = loadOverrides();
  const pj = state.study?.pj;
  const info = data.structures.map((s) => {
    const def = defaultOpening(s.crest, s.invert, s.areaKm2, pj?.q10 || 80, pj?.q100 || 120);
    const o = overrideNear(list, s.x, s.y, grid.dx);
    const a = o?.a ?? def.a;
    const b = o?.b ?? def.b;
    return { ...s, a, b, user: !!o, qd: def.qd, qcap: culvertQ(s.invert + 1.2 * a, -Infinity, s.invert, a, b) };
  });
  const keep = 1 - Math.min(1, Math.max(0, p.obstruction || 0));
  const links = info.map((s) => ({ ku: s.up, kd: s.down, inv: s.invert, a: s.a, b: s.b * keep }));
  return { links, info };
}

/** État de chaque ouvrage après le calcul : débit maximal, mise en charge, route submergée. */
export function structureResults(run) {
  const info = run.structures;
  if (!info?.length) return [];
  const { hmax, linkQ } = run.maxima;
  const z = state.data.z || state.data.dem;
  return info.map((s, n) => {
    let over = 0;
    for (const k of s.cells) over = Math.max(over, hmax[k]);
    const etaUp = z[s.up] + hmax[s.up];
    const status = over > 0.05 ? 'over' : etaUp >= s.invert + s.a ? 'full' : 'ok';
    return { ...s, qmax: linkQ?.[n] || 0, over, etaUp, status };
  });
}

const LABEL = { over: 'route submergée', full: 'ouvrage en charge', ok: "l'eau passe dessous" };
const COLOR = { over: '#d7191c', full: '#fdae61', ok: '#1a9641', none: '#7b8794' };

/** Ligne du résumé. */
export function structuresSummary(run) {
  const res = run.structureRes;
  if (!res?.length) return '';
  const n = (st) => res.filter((r) => r.status === st).length;
  const obst = run.params.obstruction ? ` (ouvertures bouchées à ${fmtNum(run.params.obstruction * 100)} %)` : '';
  return (
    `<br>Ponts et buses sous les routes : ${res.length} repérés${obst} ; ` +
    `<strong>${n('over')}</strong> avec la route submergée, ${n('full')} en charge, ${n('ok')} sans débordement. ` +
    `Touchez un repère sur la carte pour voir ou corriger ses dimensions.`
  );
}

/* ---------- Carte ---------- */

function features(list) {
  return {
    type: 'FeatureCollection',
    features: list.map((s, n) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: toWgs(s.x, s.y) },
      properties: { n, color: COLOR[s.status || 'none'] },
    })),
  };
}

function ensureLayer() {
  const map = state.map;
  if (!map || map.getSource('structures')) return;
  map.addSource('structures', { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'structures',
    type: 'circle',
    source: 'structures',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 16, 7],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  });
}

/** Affiche les ouvrages (avec leur état si le calcul est fini). */
export function showStructures(list) {
  if (!state.map) return;
  ensureLayer();
  state.structuresShown = list || [];
  state.map.getSource('structures')?.setData(list?.length ? features(list) : EMPTY);
}

/** Clic sur un repère : fiche de l'ouvrage, avec ses dimensions modifiables. */
export function structureClick(e) {
  const map = state.map;
  if (!map?.getLayer('structures')) return false;
  const f = map.queryRenderedFeatures(e.point, { layers: ['structures'] })[0];
  const s = f && state.structuresShown?.[f.properties.n];
  if (!s) return false;
  const res = s.status
    ? `<br><strong>${LABEL[s.status]}</strong> ; débit maximal dans l'ouvrage ${fmtNum(s.qmax, 1)} m³/s` +
      (s.status === 'over' ? ` ; jusqu'à ${fmtNum(s.over * 100)} cm d'eau sur la route` : '')
    : '';
  const html =
    `<div class="struct-pop"><strong>Pont ou buse</strong>${s.name ? ` — ${escHtml(s.name)}` : ''}<br>` +
    `Remblai ${fmtNum(s.crest - s.invert, 1)} m au-dessus du lit ; bassin ${fmtNum(s.areaKm2 || 0, 2)} km²<br>` +
    `Capacité ≈ ${fmtNum(s.qcap, 1)} m³/s (crue centennale estimée ${fmtNum(s.qd, 1)} m³/s)${res}` +
    `<div class="struct-dims"><label>Largeur <input id="st-b" type="number" min="0" step="0.1" value="${s.b}"> m</label>` +
    `<label>Hauteur <input id="st-a" type="number" min="0.1" step="0.1" value="${s.a}"> m</label></div>` +
    `<div class="btn-row"><button id="st-save" type="button">Enregistrer</button>` +
    (s.user ? `<button id="st-reset" class="ghost" type="button">Estimation</button>` : '') +
    `</div><p class="hint">${s.user ? 'Dimensions saisies.' : 'Dimensions estimées.'} Prises en compte au prochain calcul.</p></div>`;
  const pop = new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(f.geometry.coordinates).setHTML(html).addTo(map);
  const el = pop.getElement();
  const update = (o) => {
    const list = loadOverrides().filter((x) => Math.hypot(x.x - s.x, x.y - s.y) > Math.max(30, 1.5 * (state.data?.grid?.dx || 10)));
    if (o) list.push(o);
    saveOverrides(list);
    pop.remove();
  };
  el.querySelector('#st-save').onclick = () => {
    const b = Math.max(0, Number(el.querySelector('#st-b').value) || 0);
    const a = Math.max(0.1, Number(el.querySelector('#st-a').value) || 0.1);
    update({ x: Math.round(s.x), y: Math.round(s.y), a, b });
  };
  const r = el.querySelector('#st-reset');
  if (r) r.onclick = () => update(null);
  return true;
}
