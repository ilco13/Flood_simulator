// Tests de bout en bout dans Chromium, sur des lieux de référence en France.
// Prérequis : application construite et servie (npm run build && npx vite preview --port 4173),
// accès réseau aux services IGN et Météo-France.
// Usage : node test/e2e.cjs [url] [lieux séparés par des virgules] [dossier des captures]
// Vérifie : surface du bassin, fin du calcul (arrêt après le pic), bilan de masse, débits,
// cohérence de la coupe avec la simulation, rivière aval (débit sous la confluence).
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const SITES = {
  // Surfaces de référence : Hub'Eau (stations) ; Torse : surface mesurée par l'application.
  touloubre: { name: 'Touloubre à la Barben', lon: 5.175488, lat: 43.628894, area: 212.2, river: 'Touloubre', res: '50' },
  weiss: { name: 'Weiss à Orbey', lon: 7.161617, lat: 48.126926, area: 33.6, river: 'Weiss', res: '25' },
  roya: { name: 'Roya à Fontan', lon: 7.554355, lat: 44.002656, area: 299, river: 'Roya', res: '50' },
  emboite: { name: 'Torse à Aix, calcul en deux temps (bassin 25 m, zone fine 2 km à 10 m)', lon: 5.4672, lat: 43.518, area: 20.7, river: 'Torse', res: '25', nest: { r: '1000', res: '10' } },
  torse: { name: 'Torse à Aix (Arc en aval)', lon: 5.4672, lat: 43.518, area: 20.7, river: 'Torse', res: '25', aval: { river: 'Arc', minAreaKm2: 250, station: 'Y402201001' } },
};

const [url = 'http://localhost:4173/', which = Object.keys(SITES).join(','), outDir = ''] = process.argv.slice(2);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

