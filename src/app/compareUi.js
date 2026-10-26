import { AMC_NAME, DIFF_MAX, analyseComparison, buildDiffLut, diffCodes, diffColor, fmtDepthC, fmtDurC, fmtQ, fmtSurf, fmtVol, hazardOf, runMetrics } from '../sim/compare.js';
import { drawChart } from '../ui/chart.js';
import { loadRun } from '../data/runStore.js';
import { refreshWater } from '../map.js';
import { avalSettings, mainReceiver, renderAval } from './aval.js';
import { $, fmtH, fmtNum, state } from './core.js';
import { chooseEngine, currentGrid, estimateSeconds, fmtDur, params, updateRainInfo } from './params.js';
import { prog } from './progress.js';
import { renderArrows, renderCurrent } from './results.js';
import { startRun, stopRun } from './run.js';
import { fmtShort, openSaved } from './saved.js';
import { studyCands } from './study.js';
import { fmtBreak, renderMapLegend, setLayerVisible } from './ui.js';

/* ---------- Comparaison de scénarios ---------- */

export const CMP_KEY = 'flood-sim-compare';
export const CMP_COLORS = ['#e8590c', '#2b8a3e', '#1c7ed6', '#9c36b5'];
export const CMP_MAX = 4;
export const cmp = { list: [], running: false, cancel: false, result: null, hmax: new Map(), note: '' };
export const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function setupCompare() {
  $('cmp-soil').onclick = () => {
    const p = params();
    cmp.list = [1, 2, 3].map((amc) => ({ label: `Sol ${AMC_NAME[amc]}`, rainMm: p.rainMm, rainH: p.rainH, amc }));
    renderCmpList();
  };
  $('cmp-rain').onclick = () => {
    const sc = state.study?.rainScen || [];
    const orage = sc.find((x) => x.label === 'Orage centennal');
    const cent = sc.find((x) => x.label === 'Centennale');
    const amc = state.amc;
    if (orage && cent) {
      cmp.list = [
        { label: 'Orage centennal 3 h', rainMm: Math.round(orage.mm), rainH: orage.h, amc },
        { label: 'Pluie centennale 24 h', rainMm: Math.round(cent.mm), rainH: cent.h, amc },
      ];
      renderCmpList();
    } else {
      const p = params();
      cmp.list = [
        { label: 'Orage 3 h', rainMm: Math.round(p.rainMm * 0.75), rainH: 3, amc },
        { label: 'Pluie 24 h', rainMm: Math.round(p.rainMm), rainH: 24, amc },
      ];
      renderCmpList('Pluies de référence pas encore connues ici : cumuls tirés de la pluie saisie (75 % en 3 h), modifiables.');
    }
  };
  $('cmp-aval').onclick = () => {
    const p = params();
    const base = { rainMm: p.rainMm, rainH: p.rainH, amc: p.amc };
    const name = mainReceiver()?.receiver?.name || 'Rivière aval';
    cmp.list = [
      { label: `${name} sans crue`, ...base, aval: false },
      { label: `${name} en crue`, ...base, aval: true },
    ];
    renderCmpList(avalSettings().on ? '' : 'Débit de crue de la rivière : réglage « Rivière en aval » du lieu étudié (centennale estimée par défaut).');
  };
  $('cmp-add').onclick = () => {
    if (cmp.list.length >= CMP_MAX) return;
    const p = params();
    cmp.list.push({
      label: `${fmtShort(p.rainMm)} mm en ${fmtShort(p.rainH)} h, sol ${AMC_NAME[p.amc]}${p.aval ? ', rivière aval en crue' : ''}`,
      rainMm: p.rainMm,
      rainH: p.rainH,
      amc: p.amc,
      aval: !!p.aval,
    });
    renderCmpList();
  };
  $('cmp-run').onclick = () => (cmp.running ? cancelComparison() : runComparison());
  $('cmp-show').onclick = showCompareDock;
  $('cmp-min').onclick = () => {
    const min = $('compare-dock').classList.toggle('min');
    $('cmp-min').textContent = min ? '▴' : '▾';
    if (!min) drawCmpCharts();
  };
  $('cmp-close').onclick = () => {
    $('compare-dock').hidden = true;
    if (state.diff) renderCurrent();
  };
  $('cmp-diff').onclick = showDiff;
  for (const id of ['res', 'rain-shape', 'tail-h', 'engine', 'stop-peak']) $(id).addEventListener('input', updateCmpInfo);
  window.addEventListener('resize', () => !$('compare-dock').hidden && drawCmpCharts());
  try {
    cmp.result = JSON.parse(localStorage.getItem(CMP_KEY));
  } catch {
    cmp.result = null;
  }
  $('cmp-show').hidden = !cmp.result;
  renderCmpList();
}

