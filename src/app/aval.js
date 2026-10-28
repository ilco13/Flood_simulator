import { cellOf } from '../geo.js';
import { floodQuantiles, transposeQ } from '../hydrology/flood.js';
import { sameRiver, stationFloods, stationsIn } from '../data/hydro.js';
import { cmp } from './compareUi.js';
import { $, fmtArea, fmtNum, state } from './core.js';
import { describeRes } from './params.js';
import { autoResForStudy, renderStudy, saveStudy, showStudy, studyCands } from './study.js';

/* ---------- Rivière aval en crue (remous à la confluence) ---------- */

export const AVAL_RAMP = 1800; // s : montée de la rivière jusqu'au débit choisi

/** Cours d'eau principal retenu (le plus grand) et sa rivière aval, s'il y en a une. */
export function mainReceiver() {
  const streams = studyCands().filter((c) => c.kind === 'stream');
  if (!streams.length) return null;
  const c = streams.reduce((a, b) => (b.areaKm2 > a.areaKm2 ? b : a));
  return c.receiver ? c : null;
}

/**
 * Débits de crue de la rivière aval (m³/s) : d'après les crues mesurées à une station de la
 * rivière quand il y en a une (ramenées à la confluence), sinon estimés par formule.
 */
export function avalEstimates() {
  const r = mainReceiver()?.receiver;
  if (!r) return null;
  const pj = state.study?.pj;
  const formula = { ...floodQuantiles(r.areaKm2, pj?.q10 ?? 80, pj?.q100 ?? 120), fromRain: !!pj };
  const st = state.study?.avalStation;
  if (st?.key === receiverKey(r) && st.station) {
    const k = transposeQ(1, st.station.areaKm2, r.areaKm2);
    return { q10: st.station.q10 * k, q100: st.station.q100 * k, station: st.station, formula };
  }
  return formula;
}

const receiverKey = (r) => `${r.name}|${Math.round(r.areaKm2)}`;
/**
 * Cherche une station Hub'Eau sur la rivière aval (même nom, bassin de taille comparable, au
 * moins 15 ans de mesures) et enregistre ses crues décennale et centennale dans le lieu étudié.
 */
export async function findAvalStation() {
  const s = state.study;
  const r = mainReceiver()?.receiver;
  if (!s || !r?.name || !r.confWgs) return;
  const key = receiverKey(r);
  if (s.avalStation?.key === key || state.avalStationBusy === key) return;
  state.avalStationBusy = key;
  try {
    const [lon, lat] = r.confWgs;
    const d = 0.35;
    const list = (await stationsIn({ west: lon - d, east: lon + d, south: lat - d * 0.75, north: lat + d * 0.75 }))
      .filter((st) => st.areaKm2 && sameRiver(st.river, r.name))
      .map((st) => ({ ...st, ratio: Math.abs(Math.log(st.areaKm2 / r.areaKm2)) }))
      .filter((st) => st.ratio < Math.log(4))
      .sort((a, b) => a.ratio - b.ratio);
    let station = null;
    for (const st of list.slice(0, 4)) {
      const f = await stationFloods(st.code).catch(() => null);
      if (f) {
        station = { code: st.code, name: st.name, areaKm2: st.areaKm2, ...f };
        break;
      }
    }
    if (state.study !== s) return;
    s.avalStation = { key, station };
    saveStudy();
    renderAval();
  } catch (e) {
    console.warn('Stations Hub\'Eau indisponibles', e);
  } finally {
    if (state.avalStationBusy === key) state.avalStationBusy = null;
  }
}

export function avalSettings() {
  const s = state.study;
  if (!s) return { on: false, mode: 'q100', custom: null };
  s.aval ??= { on: false, mode: 'q100', custom: null };
  return s.aval;
}

/** Paramètres de calcul liés à la rivière aval : { aval: { Q } | null, avalFrame }. */
export function avalParams() {
  const a = avalSettings();
  const est = a.on ? avalEstimates() : null;
  const Q = !est ? 0 : a.mode === 'custom' ? Math.max(0, Number(a.custom) || 0) : Math.round(a.mode === 'q10' ? est.q10 : est.q100);
  const aval = est && Q > 0 ? { Q, mode: a.mode } : null;
  return { aval, avalFrame: !!aval || (!!state.forceAvalFrame && !!mainReceiver()) };
}

/** Mailles du lit de la rivière où l'on injecte son débit (les plus basses autour du point). */
export function inflowCells(grid, z, [x, y]) {
  const c0 = cellOf(grid, x, y);
  if (!c0) return null;
  // Fond du lit le plus proche (le tracé peut être décalé de quelques dizaines de mètres)
  const R = Math.max(1, Math.round(Math.max(60, 2 * grid.dx) / grid.dx));
  let c = c0;
  let zb = Infinity;
  for (let dj = -R; dj <= R; dj++)
    for (let di = -R; di <= R; di++) {
      const i = c0.i + di;
      const j = c0.j + dj;
      if (di * di + dj * dj > R * R || i < 1 || j < 1 || i >= grid.nx - 1 || j >= grid.ny - 1) continue;
      const v = z[j * grid.nx + i];
      if (v < zb) {
        zb = v;
        c = { i, j };
      }
    }
  const r = Math.max(1, Math.round(Math.max(25, 1.5 * grid.dx) / grid.dx));
  const cand = [];
  for (let dj = -r; dj <= r; dj++)
    for (let di = -r; di <= r; di++) {
      const i = c.i + di;
      const j = c.j + dj;
      if (di * di + dj * dj > r * r || i < 1 || j < 1 || i >= grid.nx - 1 || j >= grid.ny - 1) continue;
      const k = j * grid.nx + i;
      cand.push([z[k], k]);
    }
  if (!cand.length) return null;
  cand.sort((a, b) => a[0] - b[0]);
  const zmin = cand[0][0];
  return Int32Array.from(cand.filter(([v]) => v <= zmin + 0.5).slice(0, 25).map(([, k]) => k));
}