async function runSite(browser, key) {
  const site = SITES[key];
  const checks = [];
  const check = (ok, what) => checks.push({ ok: !!ok, what });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
  try {
    await page.goto(url);
    for (let i = 0; i < 90 && !(await page.evaluate(() => !!window.floodApp?.ctrl3d)); i++) await page.waitForTimeout(1000);
    await page.evaluate(() => localStorage.clear());
    await page.evaluate(([lon, lat]) => window.floodApp.map.jumpTo({ center: [lon, lat], zoom: 15 }), [site.lon, site.lat]);
    await page.waitForTimeout(1500);
    await page.click('#catch-pick');
    const xy = await page.evaluate(([lon, lat]) => window.floodApp.map.project([lon, lat]), [site.lon, site.lat]);
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + xy.x, box.y + xy.y);
    for (let i = 0; i < 150; i++) {
      await page.waitForTimeout(2000);
      if (await page.evaluate(() => !window.floodApp.catchWorker && !!window.floodApp.study)) break;
    }
    const cands = await page.evaluate(() => window.floodApp.study.cands.map((c) => ({ name: c.name, kind: c.kind, area: c.areaKm2, receiver: c.receiver && { name: c.receiver.name, area: c.receiver.areaKm2 } })));
    const main = cands.find((c) => c.kind === 'stream' && norm(c.name).includes(norm(site.river)));
    check(main, `cours d'eau « ${site.river} » trouvé`);
    const ratio = main ? main.area / site.area : 0;
    check(ratio > 0.85 && ratio < 1.2, `surface du bassin ${main ? main.area.toFixed(1) : '?'} km² (référence ${site.area}, rapport ${ratio.toFixed(2)})`);
    if (site.aval) {
      const r = main?.receiver;
      check(r && norm(r.name).includes(norm(site.aval.river)) && r.area >= site.aval.minAreaKm2, `rivière aval ${r ? `${r.name}, ${r.area.toFixed(0)} km²` : 'non trouvée'}`);
      await page.check('#aval-on');
      // Crues mesurées à une station de la rivière (Hub'Eau), à la place de la formule
      for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.floodApp.study.avalStation)); i++) await page.waitForTimeout(1000);
      const st = await page.evaluate(() => window.floodApp.study.avalStation?.station);
      if (site.aval.station) check(st && st.code === site.aval.station && st.years >= 15, `station de la rivière aval : ${st ? `${st.name}, ${st.years} ans, centennale ${st.q100.toFixed(0)} m³/s` : 'non trouvée'}`);
    }
    // Simulation : 80 mm en 3 h, maille grossière, arrêt après le pic
    await page.fill('#rain-mm', '80');
    await page.fill('#rain-h', '3');
    await page.dispatchEvent('#rain-h', 'input');
    if (site.nest) {
      await page.check('#nest-on');
      await page.dispatchEvent('#nest-on', 'change');
      await page.selectOption('#nest-r', site.nest.r);
      await page.selectOption('#nest-res', site.nest.res);
    }
    await page.selectOption('#res', site.res);
    await page.dispatchEvent('#res', 'input');
    await page.click('#run');
    for (let i = 0; i < 900; i++) {
      await page.waitForTimeout(2000);
      if (/Terminé|Arrêtée|rreur/.test(await page.textContent('#map-status'))) break;
    }
    const status = await page.textContent('#map-status');
    check(/pic de crue passé/.test(status) || (site.nest && /Terminé/.test(status)), `fin du calcul : ${status.trim()}`);
    if (site.nest) {
      const n = await page.evaluate(() => ({ nest: window.floodApp.run.nest, dx: window.floodApp.run.grid.dx }));
      check(n.nest && n.nest.inlets > 0 && n.dx === Number(site.nest.res), `zone fine à ${n.dx} m alimentée par ${n.nest?.inlets ?? 0} entrées d'eau`);
    }
    const res = await page.evaluate(() => {
      const a = window.floodApp;
      const run = a.run;
      const mass = /Bilan de masse : erreur ([-\d,]+) %/.exec(document.querySelector('#summary').textContent)?.[1];
      let hmax = 0;
      for (const v of run.maxima.hmax) if (v > hmax) hmax = v;
      return {
        mass: mass == null ? null : Number(mass.replace(',', '.')),
        hmax,
        gauges: run.gauges.map((g, i) => ({ id: g.id, name: g.name, peak: run.series[i].reduce((m, p) => Math.max(m, p[1]), 0) })),
        avalQ: run.params.aval?.Q ?? null,
        structs: (run.structureRes || []).map((r) => ({ q: r.qmax, cap: r.qcap, status: r.status, name: r.name, a: r.a, b: r.b, area: r.areaKm2 })),
      };
    });
    check(res.mass == null || Math.abs(res.mass) < 0.01, `bilan de masse ${res.mass ?? 'non mesuré (GPU)'} %`);
    check(Number.isFinite(res.hmax) && res.hmax > 0.1 && res.hmax < 30, `hauteur maximale ${res.hmax.toFixed(2)} m`);
    // Ponts et buses : débits finis et cohérents avec la capacité
    const st = res.structs;
    const bad = st.filter((r) => !Number.isFinite(r.q) || r.q < 0);
    const cnt = (k) => st.filter((r) => r.status === k).length;
    check(!bad.length, `ponts et buses : ${st.length} repérés (${cnt('over')} route submergée, ${cnt('full')} en charge, ${cnt('ok')} sans débordement)${bad.length ? ` ; ${bad.length} débits incohérents` : ''}`);
    const g0 = res.gauges.find((g) => g.id.startsWith('study') && norm(g.name).includes(norm(site.river)));
    check(g0 && g0.peak > 1, `débit au droit du lieu ${g0 ? g0.peak.toFixed(1) : '?'} m³/s`);
    if (site.aval) {
      const ga = res.gauges.find((g) => g.id === 'aval');
      check(ga && res.avalQ && ga.peak > 0.95 * res.avalQ, `rivière aval : ${ga ? ga.peak.toFixed(0) : '?'} m³/s sous la confluence pour ${res.avalQ} injectés`);
    }
    // Coupe au lieu : la hauteur dessinée reste proche de la hauteur simulée
    await page.click('#section-place');
    const xy2 = await page.evaluate(([lon, lat]) => window.floodApp.map.project([lon, lat]), [site.lon, site.lat]);
    await page.mouse.click(box.x + xy2.x, box.y + xy2.y);
    await page.waitForTimeout(2500);
    await page.click('#show-max');
    await page.waitForTimeout(2500);
    const sec = await page.evaluate(() => {
      const s = window.floodApp.section;
      if (!s?.helper) return null;
      let worst = 0;
      let simMax = 0;
      const pts = s.sample.pts;
      const cell = window.floodApp.run.grid.dx;
      const step = pts.length > 1 ? pts[1].d - pts[0].d : 1;
      const r = Math.max(1, Math.round(cell / step));
      for (let i = 0; i < pts.length; i++) {
        const inf = s.helper.info(i);
        simMax = Math.max(simMax, pts[i].hmax);
        // Hauteur simulée de référence : la plus forte à moins d'une maille (le dessin peut
        // déborder d'une maille sur le terrain fin plus bas) ; écart toléré +30 cm ou +50 %.
        let h = 0;
        for (let m = Math.max(0, i - r); m <= Math.min(pts.length - 1, i + r); m++) h = Math.max(h, pts[m].hmax);
        worst = Math.max(worst, inf.maxDepth - (h + Math.max(0.3, 0.5 * h)));
      }
      return { worst, simMax };
    });
    check(sec && sec.worst < 1.0, `coupe : excès de hauteur dessinée ${sec ? sec.worst.toFixed(2) : '?'} m (max simulé ${sec ? sec.simMax.toFixed(2) : '?'} m)`);
    if (outDir) await page.screenshot({ path: `${outDir}/${key}.png` });
  } catch (e) {
    check(false, `erreur : ${String(e.message || e).slice(0, 200)}`);
  }
  check(!errors.length, `erreurs JavaScript : ${errors.length ? errors.join(' | ') : 'aucune'}`);
  await page.close();
  return checks;
}

(async () => {
  const proxyArgs = process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=localhost;127.0.0.1'] : [];
  const browser = await chromium.launch({ args: proxyArgs });
  let failed = 0;
  for (const key of which.split(',')) {
    if (!SITES[key]) {
      console.log(`lieu inconnu : ${key}`);
      failed++;
      continue;
    }
    const t0 = Date.now();
    const checks = await runSite(browser, key);
    console.log(`\n${SITES[key].name} (${Math.round((Date.now() - t0) / 1000)} s)`);
    for (const c of checks) {
      console.log(`  ${c.ok ? 'ok  ' : 'ÉCHEC'} ${c.what}`);
      if (!c.ok) failed++;
    }
  }
  await browser.close();
  console.log(failed ? `\n${failed} vérification(s) en échec` : '\nTous les lieux de référence passent.');
  process.exit(failed ? 1 : 0);
})();
