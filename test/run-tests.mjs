// Tests numériques du modèle (node test/run-tests.mjs).
import assert from 'node:assert/strict';
import { makeHyetograph } from '../src/hydrology/rain.js';
import { runoffMm, runoffRate, retentionMm, adjustCn, meanRunoffHyeto } from '../src/hydrology/scs.js';
import { CpuBackend, simulate } from '../src/sim/driver.js';
import { CpuSolver } from '../src/sim/cpuSolver.js';
import { buildGauges, prepareTerrain } from '../src/sim/model.js';
import { rasterizeLine } from '../src/data/rivers.js';
import { floodQuantiles } from '../src/hydrology/flood.js';
import { amcIndex, yearsOf, arealHourly, rainWindow, amcFromAntecedent, antecedentIndex, episodeScores, parisDayStart } from '../src/hydrology/episode.js';
import { parseFlowCsv, topFloods } from '../src/data/hydro.js';
import { runMetrics, analyseComparison, diffCodes, durationAbove } from '../src/sim/compare.js';
import { drainageLabels, basinMask, accumulation, upstreamMask, flowDirections } from '../src/hydrology/terrain.js';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

await test('hyétogrammes : le cumul final vaut le total', () => {
  for (const shape of ['uniform', 'desbordes', 'early', 'late', 'chicago']) {
    const h = makeHyetograph({ totalMm: 100, durationH: 24, shape });
    assert.ok(Math.abs(h.cumulative(24 * 3600) - 100) < 1e-6, shape);
    // intégrale numérique de l'intensité = cumul
    let s = 0;
    const n = 20000;
    for (let k = 0; k < n; k++) s += (h.intensity(((k + 0.5) / n) * 86400) * 24) / n;
    assert.ok(Math.abs(s - 100) < 0.2, `${shape} intégrale ${s}`);
    // cumul monotone
    let prev = -1;
    for (let k = 0; k <= 1000; k++) {
      const c = h.cumulative((k / 1000) * 86400);
      assert.ok(c >= prev - 1e-9);
      prev = c;
    }
  }
});

await test('SCS-CN : valeurs de référence et cohérence dQ/dP', () => {
  const S = retentionMm(80); // 63.5 mm
  assert.ok(Math.abs(S - 63.5) < 0.01);
  // P = 100 mm, CN 80 -> Q ≈ 50.4 mm
  assert.ok(Math.abs(runoffMm(100, S) - 50.4) < 0.5);
  const dP = 0.001;
  const num = (runoffMm(60 + dP, S) - runoffMm(60, S)) / dP;
  assert.ok(Math.abs(num - runoffRate(60, S)) < 1e-3);
  assert.ok(adjustCn(80, 3) > 80 && adjustCn(80, 1) < 80);
});

function plane({ nx, ny, dx, slopeX = 0.01, n = 0.05, S = 0 }) {
  const N = nx * ny;
  const z = new Float32Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = 100 - slopeX * i * dx;
  return { nx, ny, dx, z, S: new Float32Array(N).fill(S), manning: new Float32Array(N).fill(n) };
}

await test('plan incliné sous la pluie : conservation de la masse', async () => {
  const m = plane({ nx: 60, ny: 20, dx: 10 });
  const b = new CpuBackend(m, []);
  const hyeto = makeHyetograph({ totalMm: 50, durationH: 1, shape: 'uniform' });
  await simulate(b, { hyeto, totalTime: 7200, gaugeEvery: 600, snapshotEvery: 3600 });
  const { rain, out, stored } = b.massBalance();
  const expected = 0.05 * 60 * 20 * 100; // m³
  assert.ok(Math.abs(rain - expected) / expected < 1e-3, `pluie ${rain} vs ${expected}`);
  const err = Math.abs(rain - out - stored) / rain;
  assert.ok(err < 1e-3, `erreur de masse ${(err * 100).toFixed(3)} %`);
  assert.ok(out > 0.5 * rain, 'l\'eau doit s\'évacuer vers l\'aval');
});