export function renderCmpList(note = '') {
  cmp.note = note;
  const ol = $('cmp-list');
  ol.innerHTML = '';
  cmp.list.forEach((sc, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="cmp-top"><i class="cmp-dot" style="background:${CMP_COLORS[i]}"></i>
        <input class="cmp-name" type="text" maxlength="40" aria-label="Nom du scénario" />
        <button class="icon-ghost cmp-del" type="button" title="Retirer ce scénario">✕</button></div>
      <div class="cmp-row">
        <label>Cumul (mm)<input class="cmp-mm" type="number" min="1" max="1500" step="5" inputmode="decimal" /></label>
        <label>Durée (h)<input class="cmp-h" type="number" min="0.25" max="96" step="0.25" inputmode="decimal" /></label>
        <label>Sol<select class="cmp-amc"><option value="1">Sec</option><option value="2">Normal</option><option value="3">Saturé</option></select></label>
      </div>
      <label class="check small cmp-aval-row"><input type="checkbox" class="cmp-aval" /> Rivière aval en crue</label>`;
    const q = (c) => li.querySelector(c);
    q('.cmp-name').value = sc.label;
    q('.cmp-mm').value = sc.rainMm;
    q('.cmp-h').value = sc.rainH;
    q('.cmp-amc').value = String(sc.amc);
    q('.cmp-aval-row').hidden = !mainReceiver();
    q('.cmp-aval').checked = !!sc.aval;
    q('.cmp-aval').onchange = (e) => {
      sc.aval = e.target.checked;
      updateCmpInfo();
    };
    q('.cmp-name').oninput = (e) => (sc.label = e.target.value || `Scénario ${i + 1}`);
    q('.cmp-mm').oninput = (e) => {
      sc.rainMm = Math.max(1, Number(e.target.value) || 1);
      updateCmpInfo();
    };
    q('.cmp-h').oninput = (e) => {
      sc.rainH = Math.max(0.25, Number(e.target.value) || 1);
      updateCmpInfo();
    };
    q('.cmp-amc').onchange = (e) => {
      sc.amc = Number(e.target.value);
      updateCmpInfo();
    };
    q('.cmp-del').onclick = () => {
      cmp.list.splice(i, 1);
      renderCmpList();
    };
    q('.cmp-del').disabled = cmp.running;
    ol.appendChild(li);
  });
  $('cmp-add').disabled = cmp.list.length >= CMP_MAX;
  $('cmp-aval').hidden = !mainReceiver();
  updateCmpInfo();
}

export const cmpParams = (sc) => ({ ...params(), rainMm: sc.rainMm, rainH: Math.max(0.25, sc.rainH), amc: sc.amc });

export function updateCmpInfo() {
  if (cmp.running) return;
  const el = $('cmp-info');
  const pre = cmp.note ? `${cmp.note} ` : '';
  $('cmp-run').disabled = cmp.list.length < 2;
  if (cmp.list.length < 2) {
    el.textContent = `${pre}Choisissez un modèle ci-dessus, ou ajoutez au moins deux réglages.`;
    return;
  }
  const base = { ...params(), avalFrame: cmp.list.some((sc) => sc.aval) && !!mainReceiver() };
  const grid = currentGrid(base);
  if (!grid) {
    el.textContent = `${pre}Choisissez d'abord le lieu étudié.`;
    return;
  }
  const cells = grid.nx * grid.ny;
  const engine = chooseEngine(base, cells);
  if (!engine) {
    el.textContent = `${pre}Maille trop fine pour cet appareil : choisissez une maille plus grossière.`;
    return;
  }
  const tot = cmp.list.reduce((a, sc) => a + estimateSeconds(cmpParams(sc), cells, engine), 0);
  el.textContent =
    `${pre}${cmp.list.length} simulations l'une après l'autre (maille ${base.res} m) : ≈ ${fmtDur(tot)} de calcul en tout. ` +
    'Les autres réglages (maille, forme de la pluie, options) sont ceux du panneau.';
}

/** Reporte un scénario dans le panneau (pluie, humidité du sol) : le calcul part de là. */
export function applyScenario(sc) {
  $('rain-mm').value = sc.rainMm;
  $('rain-h').value = sc.rainH;
  state.amc = sc.amc;
  $('amc').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === sc.amc));
  if (sc.aval !== undefined && state.study) {
    avalSettings().on = !!sc.aval;
    renderAval();
  }
  $('rain-mm').dispatchEvent(new Event('input'));
  $('rain-h').dispatchEvent(new Event('input'));
  updateRainInfo();
}

