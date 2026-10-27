import { SnapshotStore, quantize } from '../sim/snapshots.js';
import { WaterCanvas } from '../render/water.js';
import { deleteRun, exportRun, formatSize, listRuns, loadRun, packRun, renameRun, saveRun } from '../data/runStore.js';
import { fitBoundsOf, setWaterCanvas } from '../map.js';
import { gridCornersWgs, toL93, toWgs } from '../geo.js';
import { $, fmtNum, state } from './core.js';
import { ensureWater3d } from './mapUi.js';
import { params, updateRainInfo } from './params.js';
import { STEPS, prog } from './progress.js';
import { drawHydro, renderCurrent, stopPlay } from './results.js';
import { showContext } from './run.js';
import { studyCands } from './study.js';
import { setLayerVisible, setViewMode, showResults } from './ui.js';

/* ---------- Simulations enregistrées ---------- */

export const AMC_LABEL = { 1: 'sol sec', 2: 'sol normal', 3: 'sol saturé' };
export const fmtShort = (v) => String(+Number(v).toFixed(2)).replace('.', ',');

// La carte se charge de façon asynchrone : l'ouverture d'une simulation doit l'attendre.
export let resolveMapReady;
export const mapReady = new Promise((r) => (resolveMapReady = r));

export function runName(p, partial, place) {
  const where = place || (p.zone === 'basin' ? 'Haute vallée de l\'Arc' : 'Zone affichée');
  const mesh = p.nestOf ? `${p.res} m autour du lieu (bassin à ${p.nestOf.coarse} m)` : `${p.res} m`;
  return `${where} · ${fmtShort(p.rainMm)} mm en ${fmtShort(p.rainH)} h · ${AMC_LABEL[p.amc]}${p.aval ? ` · rivière aval ${fmtNum(p.aval.Q)} m³/s` : ''} · ${mesh}${partial ? ' (partielle)' : ''}`;
}

/**
 * Nom lisible du lieu simulé : « Haute vallée de l'Arc » pour le bassin entier, sinon le
 * lieu-dit le plus proche du centre (tuiles Plan IGN déjà chargées) et la commune
 * (géocodage inverse IGN, sans numéro de rue).
 */
export async function findPlaceName(grid, p) {
  if (p.zone === 'basin') return 'Haute vallée de l\'Arc';
  const study = p.zone === 'study' ? state.study : null;
  const [lon, lat] = study ? study.houseWgs : toWgs(grid.xmin + (grid.nx * grid.dx) / 2, grid.ymax - (grid.ny * grid.dx) / 2);
  // Lieu étudié : nom du principal cours d'eau retenu en tête.
  const stream = study && studyCands().find((c) => c.kind === 'stream' && c.named)?.name;
  const place = await findLocality(grid, lon, lat, !!study);
  return stream ? (place ? `${stream} · ${place}` : stream) : place;
}

export async function findLocality(grid, lon, lat, near) {
  const toM = (a, b) => {
    const dx = (a[0] - b[0]) * 111320 * Math.cos((lat * Math.PI) / 180);
    const dy = (a[1] - b[1]) * 110540;
    return Math.hypot(dx, dy);
  };
  // Lieu-dit le plus proche (dans un rayon de la demi-zone, 2 km au plus)
  let locality = null;
  try {
    const radius = near ? 1500 : Math.min(2000, (Math.max(grid.nx, grid.ny) * grid.dx) / 2 + 200);
    let best = Infinity;
    // Poids : une commune proche l'emporte, puis les lieux-dits bien visibles sur la carte
    // (typographie A), puis les petits lieux-dits ; résidences et monuments en dernier recours.
    const weight = (pr) => {
      const symbo = String(pr.symbo || '');
      const typo = String(pr.txt_typo || '');
      if (symbo.startsWith('COMMUNE')) return 0.3;
      if (symbo.startsWith('LIEU-DIT')) return typo.startsWith('TYPO_A') ? 0.5 : 1;
      return 4;
    };
    for (const f of state.map.querySourceFeatures('plan_ign', { sourceLayer: 'toponyme_localite_ponc' })) {
      const name = f.properties?.texte;
      if (!name || f.geometry.type !== 'Point') continue;
      const d = toM(f.geometry.coordinates, [lon, lat]);
      if (d > radius) continue;
      const score = d * weight(f.properties);
      if (score < best) {
        best = score;
        locality = name;
      }
    }
  } catch {
    // tuiles indisponibles : on se contente de la commune
  }
  let city = null;
  try {
    const res = await fetchWithTimeout(
      `https://data.geopf.fr/geocodage/reverse?lon=${lon}&lat=${lat}&index=address&limit=1`,
      6000,
    );
    city = (await res.json()).features?.[0]?.properties?.city || null;
  } catch {
    // hors ligne
  }
  if (locality && city && locality.toLowerCase() !== city.toLowerCase()) return `${locality} (${city})`;
  return locality || city || null;
}

