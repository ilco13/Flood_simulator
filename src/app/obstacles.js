import { cellOf, toL93 } from '../geo.js';
import { fitBoundsOf, setGeoJson } from '../map.js';
import { $, state } from './core.js';
import { redrawSection } from './crossSection.js';
import { setCatchMode } from './study.js';

/* ---------- Ouvrages dessinés (bâtiments, murs absents du relief) ---------- */

export const OBS_KEY = 'flood-sim-obstacles';
export const OBS_DEFAULT_H = { building: 6, wall: 1.5 };
export const OBS_LABEL = { building: 'Bâtiment', wall: 'Mur' };

export function setupObstacles() {
  try {
    const saved = JSON.parse(localStorage.getItem(OBS_KEY) || '[]');
    state.obstacles = Array.isArray(saved) ? saved.filter((o) => o?.coords?.length) : [];
  } catch {
    state.obstacles = [];
  }
  $('obs-building').onclick = () => startDrawing('building');
  $('obs-wall').onclick = () => startDrawing('wall');
  $('draw-finish').onclick = finishDrawing;
  $('draw-cancel').onclick = () => stopDrawing();
  $('draw-undo').onclick = () => {
    state.drawing?.pts.pop();
    renderDraw();
  };
  renderObstacles();
}

export function saveObstacles() {
  try {
    localStorage.setItem(OBS_KEY, JSON.stringify(state.obstacles));
  } catch {
    /* stockage plein ou interdit */
  }
}

/** Ouvrages en Lambert 93, pour le calcul. */
export function obstaclesL93() {
  return (state.obstacles || []).map((o) => ({
    type: o.type,
    h: o.h,
    pts: o.coords.map(([lon, lat]) => toL93(lon, lat).map((v) => Math.round(v * 10) / 10)),
  }));
}

export function startDrawing(type) {
  if (state.catchMode) setCatchMode(false);
  if (state.sectionMode) $('section-place').click();
  state.drawing = { type, pts: [], cursor: null };
  state.map.doubleClickZoom.disable();
  state.map.getCanvas().style.cursor = 'crosshair';
  $('draw-bar').hidden = false;
  if (window.matchMedia('(max-width: 760px)').matches) $('panel').classList.add('collapsed');
  renderDraw();
}

export function stopDrawing() {
  state.drawing = null;
  state.map.getCanvas().style.cursor = '';
  $('draw-bar').hidden = true;
  setGeoJson(state.map, 'draw', null);
  setTimeout(() => state.map.doubleClickZoom.enable(), 300);
}

export function addDrawPoint(e) {
  const d = state.drawing;
  const ll = [e.lngLat.lng, e.lngLat.lat];
  // Le double-clic produit aussi deux clics : on ignore un point posé au même endroit.
  const last = d.pts[d.pts.length - 1];
  if (last) {
    const a = state.map.project(last);
    if (Math.hypot(a.x - e.point.x, a.y - e.point.y) < 6) return;
  }
  d.pts.push(ll);
  renderDraw();
}

export function finishDrawing() {
  const d = state.drawing;
  if (!d) return;
  const need = d.type === 'building' ? 3 : 2;
  if (d.pts.length < need) {
    $('draw-hint').textContent = `Il faut au moins ${need} points.`;
    return;
  }
  const n = state.obstacles.filter((o) => o.type === d.type).length + 1;
  state.obstacles.push({ id: Date.now(), type: d.type, name: `${OBS_LABEL[d.type]} ${n}`, h: OBS_DEFAULT_H[d.type], coords: d.pts });
  saveObstacles();
  stopDrawing();
  renderObstacles();
}

export function renderDraw() {
  const d = state.drawing;
  if (!d) return;
  const pts = d.cursor ? [...d.pts, d.cursor] : d.pts;
  const feats = d.pts.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} }));
  if (pts.length >= 2) {
    const line = d.type === 'building' && pts.length >= 3 ? [...pts, pts[0]] : pts;
    feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} });
    if (d.type === 'building' && pts.length >= 3)
      feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] }, properties: {} });
  }
  setGeoJson(state.map, 'draw', { type: 'FeatureCollection', features: feats });
  const touch = window.matchMedia('(pointer: coarse)').matches;
  $('draw-hint').textContent =
    d.type === 'building'
      ? `Bâtiment : ${touch ? 'touchez' : 'cliquez'} ses angles (${d.pts.length} posé${d.pts.length > 1 ? 's' : ''})${touch ? '' : ', double-clic pour finir'}.`
      : `Mur : ${touch ? 'touchez' : 'cliquez'} ses points (${d.pts.length} posé${d.pts.length > 1 ? 's' : ''})${touch ? '' : ', double-clic pour finir'}.`;
}