/** Point de suivi principal : au droit du lieu, sur le cours d'eau retenu le plus grand. */
export function mainStudyGauge() {
  const streams = studyCands().filter((c) => c.kind === 'stream');
  if (!streams.length) return null;
  let bi = 0;
  streams.forEach((c, i) => c.areaKm2 > streams[bi].areaKm2 && (bi = i));
  return { id: `study${bi}`, name: `${streams[bi].name} (au droit du lieu)`, areaKm2: streams[bi].areaKm2 };
}

export function cancelComparison() {
  cmp.cancel = true;
  if (state.run?.running) stopRun();
}

export async function runComparison() {
  if (state.run?.running || cmp.list.length < 2) return;
  const p0 = params();
  const grid = currentGrid({ ...p0, avalFrame: cmp.list.some((sc) => sc.aval) && !!mainReceiver() });
  if (!grid) {
    prog.error('Choisissez d\'abord le lieu à étudier.');
    return;
  }
  const saved = { rainMm: p0.rainMm, rainH: p0.rainH, amc: p0.amc, aval: avalSettings().on };
  const list = cmp.list.map((sc) => ({ ...sc }));
  // Même zone de calcul pour tous les scénarios : avec la rivière aval si l'un d'eux la met en crue.
  state.forceAvalFrame = list.some((sc) => sc.aval);
  const mainG = mainStudyGauge();
  cmp.running = true;
  cmp.cancel = false;
  $('cmp-run').textContent = 'Arrêter la comparaison';
  $('cmp-run').classList.add('stop');
  $('cmp-run').disabled = false;
  $('compare-dock').hidden = true;
  const done = [];
  try {
    for (let i = 0; i < list.length && !cmp.cancel; i++) {
      const sc = list[i];
      $('cmp-info').textContent = `Scénario ${i + 1} sur ${list.length} : ${sc.label}…`;
      applyScenario(sc);
      const out = await startRun();
      if (!out?.ok) break;
      done.push(await collectScenario(out.run, sc, i, mainG));
    }
  } finally {
    cmp.running = false;
    state.forceAvalFrame = false;
    $('cmp-run').textContent = 'Lancer la comparaison';
    $('cmp-run').classList.remove('stop');
    applyScenario(saved);
  }
  if (done.length >= 2) {
    cmp.result = {
      created: Date.now(),
      place: (await state.run?.placeP?.catch(() => null)) || null,
      res: p0.res,
      gridKey: gridKeyOf(grid),
      gauge: mainG,
      scenarios: done,
      partial: done.length < list.length,
    };
    try {
      localStorage.setItem(CMP_KEY, JSON.stringify(cmp.result));
    } catch {
      /* stockage plein : la comparaison reste affichée */
    }
    $('cmp-show').hidden = false;
    updateCmpInfo();
    $('cmp-info').textContent = done.length < list.length ? 'Comparaison interrompue : scénarios terminés comparés.' : 'Comparaison terminée.';
    showCompareDock();
  } else {
    updateCmpInfo();
    $('cmp-info').textContent = 'Comparaison interrompue.';
  }
}

