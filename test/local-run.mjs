// Simulation fine d'un petit secteur (ex. Verdalaï à Peynier) hors navigateur.
// Usage : node test/local-run.mjs <dossier> <res> <pluie mm> <durée h> <forme> <amc> <après h> <sortie>
// Le dossier contient dem<res>.bil, cosia.rgba (résolution res/2) et rivers_raw.json ;
// bbox.json donne l'emprise Lambert 93 et le point suivi :
//   { "xmin", "ymin", "xmax", "ymax", "point": [lon, lat], "river": "Vallat du Verdalaï" }
import fs from 'node:fs';
import path from 'node:path';
import { makeGrid, toL93, cellOf } from '../src/geo.js';
import { classifyRgba } from '../src/hydrology/landcover.js';
import { prepareTerrain, buildGauges, buildModel, regroupSamples } from '../src/sim/model.js';
import { meanRunoff } from '../src/hydrology/scs.js';
import { makeHyetograph } from '../src/hydrology/rain.js';
import { CpuBackend, simulate } from '../src/sim/driver.js';

const [dir, resA, pA, dA, shape = 'desbordes', amcA = '2', tailA = '2', out = 'run'] = process.argv.slice(2);
const res = Number(resA);
const bbox = JSON.parse(fs.readFileSync(path.join(dir, 'bbox.json')));
const grid = makeGrid(bbox, res);
const N = grid.nx * grid.ny;
const dem = new Float32Array(fs.readFileSync(path.join(dir, `dem${res}.bil`)).buffer.slice(0));
const f = 2;
const sub = classifyRgba(new Uint8Array(fs.readFileSync(path.join(dir, 'cosia.rgba'))), N * f * f);
const classes = regroupSamples(sub, grid, f);
const raw = JSON.parse(fs.readFileSync(path.join(dir, 'rivers_raw.json')));
const rivers = {
  features: raw.features.map((x) => ({
    geometry: x.geometry,
    properties: { name: x.properties.cpx_toponyme_de_cours_d_eau, nature: x.properties.nature, fictif: x.properties.fictif },
  })),
};
const terrain = prepareTerrain({ grid, dem, rivers, burnDepth: 0.5, outlet: null });
const [hx, hy] = toL93(...bbox.point);
const gauges = buildGauges(grid, rivers, [
  { id: 'point', name: 'Section au droit du point', x: hx, y: hy, river: bbox.river, halfWidth: 60 },
]);
const model = buildModel({ grid, terrain, classes, spc: f * f, soilGroup: 2, amc: Number(amcA), rainOnBasinOnly: false, cnFactor: 1 });
const P = Number(pA);
const hyeto = makeHyetograph({ totalMm: P, durationH: Number(dA), shape });
const b = new CpuBackend(model, gauges);
const Q = [];
const hk = cellOf(grid, hx, hy).k;
const hSeries = [];
const t0 = Date.now();
const { maxima } = await simulate(b, {
  hyeto,
  totalTime: (Number(dA) + Number(tailA)) * 3600,
  gaugeEvery: 120,
  snapshotEvery: 120,
  onGauge: (t, q) => Q.push([t, q[0]]),
  onSnapshot: (t, h) => hSeries.push([t, h[hk]]),
});
const pk = Q.reduce((a, c) => (c[1] > a[1] ? c : a), [0, 0]);
const mb = b.massBalance();
// hauteur max dans un rayon de 10 m autour de la maison
let hmaxNear = 0;
const c = cellOf(grid, hx, hy);
const r = Math.ceil(10 / res);
for (let dj = -r; dj <= r; dj++)
  for (let di = -r; di <= r; di++) hmaxNear = Math.max(hmaxNear, maxima.hmax[(c.j + dj) * grid.nx + c.i + di]);
const result = {
  scenario: `${P} mm / ${dA} h (${shape}), AMC ${amcA}, maille ${res} m`,
  ruissellementMoyen_mm: +meanRunoff(model.S, P).toFixed(1),
  picDebit_m3s: +pk[1].toFixed(2),
  heurePic_h: +(pk[0] / 3600).toFixed(2),
  hauteurMaxPoint_m: +maxima.hmax[hk].toFixed(3),
  hauteurMax10m_m: +hmaxNear.toFixed(3),
  erreurMasse_pct: +(((mb.rain - mb.out - mb.stored) / mb.rain) * 100).toFixed(4),
  calcul_s: Math.round((Date.now() - t0) / 1000),
};
console.log(JSON.stringify(result));
fs.writeFileSync(path.join(dir, `${out}.json`), JSON.stringify({ ...result, Q, hSeries, grid }));
fs.writeFileSync(path.join(dir, `${out}.hmax.f32`), Buffer.from(maxima.hmax.buffer));
