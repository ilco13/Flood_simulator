// Simulation sur données réelles hors navigateur (moteur CPU), pour valider le modèle.
// Usage : node test/real-run.mjs <dossier> <résolution m> [pluie mm] [durée h] [amc]
// Le dossier contient dem<res>.bil (float32), cosia<res>.rgba (RGBA brut) et rivers_raw.json (WFS).
import fs from 'node:fs';
import path from 'node:path';
import { DOMAIN, OUTLET, GAUGES } from '../src/config.js';
import { makeGrid } from '../src/geo.js';
import { classifyRgba, classFractions, CLASSES } from '../src/hydrology/landcover.js';
import { prepareTerrain, buildGauges, buildModel } from '../src/sim/model.js';
import { meanRunoff } from '../src/hydrology/scs.js';
import { makeHyetograph } from '../src/hydrology/rain.js';
import { CpuBackend, simulate } from '../src/sim/driver.js';

const [dir, resArg, pArg = '100', dArg = '24', amcArg = '2'] = process.argv.slice(2);
const res = Number(resArg);
const grid = makeGrid(DOMAIN, res);
const N = grid.nx * grid.ny;
const dem = new Float32Array(fs.readFileSync(path.join(dir, `dem${res}.bil`)).buffer.slice(0));
const rgba = new Uint8Array(fs.readFileSync(path.join(dir, `cosia${res}.rgba`)));
const raw = JSON.parse(fs.readFileSync(path.join(dir, 'rivers_raw.json')));
const rivers = {
  type: 'FeatureCollection',
  features: raw.features.map((f) => ({
    type: 'Feature',
    geometry: f.geometry,
    properties: {
      name: f.properties.cpx_toponyme_de_cours_d_eau || null,
      nature: f.properties.nature,
      fictif: !!f.properties.fictif,
    },
  })),
};
console.log(`grille ${grid.nx}×${grid.ny} = ${N} mailles de ${res} m`);

const classes = classifyRgba(rgba, N);
const fr = classFractions(classes);
console.log(
  'occupation du sol :',
  CLASSES.map((c, i) => [c.name, fr[i]])
    .filter((x) => x[1] > 0.01)
    .map(([n, f]) => `${n} ${(f * 100).toFixed(0)}%`)
    .join(', '),
);

let t0 = Date.now();
const terrain = prepareTerrain({ grid, dem, rivers, burnDepth: 1, outlet: OUTLET });
console.log(
  `terrain : ${terrain.burned} mailles gravées, bassin ${((terrain.basinCells * res * res) / 1e6).toFixed(0)} km² (${Date.now() - t0} ms)`,
);
const gauges = buildGauges(grid, rivers, GAUGES);
const model = buildModel({ grid, terrain, classes, soilGroup: 2, amc: Number(amcArg), rainOnBasinOnly: true, cnFactor: 1 });
const P = Number(pArg);
console.log(`ruissellement moyen attendu sur le bassin : ${meanRunoff(model.S, P).toFixed(1)} mm pour ${P} mm`);

const hyeto = makeHyetograph({ totalMm: P, durationH: Number(dArg), shape: 'desbordes' });
const backend = new CpuBackend(model, gauges);
const series = gauges.map(() => []);
t0 = Date.now();
const totalTime = (Number(dArg) + 12) * 3600;
const { maxima } = await simulate(backend, {
  hyeto,
  totalTime,
  gaugeEvery: 600,
  snapshotEvery: 3 * 3600,
  onGauge: (t, Q) => Q.forEach((q, i) => series[i].push([t, q])),
  onProgress: (p, info) => {
    if (Math.round(p * 100) % 10 === 0) process.stdout.write(`\r${(p * 100).toFixed(0)} % – ${info.steps} pas`);
  },
});
console.log(`\ncalcul : ${((Date.now() - t0) / 1000).toFixed(1)} s, ${backend.steps} pas`);
const mb = backend.massBalance();
console.log(
  `bilan : pluie nette ${(mb.rain / 1e6).toFixed(2)} hm³, sortie ${(mb.out / 1e6).toFixed(2)} hm³, ` +
    `stock ${(mb.stored / 1e6).toFixed(2)} hm³, erreur ${(((mb.rain - mb.out - mb.stored) / mb.rain) * 100).toFixed(3)} %`,
);
gauges.forEach((g, i) => {
  const peak = series[i].reduce((a, b) => (b[1] > a[1] ? b : a), [0, 0]);
  console.log(`  ${g.name.padEnd(32)} pic ${peak[1].toFixed(1).padStart(7)} m³/s à ${(peak[0] / 3600).toFixed(1)} h (${g.cells.length} mailles)`);
});
let wet = 0;
for (let k = 0; k < N; k++) if (maxima.hmax[k] > 0.5 && terrain.mask?.[k]) wet++;
console.log(`surface du bassin avec plus de 50 cm d'eau au max : ${((wet * res * res) / 1e6).toFixed(2)} km²`);