export const gridKeyOf = (g) => [g.xmin, g.ymin, g.nx, g.ny, g.dx].join(',');
export const thinSeries = (s) => s.map(([t, v]) => [Math.round(t), +v.toFixed(3)]);

export async function collectScenario(run, sc, i, mainG) {
  let gi = mainG ? run.gauges.findIndex((g) => g.id === mainG.id) : -1;
  if (gi < 0) gi = 0;
  const series = run.series[gi] || [[0, 0]];
  const area = mainG?.areaKm2 ?? studyCands().reduce((a, c) => a + c.areaKm2, 0);
  const m = runMetrics({
    series,
    gaugeAreaKm2: area,
    hmax: run.maxima.hmax,
    tmax: run.maxima.tmax,
    vmax: run.maxima.vmax,
    mask: state.data?.mask,
    cellKm2: (run.grid.dx * run.grid.dx) / 1e6,
    placeK: run.placeK,
    placeSeries: run.placeSeries,
    rainMm: run.params.rainMm,
  });
  await run.saveP?.catch(() => null);
  const id = run.savedId ?? `tmp-${Date.now()}-${i}`;
  cmp.hmax.set(id, run.maxima.hmax);
  return {
    label: sc.label,
    color: CMP_COLORS[i],
    p: { rainMm: run.params.rainMm, rainH: run.params.rainH, amc: run.params.amc, capInf: !!run.params.capInf, avalQ: run.params.aval?.Q || 0 },
    m,
    id,
    saved: !!run.savedId,
    gaugeName: run.gauges[gi]?.name || '',
    auto: !!run.autoStopped,
    tEnd: run.totalTime,
    q: thinSeries(series),
    h: thinSeries(run.placeSeries || []),
  };
}

export function drawCmpCharts() {
  const r = cmp.result;
  if (!r) return;
  const scs = r.scenarios;
  const xMax = Math.max(...scs.map((s) => s.tEnd)) / 3600;
  const xFormat = (x) => `${+x.toFixed(1)} h`;
  drawChart($('cmp-hydro'), {
    series: scs.map((s) => ({ name: s.label, color: s.color, width: 2, points: s.q.map(([t, q]) => [t / 3600, q]) })),
    xMax,
    xFormat,
  });
  const wet = scs.some((s) => s.m.hPlace >= 0.01);
  $('cmp-place').hidden = !wet;
  $('cmp-place-note').textContent = wet ? '' : 'Le point étudié reste hors d\'eau dans tous les scénarios.';
  if (wet)
    drawChart($('cmp-place'), {
      series: scs.map((s) => ({ name: s.label, color: s.color, width: 2, points: s.h.map(([t, h]) => [t / 3600, h]) })),
      xMax,
      xFormat,
    });
}