await test('lac au repos : pas de courant parasite', async () => {
  const nx = 40;
  const ny = 40;
  const N = nx * ny;
  const z = new Float32Array(N);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) z[j * nx + i] = 0.01 * ((i - 20) ** 2 + (j - 20) ** 2) + Math.sin(i * 1.3) * 0.2;
  const S = new Float32Array(N).fill(-1);
  const b = new CpuBackend({ nx, ny, dx: 5, z, S, manning: new Float32Array(N).fill(0.03) }, []);
  // lac à la cote 2 m
  for (let k = 0; k < N; k++) b.solver.h[k] = Math.max(0, 2 - z[k]);
  const v0 = b.solver.storedVolume();
  b.hm = 4;
  await b.advance(1800, makeHyetograph({ totalMm: 0, durationH: 1 }));
  let qmax = 0;
  for (const q of b.solver.qx) qmax = Math.max(qmax, Math.abs(q));
  for (const q of b.solver.qy) qmax = Math.max(qmax, Math.abs(q));
  // tolérance : arrondis float32 sur la cote du plan d'eau
  assert.ok(qmax < 1e-4, `débit parasite ${qmax}`);
  assert.ok(Math.abs(b.solver.storedVolume() - v0) / v0 < 1e-5);
});

function channel(nx, ny, dx, zfun) {
  // Canal fermé par des murs sur les côtés et à l'amont ; sortie libre à l'aval (est).
  const N = nx * ny;
  const z = new Float32Array(N);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const wall = j === 0 || j === ny - 1 || i === 0;
      z[j * nx + i] = zfun(i) + (wall ? 50 : 0);
    }
  return z;
}

await test('pluie sur pente : hauteur normale de Manning (onde cinématique)', async () => {
  const nx = 122;
  const ny = 5;
  const dx = 5;
  const slope = 0.01;
  const n = 0.05;
  const z = channel(nx, ny, dx, (i) => 100 - slope * i * dx);
  const N = nx * ny;
  // Pas de pluie sur les murs (sinon elle ruisselle dans le canal).
  const S = new Float32Array(N).map((_, k) => (z[k] > 120 ? -1 : 0));
  const b = new CpuBackend({ nx, ny, dx, z, S, manning: new Float32Array(N).fill(n) }, []);
  const hyeto = makeHyetograph({ totalMm: 200, durationH: 4, shape: 'uniform' }); // 50 mm/h
  await simulate(b, { hyeto, totalTime: 2.5 * 3600, gaugeEvery: 600, snapshotEvery: 99999 });
  const r = 0.05 / 3600;
  for (const i of [40, 80, 110]) {
    const x = (i - 0.5) * dx; // distance depuis le mur amont (maille 0)
    const q = r * x;
    const hn = Math.pow((q * n) / Math.sqrt(slope), 0.6);
    const h = b.solver.h[2 * nx + i];
    assert.ok(Math.abs(h - hn) / hn < 0.08, `x=${x} m : h=${h.toFixed(4)} attendu ${hn.toFixed(4)}`);
  }
});

await test('rupture de barrage sur fond mouillé (Stoker) : hauteur intermédiaire', async () => {
  const nx = 402;
  const ny = 5;
  const dx = 1;
  const z = channel(nx, ny, dx, () => 0);
  for (let j = 0; j < ny; j++) z[j * nx + nx - 1] = 50; // mur aval aussi
  const N = nx * ny;
  const b = new CpuBackend({ nx, ny, dx, z, S: new Float32Array(N).fill(-1), manning: new Float32Array(N).fill(0.005) }, []);
  for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) b.solver.h[j * nx + i] = i <= 200 ? 1 : 0.5;
  b.hm = 1;
  await b.advance(20, makeHyetograph({ totalMm: 0, durationH: 1 }));
  // Solution de Stoker (hl=1, hr=0.5) : plateau h_m = 0.727 entre la détente (x=-35 m)
  // et le ressaut (x=+59 m) à t = 20 s.
  // Le schéma « inertie locale » néglige l'accélération convective : écart attendu de quelques %.
  const hm = b.solver.h[2 * nx + 215];
  assert.ok(Math.abs(hm - 0.727) < 0.06, `plateau h=${hm.toFixed(3)}`);
  let shock = 0;
  for (let i = 201; i < nx - 1; i++) if (b.solver.h[2 * nx + i] > 0.61) shock = i - 200;
  assert.ok(Math.abs(shock - 59) < 8, `ressaut à ${shock} m`);
  // La zone aval non perturbée doit rester à 0,5 m.
  assert.ok(Math.abs(b.solver.h[2 * nx + 300] - 0.5) < 0.01);
  for (let i = 1; i < nx - 1; i++) assert.ok(b.solver.h[2 * nx + i] <= 1.0001 && b.solver.h[2 * nx + i] >= 0.49);
});

