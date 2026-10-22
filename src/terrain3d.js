// Relief 3D : tuiles d'altitude LiDAR HD (IGN) converties à la volée au format « terrarium »
// attendu par MapLibre. Aucun serveur de tuiles n'est nécessaire.

import maplibregl from 'maplibre-gl';
import { WMS_R, LAYERS } from './config.js';
import { fetchWithRetry } from './data/wms.js';

const HALF = 20037508.342789244;
const TILE = 256;
export const DEM_SOURCE = 'lidar-dem';
export const DSM_SOURCE = 'lidar-dsm'; // modèle de surface : bâtiments et arbres en relief

function tileBbox(z, x, y) {
  const size = (2 * HALF) / 2 ** z;
  return { xmin: -HALF + x * size, xmax: -HALF + (x + 1) * size, ymax: HALF - y * size, ymin: HALF - (y + 1) * size };
}

function wmsUrl(layer, b) {
  const p = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: layer,
    STYLES: '',
    CRS: 'EPSG:3857',
    BBOX: `${b.xmin},${b.ymin},${b.xmax},${b.ymax}`,
    WIDTH: String(TILE),
    HEIGHT: String(TILE),
    FORMAT: 'image/x-bil;bits=32',
  });
  return `${WMS_R}?${p}`;
}

async function loadElevation(z, x, y, signal, surface = false) {
  const b = tileBbox(z, x, y);
  let data = null;
  try {
    data = new Float32Array(await fetchWithRetry(wmsUrl(surface ? LAYERS.dsm : LAYERS.dem, b), { tries: 3, signal }));
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  let holes = !data;
  if (data) for (let k = 0; k < data.length && !holes; k++) if (!(data[k] > -1000)) holes = true;
  if (holes) {
    try {
      const fb = new Float32Array(await fetchWithRetry(wmsUrl(surface ? LAYERS.dem : LAYERS.demFallback, b), { tries: 2, signal }));
      if (!data) data = fb;
      else for (let k = 0; k < data.length; k++) if (!(data[k] > -1000)) data[k] = fb[k];
    } catch (e) {
      if (signal?.aborted) throw e;
      if (!data) data = new Float32Array(TILE * TILE);
    }
  }
  return data;
}

/** Encodage terrarium : h = R·256 + G + B/256 − 32768. */
async function encodeTerrarium(h) {
  const img = new ImageData(TILE, TILE);
  const px = img.data;
  for (let k = 0; k < h.length; k++) {
    const e = h[k] > -1000 ? h[k] : 0;
    const v = e + 32768;
    const r = Math.floor(v / 256);
    const g = Math.floor(v) - r * 256;
    const bl = Math.floor((v - Math.floor(v)) * 256);
    px[4 * k] = r;
    px[4 * k + 1] = g;
    px[4 * k + 2] = bl;
    px[4 * k + 3] = 255;
  }
  const cv = new OffscreenCanvas(TILE, TILE);
  cv.getContext('2d').putImageData(img, 0, 0);
  const blob = await cv.convertToBlob({ type: 'image/png' });
  return blob.arrayBuffer();
}

let registered = false;
export function registerLidarProtocol() {
  if (registered) return;
  registered = true;
  maplibregl.addProtocol('lidar', async (params, abortController) => {
    const m = /lidar:\/\/(?:(mns)\/)?(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    const [z, x, y] = m.slice(2).map(Number);
    const h = await loadElevation(z, x, y, abortController.signal, m[1] === 'mns');
    return { data: await encodeTerrarium(h) };
  });
}

/** Ajoute la source d'altitude (une seule fois). */
export function addDemSource(map) {
  registerLidarProtocol();
  if (map.getSource(DEM_SOURCE)) return;
  for (const [id, url] of [[DEM_SOURCE, 'lidar://{z}/{x}/{y}'], [DSM_SOURCE, 'lidar://mns/{z}/{x}/{y}']])
    map.addSource(id, {
      type: 'raster-dem',
      tiles: [url],
      tileSize: TILE,
      encoding: 'terrarium',
      minzoom: 8,
      maxzoom: 16,
      attribution: '© IGN – LiDAR HD',
    });
}

/**
 * Recale l'altitude du centre de la vue sur le relief. MapLibre la fige pendant les animations :
 * si les tuiles d'altitude arrivent à ce moment-là, elle reste à 0 m et la caméra peut passer
 * sous le sol une fois la vue inclinée.
 */
function clampCenterToGround(map) {
  if (!map.getTerrain()) return;
  const e = map.queryTerrainElevation(map.getCenter());
  const cur = map.transform?.elevation ?? 0;
  if (e != null && Math.abs(cur - e) > 2) map.jumpTo({ elevation: e });
}

let moveEndHandler = null;

/** Active ou désactive le relief 3D. */
export function setTerrain3d(map, on, exaggeration = 1.5, surface = false) {
  addDemSource(map);
  if (moveEndHandler) {
    map.off('moveend', moveEndHandler);
    moveEndHandler = null;
  }
  if (on) {
    const wasOn = !!map.getTerrain();
    map.setTerrain({ source: surface ? DSM_SOURCE : DEM_SOURCE, exaggeration });
    if (wasOn) {
      moveEndHandler = () => clampCenterToGround(map);
      map.on('moveend', moveEndHandler);
      return;
    }
    moveEndHandler = () => clampCenterToGround(map);
    map.on('moveend', moveEndHandler);
    // On n'incline la vue qu'une fois le relief chargé.
    map.once('idle', () => {
      if (!map.getTerrain()) return;
      clampCenterToGround(map);
      if (map.getPitch() < 30) map.easeTo({ pitch: 60, duration: 800 });
    });
  } else {
    map.setTerrain(null);
    map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  }
}

/** Change l'exagération en gardant la caméra au-dessus du sol. */
export function setExaggeration(map, exaggeration) {
  if (!map.getTerrain()) return;
  map.setTerrain({ source: map.getTerrain().source, exaggeration });
  map.once('idle', () => clampCenterToGround(map));
}

/** Bouton « 3D » dans les contrôles de la carte. */
export class Toggle3dControl {
  constructor(onToggle) {
    this.onToggle = onToggle;
    this.on = false;
  }
  onAdd() {
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'ctrl-3d';
    this.btn.textContent = '3D';
    this.btn.title = 'Relief 3D';
    this.btn.setAttribute('aria-pressed', 'false');
    this.btn.onclick = () => this.onToggle(!this.on);
    this.el.appendChild(this.btn);
    return this.el;
  }
  set(on) {
    this.on = on;
    this.btn?.classList.toggle('on', on);
    this.btn?.setAttribute('aria-pressed', String(on));
  }
  onRemove() {
    this.el.remove();
  }
}
