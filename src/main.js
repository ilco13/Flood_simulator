import { Toggle3dControl } from './terrain3d.js';
import { Water3DLayer } from './render/water3d.js';
import { createMap } from './map.js';
import { getGpuDevice } from './sim/gpuSolver.js';
import { legendStops } from './render/water.js';
import { $, floodThreshold, state } from './app/core.js';
import { placeSection } from './app/crossSection.js';
import { setupBasemap, setupMapToggles, toggle3d } from './app/mapUi.js';
import { addDrawPoint, finishDrawing, renderDraw, renderObstacles } from './app/obstacles.js';
import { updateRainInfo, updateResInfo } from './app/params.js';
import { addArrowLayer, probeAt, setupMapTip } from './app/results.js';
import { resolveMapReady } from './app/saved.js';
import { restoreCatchment, studyPlace } from './app/study.js';
import { setupUi } from './app/ui.js';

/* ---------- Démarrage ---------- */

async function main() {
  setupUi();
  updateRainInfo();
  const [map, gpu] = await Promise.all([createMap($('map')), getGpuDevice()]);
  state.map = map.map;
  state.overlayIds = map.overlayIds;
  state.overlayGroups = map.overlayGroups;
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
  restoreCatchment();
  // Pendant qu'on déplace / zoome la carte, le calcul GPU cède la main entre de petits lots.
  let idleTimer = null;
  state.map.on('movestart', () => {
    clearTimeout(idleTimer);
    if (state.run?.solver) state.run.solver.interactive = true;
  });
  state.map.on('moveend', () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (state.run?.solver) state.run.solver.interactive = false;
    }, 400);
  });
  state.map.on('click', (e) => {
    if (state.drawing) return addDrawPoint(e);
    if (state.catchMode) studyPlace(e.lngLat.lng, e.lngLat.lat);
    else if (state.sectionMode) placeSection(e.lngLat);
    else probeAt(e.lngLat);
  });
  setupMapTip();
  state.map.on('mousemove', (e) => {
    if (!state.drawing) return;
    state.drawing.cursor = [e.lngLat.lng, e.lngLat.lat];
    renderDraw();
  });
  state.map.on('dblclick', (e) => {
    if (!state.drawing) return;
    e.preventDefault();
    finishDrawing();
  });
  renderObstacles(); // la carte est prête : affiche les ouvrages enregistrés
  setupBasemap();
  setupMapToggles();
  addArrowLayer();
  // Accès à l'état depuis la console du navigateur (diagnostic).
  window.floodApp = state;
  state.water3d = new Water3DLayer();
  state.water3d.setThreshold(floodThreshold());
  state.water3d.setColors(legendStops(state.palette, state.scale));
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
