import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { ORTHO_TILES, SHADOW_TILES, PLAN_IGN_STYLE, DOMAIN } from './config.js';
import { toWgs } from './geo.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

// Couches du Plan IGN gardées pour l'effet « hybride » : routes, voies ferrées, noms.
const ROAD_LAYERS = new Set([
  'routier_route',
  'routier_route_sup',
  'routier_liaison',
  'routier_chemin',
  'ferre',
  'ferre_sup',
]);
const isLabelLayer = (sl) =>
  sl?.startsWith('toponyme_') && !sl.startsWith('toponyme_parcellaire') && sl !== 'toponyme_routier_borne';

async function loadPlanIgnOverlay() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await tryLoadPlanIgn();
    } catch (e) {
      console.warn('Plan IGN indisponible', e);
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  return null;
}

async function tryLoadPlanIgn() {
  {
    const res = await fetch(PLAN_IGN_STYLE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const style = await res.json();
    const layers = style.layers.filter((l) => {
      const sl = l['source-layer'];
      if (l.type === 'line' && ROAD_LAYERS.has(sl)) return true;
      if (l.type === 'symbol' && isLabelLayer(sl)) return true;
      return false;
    });
    return { sources: style.sources, glyphs: style.glyphs, sprite: style.sprite, layers };
  }
}

export async function createMap(container) {
  const overlay = await loadPlanIgnOverlay();
  const sw = toWgs(DOMAIN.xmin, DOMAIN.ymin);
  const ne = toWgs(DOMAIN.xmax, DOMAIN.ymax);

  const style = {
    version: 8,
    ...(overlay ? { glyphs: overlay.glyphs, sprite: overlay.sprite } : {}),
    sources: {
      ortho: {
        type: 'raster',
        tiles: [ORTHO_TILES],
        tileSize: 256,
        maxzoom: 19,
        attribution: '© IGN – BD ORTHO, LiDAR HD, COSIA, BD TOPO, Plan IGN',
      },
      shadow: { type: 'raster', tiles: [SHADOW_TILES], tileSize: 256, maxzoom: 18 },
      rivers: { type: 'geojson', data: EMPTY },
      basin: { type: 'geojson', data: EMPTY },
      catchment: { type: 'geojson', data: EMPTY },
      gauges: { type: 'geojson', data: EMPTY },
      probe: { type: 'geojson', data: EMPTY },
      section: { type: 'geojson', data: EMPTY },
      'section-hover': { type: 'geojson', data: EMPTY },
      ...(overlay?.sources || {}),
    },
    layers: [
      { id: 'ortho', type: 'raster', source: 'ortho' },
      {
        id: 'shadow',
        type: 'raster',
        source: 'shadow',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.35 },
      },
      // La couche d'eau est insérée ici (avant 'rivers').
      {
        id: 'rivers',
        type: 'line',
        source: 'rivers',
        paint: {
          'line-color': ['case', ['==', ['get', 'name'], "l'Arc"], '#2fd0ff', '#7fe3ff'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['case', ['==', ['get', 'name'], "l'Arc"], 2, 0.6], 15, ['case', ['==', ['get', 'name'], "l'Arc"], 4, 1.6]],
          'line-opacity': 0.75,
        },
      },
      {
        id: 'basin',
        type: 'line',
        source: 'basin',
        paint: { 'line-color': '#ffd84d', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.9 },
      },
      {
        id: 'catchment-fill',
        type: 'fill',
        source: 'catchment',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#ff9f1c', 'fill-opacity': 0.12 },
      },
      {
        id: 'catchment-line',
        type: 'line',
        source: 'catchment',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'line-color': '#ff9f1c', 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
      },
      {
        id: 'catchment-point',
        type: 'circle',
        source: 'catchment',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': '#ff9f1c', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
      },
      ...(overlay?.layers || []),
      {
        id: 'gauge-lines',
        type: 'line',
        source: 'gauges',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#ff5a36', 'line-width': 3 },
      },
      // Étiquettes des points de suivi (nécessitent les polices du Plan IGN).
      ...(overlay
        ? [
            {
              id: 'gauge-labels',
              type: 'symbol',
              source: 'gauges',
              filter: ['==', ['geometry-type'], 'Point'],
              layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Source Sans Pro Bold'],
                'text-size': 12,
                'text-offset': [0, 1.2],
                'text-anchor': 'top',
                'text-optional': true,
              },
              paint: { 'text-color': '#ff5a36', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
            },
          ]
        : []),
      {
        id: 'section-casing',
        type: 'line',
        source: 'section',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 },
      },
      {
        id: 'section-line',
        type: 'line',
        source: 'section',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ff6a3d', 'line-width': 3.5 },
      },
      {
        id: 'section-ends',
        type: 'circle',
        source: 'section',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 7,
          'circle-color': ['case', ['==', ['get', 'end'], 'A'], '#ff6a3d', '#ffffff'],
          'circle-stroke-color': '#ff6a3d',
          'circle-stroke-width': 3,
        },
      },
      ...(overlay
        ? [
            {
              id: 'section-labels',
              type: 'symbol',
              source: 'section',
              filter: ['==', ['geometry-type'], 'Point'],
              layout: {
                'text-field': ['get', 'end'],
                'text-font': ['Source Sans Pro Bold'],
                'text-size': 14,
                'text-offset': [0, -1.3],
                'text-allow-overlap': true,
              },
              paint: { 'text-color': '#ff6a3d', 'text-halo-color': '#fff', 'text-halo-width': 2 },
            },
          ]
        : []),
      {
        id: 'section-hover',
        type: 'circle',
        source: 'section-hover',
        paint: { 'circle-radius': 5, 'circle-color': '#0b2540', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
      },
      {
        id: 'probe',
        type: 'circle',
        source: 'probe',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ff2d55',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      },
    ],
  };

  const map = new maplibregl.Map({
    container,
    style,
    bounds: [sw, ne],
    // Sur téléphone, le panneau couvre le bas de l'écran (58 %) : on cadre au-dessus.
    fitBoundsOptions: {
      padding: window.matchMedia('(max-width: 760px)').matches
        ? { top: 20, left: 20, right: 20, bottom: Math.round(window.innerHeight * 0.58) + 20 }
        : 20,
    },
    maxZoom: 19,
    hash: true,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
  // « load » attend toutes les tuiles visibles : une tuile IGN bloquée empêcherait le
  // démarrage. Le style suffit pour ajouter nos couches : on n'attend pas plus de 6 s.
  await new Promise((resolve) => {
    if (map.loaded()) return resolve();
    const t0 = performance.now();
    const timer = setInterval(() => {
      if (map.isStyleLoaded() && performance.now() - t0 > 6000) done();
    }, 300);
    const done = () => {
      clearInterval(timer);
      resolve();
    };
    map.once('load', done);
  });
  return { map, overlayIds: (overlay?.layers || []).map((l) => l.id) };
}

/** Ajoute ou remplace la couche d'eau (canvas) positionnée sur la grille Lambert 93. */
export function setWaterCanvas(map, canvas, corners) {
  if (map.getLayer('water')) map.removeLayer('water');
  if (map.getSource('water')) map.removeSource('water');
  map.addSource('water', { type: 'canvas', canvas, coordinates: corners, animate: false });
  map.addLayer(
    {
      id: 'water',
      type: 'raster',
      source: 'water',
      paint: { 'raster-opacity': map.getTerrain() ? 0.45 : 1, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 },
    },
    map.getLayer('water3d') ? 'water3d' : 'rivers',
  );
}

/** Force MapLibre à recharger la texture du canvas après un dessin. */
export function refreshWater(map) {
  const src = map.getSource('water');
  if (!src) return;
  src.play();
  map.once('render', () => src.pause());
  map.triggerRepaint();
}

export function setGeoJson(map, id, data) {
  map.getSource(id)?.setData(data || EMPTY);
}

/** Cadre la carte sur des coins [lon, lat], en tenant compte du panneau sur téléphone. */
export function fitBoundsOf(map, corners, extraPad = 0) {
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  map.fitBounds(
    [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ],
    {
      padding: mobile
        ? { top: 20 + extraPad, left: 20 + extraPad, right: 20 + extraPad, bottom: Math.round(window.innerHeight * 0.58) + 20 }
        : 30 + extraPad,
      pitch: map.getPitch(),
      duration: 800,
    },
  );
}