export function setupAval() {
  $('aval-on').onchange = (e) => {
    avalSettings().on = e.target.checked;
    avalChanged();
  };
  $('aval-mode').onchange = (e) => {
    const a = avalSettings();
    a.mode = e.target.value;
    if (a.mode === 'custom' && !a.custom) a.custom = Number($('aval-q').value) || null;
    avalChanged();
  };
  $('aval-q').oninput = (e) => {
    const a = avalSettings();
    a.mode = 'custom';
    a.custom = Number(e.target.value) || null;
    $('aval-mode').value = 'custom';
    saveStudy();
    renderAvalInfo();
  };
}

export function avalChanged() {
  saveStudy();
  showStudy();
  autoResForStudy();
  renderStudy();
  describeRes();
}

export function renderAval() {
  const box = $('aval-box');
  const c = mainReceiver();
  box.hidden = !c;
  $('cmp-aval').hidden = !c;
  document.querySelectorAll('.cmp-aval-row').forEach((el) => (el.hidden = !c));
  if (!c) return;
  const r = c.receiver;
  const a = avalSettings();
  const dist = r.distM < 1000 ? `${fmtNum(Math.round(r.distM / 10) * 10)} m` : `${fmtNum(r.distM / 1000, 1)} km`;
  $('aval-desc').innerHTML =
    `<strong></strong> se jette dans <strong></strong> ${dist} en aval du lieu (bassin de la rivière : ${fmtArea(r.areaKm2)}${r.complete ? '' : ' au moins'}).`;
  const st = $('aval-desc').querySelectorAll('strong');
  st[0].textContent = c.name;
  st[1].textContent = r.name || 'une rivière sans nom';
  $('aval-on').checked = a.on;
  $('aval-opts').hidden = !a.on;
  $('aval-mode').value = a.mode;
  findAvalStation();
  renderAvalInfo();
}

export function renderAvalInfo() {
  const a = avalSettings();
  const est = avalEstimates();
  const el = $('aval-info');
  if (!est) return;
  if (a.mode !== 'custom' || document.activeElement !== $('aval-q')) $('aval-q').value = a.mode === 'custom' ? (a.custom ?? '') : Math.round(a.mode === 'q10' ? est.q10 : est.q100);
  const r = mainReceiver().receiver;
  const st = est.station;
  const f = est.formula || est;
  const src = st
    ? `D'après les crues mesurées à la station <strong></strong> (${fmtArea(st.areaKm2)}, ${st.years} années de ${st.first} à ${st.last}, plus forte crue ${fmtNum(st.maxQ)} m³/s en ${st.maxYear}–${st.maxYear + 1} ; ` +
      `loi de Gumbel : décennale ${fmtNum(st.q10)}, centennale ${fmtNum(st.q100)} m³/s), ramenées à la confluence : `
    : `Estimation (ordre de grandeur, méthodes CRUPEDIX et gradex${f.fromRain ? ', pluies Météo-France du lieu' : ', pluies du lieu pas encore connues'}${
        state.avalStationBusy ? ' ; recherche d\'une station de mesure…' : state.study?.avalStation ? ' ; pas de station de mesure utilisable sur cette rivière' : ''
      }) : `;
  el.innerHTML = a.on
    ? src +
      `décennale ≈ <strong>${fmtNum(est.q10)} m³/s</strong>, centennale ≈ <strong>${fmtNum(est.q100)} m³/s</strong>` +
      (st ? ` (formule : ${fmtNum(f.q10)} et ${fmtNum(f.q100)} m³/s). ` : '. ') +
      'Si vous connaissez le débit de crue de la rivière (HydroPortail, Vigicrues, PPRI), choisissez « Autre valeur ». ' +
      `La rivière est maintenue à ce débit pendant tout l'épisode (cas défavorable), injecté ${fmtNum(600)} m en amont de la confluence ; ` +
      `la zone de calcul s'étend jusqu'à la confluence (trait bleu sur la carte).` +
      (r.distM > 3000 ? ' <span class="warn">Confluence éloignée : le remous ne remonte en général pas si loin, sauf en plaine.</span>' : '')
    : 'Cochez pour simuler la rivière en crue au même moment : son niveau peut gêner l\'écoulement du cours d\'eau étudié et faire monter l\'eau en amont de la confluence (remous).';
  if (a.on && st) el.querySelector('strong').textContent = st.name;
}
