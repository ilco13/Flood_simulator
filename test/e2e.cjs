// Test de bout en bout dans Chromium : chargement, simulation sur une petite zone, captures.
// Usage : node test/e2e.cjs <url> <dossier de sortie> [zone=view|basin] [res]
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');
const [url = 'http://localhost:4173/', outDir = '.', zone = 'view', res = '10', mm = '120', hours = '3', tail = '2', engine = 'auto'] =
  process.argv.slice(2);
(async () => {
  // Proxy éventuel de l'environnement (sans passer par l'option de Playwright, qui force
  // aussi localhost à passer par le proxy).
  const proxyArgs = process.env.HTTPS_PROXY
    ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1']
    : [];
  const browser = await chromium.launch({
    channel: 'chromium',
    args: [
      ...proxyArgs,'--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#res option'), null, { timeout: 180000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${outDir}/01-accueil.png` });
  console.log('moteur :', await page.textContent('#engine-info'));
  await page.click('details summary');
  await page.selectOption('#engine', engine);
  await page.selectOption('#zone', zone);
  await page.selectOption('#res', res);
  await page.fill('#rain-mm', mm);
  await page.fill('#rain-h', hours);
  await page.fill('#tail-h', tail);
  await page.dispatchEvent('#rain-h', 'input');
  console.log('résolution :', (await page.textContent('#res-info')).trim());
  const t0 = Date.now();
  await page.click('#run');
  let last = '';
  for (;;) {
    await page.waitForTimeout(3000);
    const st = await page.textContent('#progress .status');
    if (st !== last) console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s : ${st}`);
    last = st;
    if (/Terminé|Erreur|arrêtée/.test(st)) break;
    if (Date.now() - t0 > 20 * 60000) break;
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/02-fin.png` });
  console.log('résumé :', (await page.innerText('#summary')).slice(0, 1200));
  // Vue du maximum
  await page.click('#view-mode button[data-v="max"]');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/03-max.png` });
  // Clic sur la carte au centre
  await page.mouse.click(820, 400);
  await page.waitForTimeout(2500);
  console.log('sonde :', await page.innerText('#probe-info'));
  await page.screenshot({ path: `${outDir}/04-sonde.png` });
  // Mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/05-mobile.png` });
  console.log(errors.length ? `ERREURS : ${errors.join(' | ')}` : 'aucune erreur de page');
  await browser.close();
})();