export async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function autoSave(run, partial) {
  if (run.restored || !run.maxima || !run.store.length) return;
  let note = $('save-note');
  if (!note) {
    note = document.createElement('p');
    note.id = 'save-note';
    $('summary').after(note);
  }
  note.className = 'hint';
  note.textContent = 'Enregistrement de la simulation…';
  try {
    const rec = await packRun({
      name: runName(run.params, partial, await Promise.race([run.placeP, new Promise((r) => setTimeout(() => r(null), 5000))])),
      params: run.params,
      grid: run.grid,
      totalTime: run.totalTime,
      tEnd: run.tEnd ?? run.totalTime,
      store: run.store,
      series: run.series,
      gauges: run.gauges,
      maxima: run.maxima,
      dem: state.data.dem,
      zSim: state.data.z,
      outline: state.data.outline,
      rivers: state.data.rivers,
      summary: $('summary').innerHTML,
      warnings: state.data.warnings,
    });
    await saveRun(rec);
    run.savedId = rec.meta.id;
    note.textContent = `Simulation enregistrée dans ce navigateur (${formatSize(rec.meta.size)}).`;
  } catch (e) {
    console.error(e);
    note.className = 'hint warn';
    note.textContent = `Enregistrement impossible : ${e.message || e}. Supprimez d'anciennes simulations pour libérer de la place.`;
  }
  refreshSaved();
}

export async function refreshSaved() {
  const ul = $('saved-list');
  let runs = [];
  try {
    runs = await listRuns();
  } catch {
    ul.innerHTML = '<li class="empty">Stockage indisponible dans ce navigateur (navigation privée ?).</li>';
    return;
  }
  if (!runs.length) {
    ul.innerHTML = '<li class="empty">Aucune simulation enregistrée pour l\'instant.</li>';
    return;
  }
  ul.innerHTML = '';
  for (const r of runs) {
    const li = document.createElement('li');
    if (state.run?.savedId === r.id) li.className = 'current';
    const d = new Date(r.created);
    li.innerHTML = `<div class="s-name"></div>
      <div class="s-meta">${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${formatSize(r.size)}${r.imported ? ' · importée' : ''}</div>
      <div class="s-actions">
        <button class="open">Ouvrir</button><button class="exp">Exporter</button>
        <button class="ren">Renommer</button><button class="del">Supprimer</button>
      </div>`;
    li.querySelector('.s-name').textContent = r.name;
    li.querySelector('.open').onclick = () => openSaved(r.id);
    li.querySelector('.exp').onclick = async () => {
      const blob = await exportRun(r.id);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${r.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase()}.crue`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    };
    li.querySelector('.ren').onclick = async () => {
      const name = prompt('Nouveau nom :', r.name);
      if (name && name.trim()) {
        await renameRun(r.id, name.trim());
        refreshSaved();
      }
    };
    li.querySelector('.del').onclick = async () => {
      if (!confirm(`Supprimer « ${r.name} » ?`)) return;
      await deleteRun(r.id);
      refreshSaved();
    };
    ul.appendChild(li);
  }
}

/** Rouvre une simulation enregistrée sans rien recalculer. */
export async function openSaved(id) {
  if (state.run?.running) {
    prog.error('Une simulation est en cours : arrêtez-la avant d\'en ouvrir une autre.');
    return;
  }
  stopPlay();
  prog.start();
  prog.status('Ouverture de la simulation enregistrée…');
  try {
    await mapReady;
    const r = await loadRun(id);
    const { meta } = r;
    const grid = meta.grid;
    // Paramètres de la simulation, pour mémoire
    const p = meta.params;
    $('rain-mm').value = p.rainMm;
    $('rain-h').value = p.rainH;
    $('rain-shape').value = p.shape;
    $('soil').value = p.soilMode || String(p.soil);
    state.amc = p.amc;
    $('amc').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === p.amc));
    $('tail-h').value = p.tailH;
    updateRainInfo();

    state.data = {
      key: `enregistrée:${id}`,
      grid,
      dem: r.dem,
      z: r.z,
      gauges: r.gauges,
      outline: r.outline,
      rivers: r.rivers,
      warnings: r.warnings,
      mask: null,
    };
    showContext(state.data);
    const store = new SnapshotStore();
    store.items = r.snaps.map((s) => ({ t: s.t, data: s.blob, fdata: s.fblob, vdata: s.vblob, adata: s.ablob, vmeta: s.vmeta }));
    const run = {
      running: false,
      stop: false,
      restored: true,
      savedId: id,
      params: p,
      grid,
      store,
      series: r.series,
      gauges: r.gauges,
      totalTime: meta.totalTime,
      tEnd: meta.tEnd,
      maxima: r.maxima,
      maxQ: quantize(r.maxima.hmax),
      follow: false,
      t0: performance.now(),
    };
    state.run = run;
    run.water = new WaterCanvas(grid, toWgs, toL93);
    setWaterCanvas(state.map, run.water.canvas, run.water.corners);
    setLayerVisible('water', document.querySelector('[data-layer=water]').checked);
    state.water3dGrid = null;
    state.lastQ = null;
    if (state.is3d) ensureWater3d();
    fitBoundsOf(state.map, gridCornersWgs(grid));

    $('gauge-legend').innerHTML = '';
    showResults(true);
    $('time').max = Math.max(0, store.length - 1);
    $('time').value = $('time').max;
    setViewMode('max');
    $('summary').innerHTML = r.summary || '';
    if ($('save-note')) $('save-note').textContent = `Simulation enregistrée le ${new Date(meta.created).toLocaleString('fr-FR')}.`;
    await renderCurrent();
    drawHydro();
    for (const k of Object.keys(STEPS)) prog.set(k, 1, 'enregistré');
    prog.finish(`Simulation rouverte : ${meta.name}`);
    refreshSaved();
  } catch (e) {
    console.error(e);
    prog.error(`Ouverture impossible : ${e.message || e}`);
  }
}