export function renderObstacles() {
  const obs = state.obstacles || [];
  if (state.map) setGeoJson(state.map, 'obstacles', {
    type: 'FeatureCollection',
    features: obs.map((o) => ({
      type: 'Feature',
      geometry:
        o.type === 'building'
          ? { type: 'Polygon', coordinates: [[...o.coords, o.coords[0]]] }
          : { type: 'LineString', coordinates: o.coords },
      properties: { id: o.id },
    })),
  });
  const list = $('obs-list');
  list.innerHTML = '';
  for (const o of obs) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="obs-name"></span>` +
      `<label class="obs-h">hauteur <input type="number" min="0.2" max="30" step="0.1" inputmode="decimal" /> m</label>` +
      `<button type="button" class="icon-ghost" title="Voir sur la carte">◎</button>` +
      `<button type="button" class="icon-ghost" title="Supprimer">✕</button>`;
    li.querySelector('.obs-name').textContent = o.name;
    const inp = li.querySelector('input');
    inp.value = o.h;
    inp.onchange = () => {
      o.h = Math.max(0.2, Math.min(30, Number(inp.value) || OBS_DEFAULT_H[o.type]));
      inp.value = o.h;
      saveObstacles();
      redrawSection();
    };
    const [view, del] = li.querySelectorAll('button');
    view.onclick = () => fitBoundsOf(state.map, o.coords);
    del.onclick = () => {
      state.obstacles = state.obstacles.filter((x) => x !== o);
      saveObstacles();
      renderObstacles();
    };
    list.appendChild(li);
  }
  if (state.section) redrawSection();
}

/** Surélévation (m) due aux ouvrages le long de la coupe (terrain LiDAR fin + ouvrages). */
export function obstacleRaise(pts) {
  const obs = obstaclesL93();
  const out = new Float32Array(pts.length);
  // Type d'ouvrage par point : 1 bâtiment, 2 mur (pour le dessin de la coupe)
  out.kind = new Uint8Array(pts.length);
  const inPoly = (P, x, y) => {
    let c = false;
    for (let a = 0, b = P.length - 1; a < P.length; b = a++) {
      const [xa, ya] = P[a];
      const [xb, yb] = P[b];
      if ((ya > y) !== (yb > y) && x < xa + ((y - ya) * (xb - xa)) / (yb - ya)) c = !c;
    }
    return c;
  };
  const distSeg = (x, y, [x0, y0], [x1, y1]) => {
    const vx = x1 - x0;
    const vy = y1 - y0;
    const L2 = vx * vx + vy * vy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / L2)) : 0;
    return Math.hypot(x0 + t * vx - x, y0 + t * vy - y);
  };
  const step = pts.length > 1 ? Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) : 0.5;
  for (let i = 0; i < pts.length; i++) {
    const { x, y } = pts[i];
    for (const o of obs) {
      let hit = false;
      if (o.type === 'building') hit = inPoly(o.pts, x, y);
      else for (let s = 0; s < o.pts.length - 1 && !hit; s++) hit = distSeg(x, y, o.pts[s], o.pts[s + 1]) <= Math.max(0.3, step / 2);
      if (hit && o.h >= out[i]) {
        out[i] = o.h;
        out.kind[i] = o.type === 'building' ? 1 : 2;
      }
    }
  }
  // Bâtiments IGN : mailles relevées dans la simulation (hauteur = relief simulé − MNT)
  const d = state.data;
  const g = state.run?.grid;
  if (d?.bldFrac && d.z && g)
    for (let i = 0; i < pts.length; i++) {
      if (out.kind[i]) continue;
      const c = cellOf(g, pts[i].x, pts[i].y);
      if (c && d.bldFrac[c.k] === 1) {
        out[i] = Math.max(0, d.z[c.k] - d.dem[c.k]);
        out.kind[i] = 3;
      }
    }
  return out;
}
