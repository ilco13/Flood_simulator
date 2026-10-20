// Vue 3D dans Chromium : simulation sur la zone affichée puis captures en relief.
// Usage : node test/e2e-3d.cjs <url avec #zoom/lat/lon> <dossier> <res> <mm> <h> <après h> <vue 3D #z/lat/lon/cap/inclinaison>
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const [url, outDir = '.', res = '5', mm = '139', hours = '3', tail = '1', view3d] = process.argv.slice(2);
(async () => {
  const proxyArgs = process.env.HTTPS_PROXY
    ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1']
    : [];
  const browser = await chromium.launch({
    channel: 'chromium',
    args: [...proxyArgs, '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/ERR_|status of/.test(m.text()) && console.log('[err]', m.text().slice(0, 300)));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#res option'), null, { timeout: 180000 });
  await page.click('details summary');
  await page.selectOption('#engine', 'cpu');
  await page.selectOption('#zone', 'view');
  await page.selectOption('#res', res);
  await page.fill('#rain-mm', mm);
  await page.fill('#rain-h', hours);
  await page.fill('#tail-h', tail);
  await page.dispatchEvent('#rain-h', 'input');
  await page.click('#run');
  const t0 = Date.now();
  for (;;) {
    await page.waitForTimeout(5000);
    const st = await page.textContent('#progress .status');
    if (/Terminé|Erreur|arrêtée/.test(st)) { console.log(st); break; }
    if (Date.now() - t0 > 30 * 60000) break;
  }
  await page.click('#view-mode button[data-v="max"]');
  await page.click('.ctrl-3d');
  await page.waitForTimeout(1500);
  await page.waitForTimeout(1500);
  if (view3d) {
    const [z, lat, lon, bearing, pitch] = view3d.replace('#', '').split('/').map(Number);
    await page.evaluate((v) => window.floodApp.map.jumpTo(v), { zoom: z, center: [lon, lat], bearing, pitch });
  }
  await page.waitForTimeout(30000);
  console.log('diag :', await page.evaluate(() => {
    const s = window.floodApp;
    const m = s.water3d.mesh;
    let wet = 0;
    if (m) for (const v of m.q) if (v > 0) wet++;
    return JSON.stringify({ is3d: s.is3d, terrain: !!s.map.getTerrain(), mesh: m && [m.mx, m.my], wetVertices: wet, ready: s.water3d.ready, pitch: s.map.getPitch() });
  }));
  await page.screenshot({ path: `${outDir}/3d-max.png` });
  await page.evaluate(() => {
    const p = document.getElementById('panel');
    p.style.display = 'none';
    window.dispatchEvent(new Event('resize'));
  });
  await page.evaluate(() => window.floodApp.map.resize());
  await page.waitForTimeout(20000);
  await page.screenshot({ path: `${outDir}/3d-max-plein.png` });
  console.log(errors.length ? `ERREURS : ${errors.join(' | ')}` : 'aucune erreur de page');
  await browser.close();
})();
