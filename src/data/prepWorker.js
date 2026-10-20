// Worker de préparation : téléchargement (MNT LiDAR HD, COSIA, BD TOPO) et prétraitements
// lourds (gravure, bassin versant, classification), hors du fil principal.

import { LAYERS } from '../config.js';
import { fetchFloatGrid, fetchRgbaGrid } from './wms.js';
import { fetchRivers } from './rivers.js';
import { classifyRgba, classFractions } from '../hydrology/landcover.js';
import { prepareTerrain, buildGauges } from '../sim/model.js';
import { maskOutline } from '../hydrology/terrain.js';
import { toWgs } from '../geo.js';

const toWgsCoords = (coords) => coords.map(([x, y]) => toWgs(x, y));
function geomToWgs(g) {
  if (g.type === 'LineString') return { type: g.type, coordinates: toWgsCoords(g.coordinates) };
  if (g.type === 'MultiLineString') return { type: g.type, coordinates: g.coordinates.map(toWgsCoords) };
  return null;
}

const post = (type, data, transfer) => self.postMessage({ type, ...data }, transfer || []);

self.onmessage = async (e) => {
  const { grid, burnDepth, outlet, gauges: gaugeDefs } = e.data;
  try {
    const step = (label, p) => post('progress', { label, p });
    const N = grid.nx * grid.ny;

    step('Relief LiDAR HD (IGN)…', 0);
    const demP = fetchFloatGrid(grid, LAYERS.dem, LAYERS.demFallback, {
      onProgress: (p) => step('Relief LiDAR HD (IGN)…', p),
    });
    const lcP = fetchRgbaGrid(grid, LAYERS.landcover, {
      onProgress: (p) => step('Occupation du sol COSIA (IGN)…', p),
    });
    const bboxPad = {
      xmin: grid.xmin - 500,
      ymin: grid.ymin - 500,
      xmax: grid.xmax + 500,
      ymax: grid.ymax + 500,
    };
    const rivP = fetchRivers(bboxPad).catch((err) => {
      console.warn('BD TOPO indisponible', err);
      return { type: 'FeatureCollection', features: [] };
    });
    const [dem, rgba, rivers] = await Promise.all([demP, lcP, rivP]);

    step('Classification de l\'occupation du sol…', 1);
    const classes = classifyRgba(rgba, N);
    const fractions = classFractions(classes);

    step('Gravure des cours d\'eau et délimitation du bassin…', 1);
    const terrain = prepareTerrain({ grid, dem, rivers, burnDepth, outlet });
    const gauges = buildGauges(grid, rivers, gaugeDefs);

    let outline = [];
    if (terrain.mask) {
      // Contour simplifié : on supprime les points alignés.
      outline = maskOutline(terrain.mask, grid.nx, grid.ny).map((ring) => {
        const out = [ring[0]];
        for (let i = 1; i < ring.length - 1; i++) {
          const [ax, ay] = out[out.length - 1];
          const [bx, by] = ring[i];
          const [cx, cy] = ring[i + 1];
          if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) !== 0) out.push(ring[i]);
        }
        out.push(ring[ring.length - 1]);
        // Coordonnées de grille -> WGS84
        return out.map(([gx, gy]) => toWgs(grid.xmin + gx * grid.dx, grid.ymax - gy * grid.dx));
      });
    }
    for (const g of gauges) g.lineWgs = g.line.map(([x, y]) => toWgs(x, y));

    // Réseau hydrographique allégé pour l'affichage (cours d'eau nommés + permanents).
    const display = {
      type: 'FeatureCollection',
      features: rivers.features
        .filter((f) => f.properties.nature !== 'Aqueduc' && f.properties.nature !== 'Conduit forcé')
        .map((f) => ({
          type: 'Feature',
          geometry: geomToWgs(f.geometry),
          properties: { name: f.properties.name, nature: f.properties.nature },
        }))
        .filter((f) => f.geometry),
    };

    const transfer = [dem.buffer, classes.buffer, terrain.z.buffer];
    if (terrain.mask) transfer.push(terrain.mask.buffer);
    post(
      'done',
      {
        dem,
        classes,
        fractions,
        z: terrain.z,
        mask: terrain.mask,
        basinCells: terrain.basinCells,
        burned: terrain.burned,
        gauges,
        outline,
        rivers: display,
      },
      transfer,
    );
  } catch (err) {
    post('error', { message: String(err?.message || err) });
  }
};