export function showCompareDock() {
  const r = cmp.result;
  if (!r) return;
  const dock = $('compare-dock');
  dock.hidden = false;
  if (window.matchMedia('(max-width: 760px)').matches) $('panel').classList.add('collapsed');
  dock.classList.remove('min');
  $('cmp-min').textContent = '▾';
  const scs = r.scenarios;
  $('cmp-status').textContent = `${r.place ? `${r.place} · ` : ''}maille ${r.res} m${r.partial ? ' · partielle' : ''}`;
  $('cmp-legend').innerHTML = scs.map((s) => `<span><i style="background:${s.color}"></i>${escHtml(s.label)}</span>`).join('');
  $('cmp-hydro-title').textContent = `Débit : ${scs[0].gaugeName || 'point de suivi principal'} (m³/s)`;
  drawCmpCharts();

  // Tableau : une colonne par scénario ; la valeur la plus défavorable est surlignée.
  const rows = [
    ['Pluie', (s) => `${fmtNum(s.p.rainMm)} mm en ${fmtShort(s.p.rainH)} h<small>${fmtNum(s.p.rainMm / s.p.rainH, 1)} mm/h en moyenne</small>`],
    ['Sol', (s) => AMC_NAME[s.p.amc]],
    ...(scs.some((s) => s.p.avalQ) ? [['Rivière aval', (s) => (s.p.avalQ ? `en crue<small>${fmtQ(s.p.avalQ)}</small>` : 'normale')]] : []),
    ['Pic de débit', (s) => `${fmtQ(s.m.qPeak)}<small>à ${fmtH(s.m.tPeak)}</small>`, (s) => s.m.qPeak],
    ['Volume écoulé', (s) => `${fmtVol(s.m.volume)}${s.m.share != null ? `<small>${fmtNum(Math.min(1, s.m.share) * 100)} % de la pluie</small>` : ''}`, (s) => s.m.volume],
    ['Inondé > 10 cm', (s) => fmtSurf(s.m.a10), (s) => s.m.a10],
    ['Inondé > 50 cm', (s) => fmtSurf(s.m.a50), (s) => s.m.a50],
    ['Inondé > 1 m', (s) => fmtSurf(s.m.a100), (s) => s.m.a100],
    ['Point étudié', (s) => (s.m.hPlace >= 0.01 ? `${fmtDepthC(s.m.hPlace)}${s.m.tPlace != null ? `<small>à ${fmtH(s.m.tPlace)}</small>` : ''}` : 'hors d\'eau'), (s) => s.m.hPlace],
    ['Plus de 10 cm pendant', (s) => (s.m.wetPlace > 0 ? `≈ ${fmtDurC(s.m.wetPlace)}` : '—'), (s) => s.m.wetPlace],
    ['Aléa au point', (s) => hazardOf(s.m.hPlace, s.m.vPlace) || '—'],
    ['Durée simulée', (s) => `${fmtH(s.tEnd)}${s.auto ? '<small>arrêt après le pic</small>' : ''}`],
  ];
  let html = `<thead><tr><th></th>${scs.map((s) => `<th><i style="background:${s.color}"></i>${escHtml(s.label)}</th>`).join('')}</tr></thead><tbody>`;
  for (const [name, f, val] of rows) {
    let wi = -1;
    if (val) {
      const vs = scs.map(val);
      const mx = Math.max(...vs);
      if (mx > 0 && vs.some((v) => v < mx * 0.97)) wi = vs.indexOf(mx);
    }
    html += `<tr><th>${name}</th>${scs.map((s, i) => `<td${i === wi ? ' class="worst"' : ''}>${f(s)}</td>`).join('')}</tr>`;
  }
  $('cmp-table').innerHTML = `${html}</tbody>`;

  const parts = analyseComparison(scs, { areaKm2: r.gauge?.areaKm2 ?? 1 });
  if (scs.some((s) => s.auto)) parts.push('<small>Calculs arrêtés après le pic de crue : volumes et durées ne comptent pas toute la décrue.</small>');
  parts.push('<small>Modèle simplifié : comparez les scénarios entre eux plutôt que de lire les chiffres comme une prévision.</small>');
  $('cmp-analysis').innerHTML = parts.map((t) => `<div class="cmp-par">${t}</div>`).join('');

  const open = $('cmp-open');
  open.innerHTML = '';
  scs.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip-btn';
    b.innerHTML = `<i class="cmp-dot" style="background:${s.color}"></i>${escHtml(s.label)}`;
    b.disabled = !s.saved;
    b.title = s.saved ? 'Afficher cette simulation sur la carte' : 'Simulation non enregistrée';
    b.onclick = () => openSaved(s.id);
    open.appendChild(b);
  });
  for (const [id, def] of [['cmp-a', 0], ['cmp-b', scs.length - 1]]) {
    const sel = $(id);
    sel.innerHTML = scs.map((s, i) => `<option value="${i}">${escHtml(s.label)}</option>`).join('');
    sel.value = String(def);
  }
  $('cmp-diff-info').textContent = '';
}