await test('bassin versant : priority-flood étiquette la bonne sortie', () => {
  // Deux vallées en V séparées par une crête au milieu, sorties nord et sud.
  const nx = 30;
  const ny = 30;
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) z[j * nx + i] = 50 - Math.abs(j - 15) * 2 + Math.abs(i - 15) * 0.5 + 100;
  const { label } = drainageLabels(z, nx, ny);
  const { mask } = basinMask(label, 2 * nx + 15);
  assert.equal(mask[5 * nx + 15], 1);
  assert.equal(mask[25 * nx + 15], 0);
});

await test('bassin versant d\'un point : seul l\'amont est retenu', () => {
  // Vallée en V qui descend vers le nord (j = 0) ; point au milieu du thalweg.
  const nx = 31;
  const ny = 40;
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = 100 + j * 1 + Math.abs(i - 15) * 0.5;
  const { parent, order, filled } = drainageLabels(z, nx, ny);
  const down = flowDirections(filled, parent, order, nx, ny);
  const acc = accumulation(down, order);
  const k0 = 20 * nx + 15;
  const { mask, cells } = upstreamMask(down, order, k0);
  assert.equal(mask[30 * nx + 15], 1); // amont
  assert.equal(mask[10 * nx + 15], 0); // aval
  assert.equal(acc[k0], cells);
  // Le thalweg draine plus que les versants, et les versants amont rejoignent le point.
  assert.ok(acc[k0] > acc[20 * nx + 10]);
  assert.equal(mask[35 * nx + 5], 1);
  assert.ok(cells > 300);
});

await test('point de suivi oblique : chaque écoulement compté une seule fois', () => {
  // Chenal de 10 mailles de large coulant vers l'est (q = 1 m²/s), coupé en biais.
  const nx = 60;
  const ny = 40;
  const dx = 10;
  const grid = { xmin: 0, ymin: 0, xmax: nx * dx, ymax: ny * dx, nx, ny, dx };
  const qx = new Float32Array((nx + 1) * ny);
  const qy = new Float32Array(nx * (ny + 1));
  for (let j = 15; j < 25; j++) for (let i = 0; i <= nx; i++) qx[j * (nx + 1) + i] = 1;
  for (const deg of [0, 20, 35, 50]) {
    const a = (deg * Math.PI) / 180;
    const rivers = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { name: 'r' }, geometry: { type: 'LineString', coordinates: [[300 - 200 * Math.cos(a), 200 - 200 * Math.sin(a)], [300 + 200 * Math.cos(a), 200 + 200 * Math.sin(a)]] } }],
    };
    const [g] = buildGauges(grid, rivers, [{ id: 'g', name: 'g', x: 300, y: 200, river: 'r', halfWidth: 150 }]);
    const [Q] = CpuSolver.prototype.gaugeDischarges.call({ nx, qx, qy }, [g]);
    assert.ok(Math.abs(Q - 100) < 1e-6, `angle ${deg}° : ${Q} m³/s au lieu de 100`);
  }
});

await test('mur dessiné : relevé dans le relief et jamais percé par le débrèchage', () => {
  // Pente douce vers l'est ; un mur nord-sud de 1,5 m crée une cuvette à l'amont.
  const nx = 40;
  const ny = 20;
  const dx = 5;
  const grid = { xmin: 0, ymin: 0, xmax: nx * dx, ymax: ny * dx, nx, ny, dx };
  const dem = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) dem[j * nx + i] = 100 - i * 0.05;
  const wall = { type: 'wall', h: 1.5, pts: [[102.5, -10], [102.5, 110]] };
  const t = prepareTerrain({ grid, dem, rivers: null, burnDepth: 0, obstacles: [wall] });
  for (let j = 0; j < ny; j++) {
    const k = j * nx + 20;
    assert.ok(Math.abs(t.z[k] - (dem[k] + 1.5)) < 1e-4, `mur abaissé en ligne ${j}`);
  }
  const b = { type: 'building', h: 6, pts: [[150, 30], [170, 30], [170, 60], [150, 60]] };
  const t2 = prepareTerrain({ grid, dem, rivers: null, burnDepth: 0, obstacles: [b] });
  let raised = 0;
  for (let k = 0; k < t2.z.length; k++) if (t2.z[k] - dem[k] > 5.9) raised++;
  assert.equal(raised, 4 * 6); // 20 m × 30 m = 4 × 6 mailles de 5 m
});

