// Worker de préparation : téléchargement (MNT LiDAR HD, COSIA, BD TOPO) et prétraitements
// lourds (gravure, bassin versant, classification), hors du fil principal.

import { LAYERS } from '../config.js';
import { fetchFloatGrid, fetchRgbaGrid } from './wms.js';
import { fetchRivers } from './rivers.js';
import { classifyRgba, classFractions } from '../hydrology/landcover.js';
import { prepareTerrain, buildGauges, landcoverOversampling, regroupSamples } from '../sim/model.js';
import { outlineWgs } from './outline.js';
import { toWgs } from '../geo.js';

const toWgsCoords = (coords) => coords.map(([x, y]) => toWgs(x, y));
function geomToWgs(g) {
  if (g.type === 'LineString') return { type: g.type, coordinates: toWgsCoords(g.coordinates) };
  if (g.type === 'MultiLineString') return { type: g.type, coordinates: g.coordinates.map(toWgsCoords) };
  return null;
}

const post = (type, data, transfer) => self.postMessage({ type, ...data }, transfer || []);

self.onmessage = async (e) => {
  const { grid, burnDepth, outlet, upstreamOf, gauges: gaugeDefs } = e.data;
  try {
    const last = {};
    const step = (key, p, detail) => {
      last[key] = p;
      post('progress', { step: key, p, detail });
    };
    const retry = (key) => (attempt, tries) =>
      step(key, last[key] ?? 0, `serveur IGN lent, nouvel essai ${attempt}/${tries}`);
    const warnings = [];
    const N = grid.nx * grid.ny;

    step('dem', 0);
    step('lc', 0);
    step('rivers', 0);
    const demP = fetchFloatGrid(grid, LAYERS.dem, LAYERS.demFallback, {
      onProgress: (p) => step('dem', p),
      onRetry: retry('dem'),
      warnings,
    });
    // Occupation du sol sur-échantillonnée (f×f pixels par maille) pour ne pas perdre
    // le bâti et les routes aux résolutions grossières.
    const f = landcoverOversampling(grid.dx);
    const subGrid = { ...grid, dx: grid.dx / f, nx: grid.nx * f, ny: grid.ny * f };
    const lcP = fetchRgbaGrid(subGrid, LAYERS.landcover, LAYERS.landcoverFallback, {
      onProgress: (p) => step('lc', p),
      onRetry: retry('lc'),
      warnings,
    });
    const bboxPad = {
      xmin: grid.xmin - 500,
      ymin: grid.ymin - 500,
      xmax: grid.xmax + 500,
      ymax: grid.ymax + 500,
    };
    const rivP = fetchRivers(bboxPad)
      .then((r) => {
        step('rivers', 1);
        return r;
      })
      .catch((err) => {
      console.warn('BD TOPO indisponible', err);
      warnings.push('réseau BD TOPO indisponible (pas de gravure ni de points de suivi)');
      step('rivers', 1);
      return { type: 'FeatureCollection', features: [] };
    });
    const [dem, rgba, rivers] = await Promise.all([demP, lcP, rivP]);

    step('prep', 0.1);
    const sub = classifyRgba(rgba, N * f * f);
    const fractions = classFractions(sub);
    const classes = regroupSamples(sub, grid, f);

    step('prep', 0.4);
    const terrain = prepareTerrain({ grid, dem, rivers, burnDepth, outlet, upstreamOf });
    // Points de suivi : seulement ceux qui coupent le bassin simulé.
    const gauges = buildGauges(grid, rivers, gaugeDefs).filter(
      (g) => !terrain.mask || Array.from(g.cells).some((k) => terrain.mask[k] || terrain.mask[k + 1] || terrain.mask[k + grid.nx]),
    );

    const outline = terrain.mask ? outlineWgs(terrain.mask, grid) : [];
    step('prep', 0.9);
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
        spc: f * f,
        fractions,
        z: terrain.z,
        mask: terrain.mask,
        basinCells: terrain.basinCells,
        burned: terrain.burned,
        gauges,
        outline,
        warnings: [...new Set(warnings)],
        rivers: display,
      },
      transfer,
    );
  } catch (err) {
    post('error', { message: String(err?.message || err) });
  }
};
