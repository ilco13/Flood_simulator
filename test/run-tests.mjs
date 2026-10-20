// Tests numériques du modèle (node test/run-tests.mjs).
import assert from 'node:assert/strict';
import { makeHyetograph } from '../src/hydrology/rain.js';
import { runoffMm, runoffRate, retentionMm, adjustCn } from '../src/hydrology/scs.js';
import { CpuBackend, simulate } from '../src/sim/driver.js';
import { drainageLabels, basinMask } from '../src/hydrology/terrain.js';

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
  for (const shape of ['uniform', 'desbordes', 'early', 'late']) {
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

console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent.');
process.exit(failures ? 1 : 0);