await test('pont en remblai dans le MNT : lit creusé en pente continue vers l\'aval (maille 2 m)', () => {
  // Lit nord → sud dans une vallée, remblai routier de 4,7 m sur 8 m de large en travers.
  const nx = 60;
  const ny = 100;
  const dx = 2;
  const grid = { xmin: 0, ymin: 0, xmax: nx * dx, ymax: ny * dx, nx, ny, dx };
  const dem = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let zz = 240 - j * 0.04 + Math.abs(i - 30) * 0.3;
      if (j >= 48 && j < 52) zz = Math.max(zz, 238.7); // tablier interpolé
      dem[j * nx + i] = zz;
    }
  // Tracé BD TOPO (avec altitudes, de l'amont vers l'aval), légèrement de biais
  const rivers = {
    features: [{ type: 'Feature', properties: { nature: 'Ecoulement naturel' }, geometry: { type: 'LineString', coordinates: [[61, 199, 240], [59, 1, 236]] } }],
  };
  const t = prepareTerrain({ grid, dem, rivers, burnDepth: 0.5 });
  const cells = [];
  rasterizeLine(grid, [[61, 199], [59, 1]], (k) => cells.push(k));
  for (let n = 1; n < cells.length; n++) assert.ok(t.z[cells[n]] <= t.z[cells[n - 1]] + 1e-6, `remontée au pas ${n}`);
  // chemin 4-connexe : deux mailles successives partagent un côté
  for (let n = 1; n < cells.length; n++) {
    const a = cells[n - 1];
    const b = cells[n];
    assert.ok(Math.abs(a - b) === 1 || Math.abs(a - b) === nx, 'maille reliée par un coin seulement');
  }
});

await test("plafond d'infiltration : un orage intense ruisselle même sur un sol qui pourrait tout stocker", async () => {
  // Cuvette fermée (pas de sortie) : le volume d'eau en surface = ruissellement produit.
  const nx = 12, ny = 12, dx = 10, N = nx * ny;
  const z = new Float32Array(N).fill(100);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) z[j * nx + i] = 200;
  const S = new Float32Array(N).fill(150); // Ia = 30 mm : 30 mm de pluie ne ruisselleraient pas du tout
  const manning = new Float32Array(N).fill(0.05);
  const hy = makeHyetograph({ totalMm: 30, durationH: 0.5, shape: 'uniform' }); // 60 mm/h
  const run = async (fc) => {
    const b = new CpuBackend({ nx, ny, dx, z, S, manning, fc, m0: 3 }, []);
    await simulate(b, { hyeto: hy, totalTime: 1800, gaugeEvery: 300, snapshotEvery: 1800 });
    const h = await b.readDepth();
    let v = 0;
    for (let k = 0; k < N; k++) v += h[k];
    return (v / N) * 1000; // mm
  };
  assert.ok((await run(null)) < 0.01, 'SCS seule : pas de ruissellement');
  const q = await run(new Float32Array(N).fill(8 / 3.6e6)); // 8 mm/h, capacité initiale 24 mm/h
  assert.ok(q > 10 && q < 30, `ruissellement par excès d'intensité : ${q.toFixed(1)} mm`);
  // Diagnostic du panneau : même ordre de grandeur que la simulation
  const d = meanRunoffHyeto(S, new Float32Array(N).fill(8 / 3.6e6), 3, hy, 1800);
  assert.ok(Math.abs(d - q) < 0.15 * q + 0.5, `diagnostic ${d.toFixed(1)} vs ${q.toFixed(1)}`);
});

await test("apport d'une rivière : volume injecté conservé (bilan de masse)", async () => {
  const nx = 30, ny = 10, dx = 10, N = nx * ny;
  const z = new Float32Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = 100 - 0.01 * i * dx + 0.05 * Math.abs(j - 5) * dx;
  const b = new CpuBackend({ nx, ny, dx, z, S: new Float32Array(N).fill(-1), manning: new Float32Array(N).fill(0.04), inflow: { cells: Int32Array.from([5 * nx + 1, 4 * nx + 1]), Q: 3, ramp: 600 } }, []);
  const hy = makeHyetograph({ totalMm: 0, durationH: 1, shape: 'uniform' });
  await simulate(b, { hyeto: hy, totalTime: 3600, gaugeEvery: 300, snapshotEvery: 3600 });
  const m = b.massBalance();
  const expected = 3 * (3600 - 300); // montée linéaire sur 10 min
  assert.ok(Math.abs(m.rain - expected) / expected < 0.01, `apport ${m.rain.toFixed(0)} m³ au lieu de ${expected}`);
  assert.ok(Math.abs(m.rain - m.out - m.stored) / m.rain < 1e-3, 'bilan de masse');
  assert.ok(m.out > 0.5 * m.rain, "l'eau s'écoule vers l'aval");
});