export async function hmaxOf(s) {
  if (cmp.hmax.has(s.id)) return cmp.hmax.get(s.id);
  if (!s.saved) throw new Error('simulation non enregistrée');
  const r = await loadRun(s.id);
  cmp.hmax.set(s.id, r.maxima.hmax);
  return r.maxima.hmax;
}

/** Carte des écarts de hauteur maximale entre deux scénarios (B − A). */
export async function showDiff() {
  const r = cmp.result;
  const scs = r?.scenarios;
  if (!scs) return;
  const a = scs[Number($('cmp-a').value)];
  const b = scs[Number($('cmp-b').value)];
  const info = $('cmp-diff-info');
  if (a === b) {
    info.textContent = 'Choisissez deux scénarios différents.';
    return;
  }
  if (state.run?.running) {
    info.textContent = 'Attendez la fin du calcul en cours.';
    return;
  }
  info.textContent = 'Préparation de la carte des écarts…';
  try {
    const hA = await hmaxOf(a);
    const hB = await hmaxOf(b);
    if (!state.run?.grid || gridKeyOf(state.run.grid) !== r.gridKey) {
      const target = [b, a].find((s) => s.saved);
      if (!target) throw new Error('simulations non enregistrées');
      await openSaved(target.id);
    }
    if (!state.run?.water || gridKeyOf(state.run.grid) !== r.gridKey) throw new Error('grille différente');
    const { codes, stats } = diffCodes(hA, hB, state.data?.mask);
    state.diff = { a, b };
    state.lastFlow = null;
    renderArrows();
    state.run.water.draw(codes, buildDiffLut());
    refreshWater(state.map);
    setLayerVisible('water', true);
    renderDiffLegend(a, b);
    $('time-label').textContent = 'écarts';
    const c = (state.run.grid.dx * state.run.grid.dx) / 1e6;
    info.innerHTML =
      `En rouge, plus d'eau avec « ${escHtml(b.label)} » ; en bleu, moins ; en gris, écart de moins de 5 cm. ` +
      `Inondé (> 10 cm) seulement avec « ${escHtml(b.label)} » : <strong>${stats.newWet ? fmtSurf(stats.newWet * c) : 'aucune zone'}</strong>` +
      (stats.newDry ? ` ; seulement avec « ${escHtml(a.label)} » : <strong>${fmtSurf(stats.newDry * c)}</strong>` : '') +
      `. Touchez la barre de temps pour revenir à l'affichage normal.`;
  } catch (e) {
    console.error(e);
    info.textContent = `Carte des écarts impossible : ${e.message || e}.`;
  }
}

export function endDiff() {
  state.diff = null;
  renderMapLegend();
}

export function renderDiffLegend(a, b) {
  const el = $('map-legend');
  el.hidden = false;
  const stops = [DIFF_MAX, 0.5, 0.2, 0.05, -0.05, -0.2, -0.5, -DIFF_MAX];
  const n = stops.length;
  const rgb = (c) => `rgb(${c.join(',')})`;
  let bar = '';
  for (let i = 0; i < n - 1; i++) {
    const top = stops[i];
    const bot = stops[i + 1];
    const bg = top > 0 && bot < 0 ? 'rgb(150,160,170)' : `linear-gradient(to bottom, ${rgb(diffColor(top))}, ${rgb(diffColor(bot))})`;
    bar += `<span class="ml-seg" style="background:${bg}"></span>`;
  }
  const lab = (d) => `${d > 0 ? '+' : '−'}${fmtBreak(Math.abs(d))}`;
  const labels = stops.map((d, i) => `<span style="top:${(i / (n - 1)) * 100}%">${i === 0 ? '≥ ' : i === n - 1 ? '≤ ' : ''}${lab(d)}</span>`).join('');
  el.innerHTML =
    `<div class="ml-title">Écart de hauteur max<br><small>${escHtml(b.label)}<br>moins ${escHtml(a.label)}</small></div>` +
    `<div class="ml-scale"><div class="ml-bar">${bar}</div><div class="ml-labels">${labels}</div></div>`;
}
