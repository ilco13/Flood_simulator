// Compare les solveurs GPU et CPU dans Chromium (WebGPU via SwiftShader).
// Prérequis : serveur de dev Vite sur http://localhost:5173
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
(async () => {
  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.goto('http://localhost:5173/');
  const out = await page.evaluate(async () => {
    const { getGpuDevice, GpuSolver } = await import('/src/sim/gpuSolver.js');
    const { CpuBackend, simulate } = await import('/src/sim/driver.js');
    const { makeHyetograph } = await import('/src/hydrology/rain.js');
    const gpu = await getGpuDevice();
    if (!gpu) return { error: 'pas de GPU' };
    // Vallée en V inclinée avec une cuvette, sol hétérogène
    const nx = 96, ny = 64, dx = 10, N = nx * ny;
    const z = new Float32Array(N), S = new Float32Array(N), n = new Float32Array(N);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        z[k] = 200 - 0.01 * i * dx + 0.08 * Math.abs(j - 32) * dx - 3 * Math.exp(-((i - 60) ** 2 + (j - 32) ** 2) / 30);
        S[k] = (i + j) % 7 === 0 ? 20 : 60;
        n[k] = j % 2 ? 0.04 : 0.08;
      }
    const gauges = [{ cells: Int32Array.from({ length: 20 }, (_, m) => (22 + m) * nx + 80), wx: new Float32Array(20).fill(dx), wy: new Float32Array(20) }];
    const hyeto = makeHyetograph({ totalMm: 80, durationH: 1, shape: 'desbordes' });
    const opts = { hyeto, totalTime: 2 * 3600, gaugeEvery: 300, snapshotEvery: 3600 };
    const qc = [], qg = [];
    const cpu = new CpuBackend({ nx, ny, dx, z, S, manning: n }, gauges);
    const rc = await simulate(cpu, { ...opts, onGauge: (t, Q) => qc.push(Q[0]) });
    const g = new GpuSolver(gpu.device, { nx, ny, dx, z, S, manning: n }, gauges);
    const rg = await simulate(g, { ...opts, onGauge: (t, Q) => qg.push(Q[0]) });
    const hc = await cpu.readDepth(), hg = await g.readDepth();
    let dmax = 0, hmaxc = 0;
    for (let k = 0; k < N; k++) { dmax = Math.max(dmax, Math.abs(hc[k] - hg[k])); hmaxc = Math.max(hmaxc, hc[k]); }
    let dmaxMax = 0;
    for (let k = 0; k < N; k++) dmaxMax = Math.max(dmaxMax, Math.abs(rc.maxima.hmax[k] - rg.maxima.hmax[k]));
    const peakC = Math.max(...qc), peakG = Math.max(...qg);
    return { stepsCpu: cpu.steps, stepsGpu: g.steps, hmax: hmaxc, maxDiffH: dmax, maxDiffHmax: dmaxMax, peakC, peakG, adapter: gpu.label };
  });
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  const ok = out.maxDiffHmax < 0.02 && Math.abs(out.peakC - out.peakG) / out.peakC < 0.03;
  console.log(ok ? 'GPU ≈ CPU : OK' : 'ÉCART GPU/CPU');
  process.exit(ok ? 0 : 1);
})();