await test('débits de crue estimés (CRUPEDIX + gradex)', () => {
  const a = floodQuantiles(100, 80, 120);
  assert.ok(Math.abs(a.q10 - 100 ** 0.8) < 1e-9, 'CRUPEDIX neutre');
  assert.ok(a.q100 > 1.5 * a.q10 && a.q100 < 5 * a.q10, `rapport Q100/Q10 ${(a.q100 / a.q10).toFixed(2)}`);
  const b = floodQuantiles(1000, 80, 120);
  assert.ok(b.q10 > a.q10 && b.q100 > a.q100, 'croît avec la surface');
});

await test('épisode réel : pluie moyenne, fenêtre, humidité du sol, écarts aux mesures', () => {
  // Pluie observée heure par heure
  const h = makeHyetograph({ shape: 'observed', hourly: [0, 2, 10, 4] });
  assert.equal(h.totalMm, 16);
  assert.ok(Math.abs(h.cumulative(2.5 * 3600) - 7) < 1e-9 && h.peakMmH() === 10);
  // Moyenne pondérée par la distance, heures manquantes ignorées
  const a = arealHourly([{ d: 0, rr: Float32Array.of(10, NaN) }, { d: 9, rr: Float32Array.of(0, 4) }], 2);
  assert.ok(Math.abs(a[0] - 10 * 1 / (1 + 0.01)) < 1e-6 && Math.abs(a[1] - 4) < 1e-6);
  // Fenêtre : du début à la fin de la pluie (2 % – 98 %), une heure avant
  const w = rainWindow(Float32Array.from([5, 0, 0, 0, 1, 20, 30, 10, 0, 0]), 2);
  assert.deepEqual(w, { s: 4, e: 8 });
  // Indice de pluies antérieures : 10 mm la veille comptent 10, 10 mm il y a 11 jours comptent 10 × 0,9^10
  const hist = new Float32Array(31 * 24);
  hist[30 * 24 - 1] = 10;
  hist[20 * 24 - 1] = 10;
  assert.ok(Math.abs(antecedentIndex(hist, 31 * 24) - (10 * 0.9 + 10 * 0.9 ** 11)) < 1e-6);
  // Humidité continue : 1, 2 et 3 aux points d'appui, sans saut ; CN interpolé exact aux classes
  assert.equal(amcIndex(10, 12), 1);
  assert.ok(Math.abs(amcIndex(41, 12) - 2) < 1e-9 && amcIndex(84, 12) === 3);
  assert.ok(Math.abs(amcIndex(56.5, 12) - amcIndex(55.5, 12)) < 0.05, 'pas de saut au seuil');
  assert.ok(Math.abs(adjustCn(70, 2) - 70) < 1e-9 && adjustCn(70, 2.5) > 70 && adjustCn(70, 2.5) < adjustCn(70, 3));
  assert.equal(amcFromAntecedent(20, 1), 1);
  assert.equal(amcFromAntecedent(45, 11), 2);
  assert.equal(amcFromAntecedent(60, 12), 3);
  assert.equal(amcFromAntecedent(110, 7), 3);
  // Noms des fichiers horaires Météo-France : décennie, années récentes, dernières années
  assert.deepEqual(yearsOf('x/H_68_2010-2019.csv.gz'), [2010, 2019]);
  assert.deepEqual(yearsOf('x/H_68_previous-2020-2024.csv.gz'), [2020, 2024]);
  assert.deepEqual(yearsOf('x/H_68_latest-2025-2026.csv.gz'), [2025, 2026]);
  // Heure d'été : le jour commence à 22 h TU la veille
  assert.equal(new Date(parisDayStart('2019-07-01')).toISOString(), '2019-06-30T22:00:00.000Z');
  assert.equal(new Date(parisDayStart('2019-12-01')).toISOString(), '2019-11-30T23:00:00.000Z');
  // Écarts : pic simulé 90 contre 100 mesurés
  const t0 = parisDayStart('2019-12-01');
  const run = { gauges: [{ id: 'study0' }], series: [[[0, 0], [43200, 90], [86400 * 2, 0]]] };
  const ep = { t0, obs: { daily: [{ date: '2019-11-30', max: 5, mean: 5 }, { date: '2019-12-01', max: 100, mean: 40 }, { date: '2019-12-02', max: 20, mean: 10 }], curve: null }, csv: null };
  const r = episodeScores(run, ep);
  assert.ok(Math.abs(r.peakErr + 10) < 1e-9, `écart de pic ${r.peakErr}`);
  assert.equal(r.obsPeakDay, '2019-12-01');
  assert.ok(r.volErr != null);
  // Export HydroPortail en l/s
  const c = parseFlowCsv('Date (TU);Valeur (en l/s)\n23/11/2019 14:00;142609\n23/11/2019 15:00;150000');
  assert.equal(c.length, 2);
  assert.ok(Math.abs(c[0][1] - 142.609) < 1e-9 && c[0][0] === Date.parse('2019-11-23T14:00:00Z'));
  // Crues distinctes (5 jours d'écart au moins)
  const top = topFloods([['2008-12-14', 176], ['2008-12-15', 155], ['2019-11-23', 143]], 3);
  assert.deepEqual(top.map((x) => x.date), ['2008-12-14', '2019-11-23']);
});

