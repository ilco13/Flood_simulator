import { setTerrain3d } from '../terrain3d.js';
import { $, state } from './core.js';

/* ---------- Vue 3D ---------- */

/** (Re)construit le maillage de la nappe 3D pour la simulation courante. */
export function ensureWater3d() {
  const run = state.run;
  if (!run?.grid || !state.data?.dem || state.water3dGrid === run.grid) return;
  state.water3d.setGrid(run.grid, state.data.dem);
  state.water3dGrid = run.grid;
  if (state.lastQ) state.water3d.setDepth(state.lastQ);
}

export function toggle3d(on) {
  state.is3d = on;
  $('relief3d').checked = on;
  state.ctrl3d.set(on);
  setTerrain3d(state.map, on, Number($('exag').value), state.basemap === 'mns');
  // En 3D, la couche drapée s'efface au profit de la nappe en volume.
  if (state.map.getLayer('water')) state.map.setPaintProperty('water', 'raster-opacity', on ? 0.45 : 1);
  if (on) {
    ensureWater3d();
    if (state.lastQ) state.water3d.setDepth(state.lastQ);
  }
}

/* ---------- Boutons Routes / Cours d'eau / Noms ---------- */

export const TOGGLES_KEY = 'flood-sim-toggles';

export function setupMapToggles() {
  let on = { roads: true, water: true, names: true };
  try {
    on = { ...on, ...JSON.parse(localStorage.getItem(TOGGLES_KEY) || '{}') };
  } catch {
    /* rien */
  }
  state.toggles = on;
  $('map-toggles').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.toggles[b.dataset.g] = !state.toggles[b.dataset.g];
    applyMapToggles();
    try {
      localStorage.setItem(TOGGLES_KEY, JSON.stringify(state.toggles));
    } catch {
      /* rien */
    }
  });
  applyMapToggles();
}

export function applyMapToggles() {
  const map = state.map;
  const g = state.overlayGroups || { roads: [], water: [], names: [] };
  const ids = { roads: g.roads, water: [...g.water, 'rivers'], names: g.names };
  for (const [k, list] of Object.entries(ids))
    for (const id of list) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', state.toggles[k] ? 'visible' : 'none');
  $('map-toggles').querySelectorAll('button').forEach((b) => b.classList.toggle('on', !!state.toggles[b.dataset.g]));
}

/* ---------- Fond de carte : photo ou ombrages LiDAR HD ---------- */

export const BASEMAP_KEY = 'flood-sim-basemap';

export function setupBasemap() {
  let v = 'photo';
  try {
    v = localStorage.getItem(BASEMAP_KEY) || 'photo';
  } catch {
    /* rien */
  }
  $('basemap').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setBasemap(b.dataset.v);
  });
  setBasemap(v);
}

/** photo | mnt (sol nu, relief de la simulation) | mns (avec bâtiments et arbres) */
export function setBasemap(v) {
  if (!['photo', 'mnt', 'mns'].includes(v)) v = 'photo';
  state.basemap = v;
  const map = state.map;
  map.setLayoutProperty('ortho', 'visibility', v === 'photo' ? 'visible' : 'none');
  map.setLayoutProperty('lidar-mnt', 'visibility', v === 'mnt' ? 'visible' : 'none');
  map.setLayoutProperty('lidar-mns', 'visibility', v === 'mns' ? 'visible' : 'none');
  $('basemap').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  // En 3D, le relief suit le fond choisi : sol nu, ou bâtiments et arbres.
  if (state.is3d) setTerrain3d(map, true, Number($('exag').value), v === 'mns');
  try {
    localStorage.setItem(BASEMAP_KEY, v);
  } catch {
    /* rien */
  }
}