await test('comparaison : indicateurs, analyse et carte des écarts', () => {
  // Hydrogramme triangulaire : pic 10 m³/s à 1 h, base 2 h → 36 000 m³
  const series = [[0, 0], [3600, 10], [7200, 0]];
  const hmax = new Float32Array([0, 0.2, 0.6, 1.2]);
  const m = runMetrics({ series, gaugeAreaKm2: 1, hmax, tmax: new Float32Array(4), vmax: new Float32Array([0, 0.3, 0.6, 1]), mask: null, cellKm2: 0.01, placeK: 2, placeSeries: [[0, 0], [3600, 0.6], [7200, 0]], rainMm: 72 });
  assert.equal(m.qPeak, 10);
  assert.equal(m.tPeak, 3600);
  assert.ok(Math.abs(m.volume - 36000) < 1e-6);
  assert.ok(Math.abs(m.share - 0.5) < 1e-9, 'part de pluie');
  assert.ok(Math.abs(m.a10 - 0.03) < 1e-9 && Math.abs(m.a50 - 0.02) < 1e-9 && Math.abs(m.a100 - 0.01) < 1e-9);
  assert.ok(Math.abs(durationAbove([[0, 0], [3600, 0.6], [7200, 0]], 0.3) - 3600) < 1e-6);
  const mk = (label, amc, f) => ({ label, p: { rainMm: 72, rainH: 3, amc }, m: { ...m, qPeak: m.qPeak * f, volume: m.volume * f, a10: m.a10 * f, hPlace: m.hPlace * f } });
  const txt = analyseComparison([mk('Sec', 1, 0.3), mk('Normal', 2, 1), mk('Saturé <b>', 3, 1.6)], { areaKm2: 1 }).join(' ');
  assert.ok(txt.includes('le plus défavorable sur tous les critères'), txt);
  assert.ok(txt.includes('très sensible'), 'sensibilité au sol');
  assert.ok(txt.includes('&lt;b&gt;') && !txt.includes('<b>'), 'nom échappé');
  const dur = analyseComparison(
    [
      { label: 'Orage', p: { rainMm: 90, rainH: 3, amc: 2 }, m: { ...m, qPeak: 40, volume: 1e5 } },
      { label: 'Longue', p: { rainMm: 130, rainH: 24, amc: 2 }, m: { ...m, qPeak: 20, volume: 3e5 } },
    ],
    { areaKm2: 20 },
  ).join(' ');
  assert.ok(dur.includes('c\'est elle qui donne le pic le plus fort') && dur.includes('volumes à stocker'), dur);
  const { codes, stats } = diffCodes(new Float32Array([0, 0.5, 0.5, 0.05]), new Float32Array([0, 0.52, 1.5, 0.4]), null);
  assert.deepEqual([codes[0], codes[1]], [0, 128]);
  assert.ok(codes[2] > 200 && codes[3] > 128);
  assert.equal(stats.newWet, 1);
});

console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent.');
process.exit(failures ? 1 : 0);
