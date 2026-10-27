// Rejouer une crue mesurée : une station hydrométrique (Hub'Eau) proche du lieu, une de ses plus
// fortes crues, les pluies horaires observées par les stations Météo-France autour du bassin ;
// simulation, comparaison aux débits mesurés, puis calage de la capacité d'absorption du sol.

import { stationsIn, dailyMax, topFloods, episodeFlows, parseFlowCsv } from '../data/hydro.js';
import { drawChart } from '../ui/chart.js';
import { localDay, parisDayStart, arealHourly, rainWindow, amcIndex, antecedentIndex, episodeScores } from '../hydrology/episode.js';
import { $, fmtNum, state } from './core.js';
import { departmentsAround, fetchRainRef } from './rainRef.js';
import { studyPlace, saveStudy, showStudy, renderStudy, autoResForStudy } from './study.js';
import { describeRes, updateRainInfo } from './params.js';
import { startRun } from './run.js';
import { escHtml } from './compareUi.js';

const CALIB_KEY = 'flood-sim-calib';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDay = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const fmtWhen = (ms) => new Date(ms).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : NaN);
const fmtPct = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v))} %` : '—');

export function setupEpisode() {
  $('ep-find').onclick = findStations;
  $('ep-quit').onclick = quitEpisode;
  $('ep-calib').onclick = () => (state.calibrating ? (state.calibrating.cancel = true) : calibrate());
  $('ep-csv').onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f || !state.episode) return;
    const curve = parseFlowCsv(await f.text());
    state.episode.csv = curve.length ? curve : null;
    $('ep-info2').textContent = curve.length ? `Courbe importée : ${curve.length} mesures, du ${fmtWhen(curve[0][0])} au ${fmtWhen(curve[curve.length - 1][0])}.` : 'Fichier illisible : il faut une colonne date-heure puis une colonne débit.';
    if (state.run?.params?.episode) renderEpisodeCompare(state.run);
  };
}

/* ---------- Stations et crues mesurées ---------- */

async function findStations() {
  const s = state.study;
  const ul = $('ep-stations');
  if (!s) {
    ul.innerHTML = '<li class="hint">Choisissez d\'abord le lieu étudié.</li>';
    return;
  }
  ul.innerHTML = '<li class="hint">Recherche des stations de mesure (Hub\'Eau)…</li>';
  $('ep-floods').innerHTML = '';
  const [lon, lat] = s.houseWgs;
  const dLat = 25 / 111;
  const dLon = 25 / (111 * Math.cos((lat * Math.PI) / 180));
  try {
    const st = (await stationsIn({ west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat })).filter((x) => x.areaKm2 > 0.5 && x.areaKm2 < 2000);
    const dist = (x) => Math.hypot((x.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180), (x.lat - lat) * 111);
    st.sort((a, b) => dist(a) - dist(b));
    if (!st.length) {
      ul.innerHTML = '<li class="hint">Aucune station de mesure des débits à moins de 25 km.</li>';
      return;
    }
    ul.innerHTML = '';
    for (const x of st.slice(0, 8)) {
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" class="link"><strong></strong></button><small></small>`;
      li.querySelector('strong').textContent = x.name;
      li.querySelector('small').textContent = ` · bassin ${fmtNum(x.areaKm2, x.areaKm2 < 10 ? 1 : 0)} km² · à ${fmtNum(dist(x), 1)} km${x.open ? '' : ' · fermée'}`;
      li.querySelector('button').onclick = () => showFloods(x);
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = `<li class="warn">Stations indisponibles : ${escHtml(e.message || e)}</li>`;
  }
}

async function showFloods(st) {
  const ul = $('ep-floods');
  ul.innerHTML = `<li class="hint">Crues mesurées à ${escHtml(st.name)}…</li>`;
  try {
    // Pluies horaires Météo-France : bien fournies depuis les années 1990
    const days = await dailyMax(st.code, '1990-01-01');
    const top = topFloods(days, 8);
    if (!top.length) {
      ul.innerHTML = '<li class="hint">Pas de débits mesurés depuis 1990 à cette station.</li>';
      return;
    }
    ul.innerHTML = `<li class="lbl">Plus fortes crues mesurées à ${escHtml(st.name)} (débit maximal du jour)</li>`;
    for (const f of top) {
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" class="link">${fmtDay(f.date)} : <strong>${fmtNum(f.q, f.q < 10 ? 1 : 0)} m³/s</strong></button> <button type="button" class="chip-btn">Rejouer</button>`;
      li.querySelectorAll('button').forEach((b) => (b.onclick = () => replay(st, f)));
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = `<li class="warn">Débits indisponibles : ${escHtml(e.message || e)}</li>`;
  }
}

/* ---------- Préparer l'épisode ---------- */

async function waitStudy(timeoutS = 300) {
  for (let i = 0; i < timeoutS * 2; i++) {
    await sleep(500);
    if (!state.catchWorker) {
      if (state.study) return state.study;
      throw new Error("analyse du lieu impossible à l'emplacement de la station");
    }
  }
  throw new Error("analyse du lieu trop longue");
}

function loadHourly(lon, lat, deps, t0, hours, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../data/episodeWorker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m);
      else if (m.type === 'done') {
        w.terminate();
        resolve(m.stations);
      } else if (m.type === 'error') {
        w.terminate();
        reject(new Error(m.message));
      }
    };
    w.onerror = () => {
      w.terminate();
      reject(new Error('lecture des pluies horaires interrompue'));
    };
    w.postMessage({ lat, lon, deps, t0, hours, radiusKm: 25 });
  });
}

async function replay(st, flood) {
  const info = $('ep-info');
  $('ep-active').hidden = false;
  $('ep-compare-box').hidden = true;
  info.innerHTML = `Crue du ${fmtDay(flood.date)} à ${escHtml(st.name)} : analyse du bassin de la station…`;
  try {
    if (state.study && !state.episode) state.prevStudy = state.study;
    studyPlace(st.lon, st.lat);
    const s = await waitStudy();
    // Cours d'eau de la station : bassin le plus proche de celui annoncé par Hub'Eau
    const streams = s.cands.filter((c) => c.kind === 'stream');
    if (!streams.length) throw new Error("aucun cours d'eau trouvé à la station");
    const c = streams.reduce((a, b) => (Math.abs(Math.log(b.areaKm2 / st.areaKm2)) < Math.abs(Math.log(a.areaKm2 / st.areaKm2)) ? b : a));
    for (const x of s.cands) x.checked = x === c;
    saveStudy();
    showStudy();
    autoResForStudy();
    renderStudy();
    const ratio = c.areaKm2 / st.areaKm2;
    // Pluies : un mois avant (humidité du sol) jusqu'au surlendemain ; le fichier est lu en entier
    // de toute façon, la période ne change pas le volume téléchargé.
    const D = Date.parse(`${flood.date}T00:00:00Z`);
    const t0 = D - 32 * 864e5;
    const hours = 35 * 24;
    const ring = c.outline?.[0] || [[st.lon, st.lat]];
    const lonC = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const latC = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    info.innerHTML = `Crue du ${fmtDay(flood.date)} : lecture des pluies horaires Météo-France…`;
    const deps = await departmentsAround(lonC, latC);
    const stations = await loadHourly(lonC, latC, deps, t0, hours, (m) => {
      info.innerHTML = `Crue du ${fmtDay(flood.date)} : pluies horaires Météo-France (département ${m.k}/${m.n}) : ${fmtNum(m.mb, 1)}${m.totalMb ? ` / ${fmtNum(m.totalMb)}` : ''} Mo…`;
    });
    // Stations retenues : données sur au moins 70 % des heures autour de la crue
    const from = 30 * 24; // veille de la veille, 0 h TU
    const good = stations.filter((x) => {
      let n = 0;
      for (let k = from; k < hours; k++) if (x.rr[k] >= 0) n++;
      return n >= 0.7 * (hours - from);
    });
    if (!good.length) throw new Error('aucune station Météo-France avec des pluies horaires à cette date');
    const a = arealHourly(good, hours);
    const win = rainWindow(a, from);
    if (!win) throw new Error('pas de pluie mesurée autour de cette date');
    let ante = 0;
    let ante30 = 0;
    for (let k = Math.max(0, win.s - 120); k < win.s; k++) ante += a[k];
    for (let k = Math.max(0, win.s - 720); k < win.s; k++) ante30 += a[k];
    const month = Number(flood.date.slice(5, 7));
    // Humidité du sol : indice des pluies des 30 jours précédents (le plus récent compte plus)
    const api = antecedentIndex(a, win.s);
    const amcIdx = amcIndex(api, month);
    const amc = Math.min(3, Math.max(1, Math.round(amcIdx)));
    const hourly = Array.from(a.slice(win.s, win.e), (v) => Math.round(v * 100) / 100);
    const total = hourly.reduce((x, y) => x + y, 0);
    const simT0 = t0 + win.s * 3600e3;
    const obs = await episodeFlows(st.code, localDay(simT0 - 864e5), localDay(simT0 + (hourly.length + 48) * 3600e3)).catch(() => ({ daily: [], curve: null }));
    state.episode = { station: st, flood, t0: simT0, hourly, total, ante, ante30, api, amc, amcIdx, stations: good.map((x) => ({ name: x.name, d: x.d })), obs, csv: null, cand: c.name, ratio };
    // Panneau : pluie de l'épisode (non modifiable), humidité du sol proposée
    $('rain-mm').value = Math.round(total);
    $('rain-h').value = hourly.length;
    for (const id of ['rain-mm', 'rain-h', 'rain-shape']) $(id).disabled = true;
    if (Number($('tail-h').value) < 12) $('tail-h').value = 12;
    state.amc = amc;
    $('amc').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === amc));
    updateRainInfo();
    describeRes();
    renderEpisodeInfo();
  } catch (e) {
    console.error(e);
    info.innerHTML = `<span class="warn">Épisode impossible : ${escHtml(e.message || e)}</span>`;
  }
}

function renderEpisodeInfo() {
  const ep = state.episode;
  if (!ep) return;
  const peak = Math.max(...ep.hourly);
  const AMC = { 1: 'sol sec', 2: 'sol normal', 3: 'sol saturé' };
  $('ep-info').innerHTML =
    `<strong>Crue du ${fmtDay(ep.flood.date)}</strong> à ${escHtml(ep.station.name)} : ${fmtNum(ep.flood.q, ep.flood.q < 10 ? 1 : 0)} m³/s mesurés (maximum du jour). ` +
    `Pluie moyenne sur le bassin : <strong>${fmtNum(ep.total)} mm en ${ep.hourly.length} h</strong> (pointe ${fmtNum(peak, 1)} mm en une heure), à partir du ${fmtWhen(ep.t0)}, ` +
    `d'après ${ep.stations.length} station${ep.stations.length > 1 ? 's' : ''} Météo-France (${ep.stations.slice(0, 4).map((x) => escHtml(x.name)).join(', ')}${ep.stations.length > 4 ? '…' : ''}). ` +
    `Pluies antérieures : ${fmtNum(ep.ante)} mm en 5 jours, ${fmtNum(ep.ante30)} mm en 30 jours (indice ${fmtNum(ep.api)} mm) → <strong>${AMC[ep.amc]}</strong> (humidité ${fmtNum(ep.amcIdx, 2)} sur une échelle de 1 sec à 3 saturé ; un clic sur Sec / Normal / Saturé l'impose). ` +
    (Math.abs(Math.log(ep.ratio)) > 0.2 ? `<span class="warn">Bassin trouvé ${fmtNum(ep.ratio * ep.station.areaKm2)} km² pour ${fmtNum(ep.station.areaKm2)} km² annoncés par la station.</span> ` : '') +
    (ep.obs.curve ? 'Courbe de débit mesurée disponible (crue récente). ' : 'Débits mesurés : maximum et moyenne de chaque jour ; pour la courbe complète, importez un export HydroPortail. ') +
    'Lancez la simulation pour comparer.';
}

export function quitEpisode() {
  state.episode = null;
  for (const id of ['rain-mm', 'rain-h', 'rain-shape']) $(id).disabled = false;
  $('ep-active').hidden = true;
  $('ep-compare-box').hidden = true;
  if (state.prevStudy) {
    state.study = state.prevStudy;
    state.prevStudy = null;
    saveStudy();
    showStudy();
    autoResForStudy();
    renderStudy();
    fetchRainRef();
  }
  updateRainInfo();
  describeRes();
}

/** Réglages de pluie quand un épisode est chargé. */
export function episodeParams() {
  const ep = state.episode;
  if (!ep) return {};
  return {
    rainMm: ep.total,
    rainH: ep.hourly.length,
    shape: 'observed',
    hourly: ep.hourly,
    episode: { code: ep.station.code, date: ep.flood.date },
    // Humidité continue tant que l'utilisateur n'a pas choisi une autre classe
    ...(state.amc === ep.amc && !ep.amcForced ? { amcIdx: ep.amcIdx } : {}),
  };
}

/* ---------- Comparaison aux mesures ---------- */

export function renderEpisodeCompare(run) {
  const ep = state.episode;
  if (!ep || run.params.episode?.code !== ep.station.code || run.params.episode?.date !== ep.flood.date) return;
  const r = episodeScores(run, ep);
  run.epScore = r;
  $('ep-compare-box').hidden = false;
  $('ep-compare-box').open = true;
  const H = (t) => (t - ep.t0) / 3600e3;
  const series = [];
  // Maximum mesuré de chaque jour (palier sur la journée)
  const steps = [];
  for (const d of r.days) {
    if (!Number.isFinite(d.max)) continue;
    const d0 = parisDayStart(d.date);
    steps.push([H(d0), d.max], [H(d0 + 864e5), d.max]);
  }
  const xMax = H(r.sim[r.sim.length - 1][0]);
  const clip = (pts) => pts.filter(([x]) => x >= 0 && x <= xMax);
  if (steps.length) series.push({ name: 'Maximum mesuré du jour', color: '#868e96', width: 1.5, points: clip(steps) });
  if (r.curve) series.push({ name: 'Débit mesuré', color: '#212529', width: 1.8, points: clip(r.curve.map(([t, q]) => [H(t), q])) });
  series.push({ name: 'Débit simulé', color: '#1c7ed6', width: 2, points: r.sim.map(([t, q]) => [H(t), q]) });
  drawChart($('ep-chart'), { series, xMax, xFormat: (x) => `${Math.round(x)} h` });
  const lines = [
    `Pic : <strong>${fmtNum(r.simPeak)} m³/s</strong> simulés le ${fmtWhen(r.simPeakT)}, contre <strong>${fmtNum(r.obsPeak)} m³/s</strong> mesurés${r.obsPeakT ? ` le ${fmtWhen(r.obsPeakT)}` : r.obsPeakDay ? ` le ${fmtDay(r.obsPeakDay)} (maximum du jour)` : ''} : <strong>${fmtPct(r.peakErr)}</strong>.`,
  ];
  if (r.timeErrH != null) lines.push(`Heure du pic : ${r.timeErrH > 0 ? 'en retard' : 'en avance'} de ${fmtNum(Math.abs(r.timeErrH), 1)} h.`);
  else if (r.obsPeakDay) lines.push(`Jour du pic : simulé le ${fmtDay(localDay(r.simPeakT))}, mesuré le ${fmtDay(r.obsPeakDay)}.`);
  if (r.volErr != null) lines.push(`Volume de crue (jours entiers simulés, au-dessus du débit de base) : ${fmtPct(r.volErr)}.`);
  if (r.nse != null) lines.push(`Ressemblance des courbes (critère de Nash, 1 = parfait, < 0 = moins bien que la moyenne) : ${fmtNum(r.nse, 2)}.`);
  lines.push('<small>Le simulateur part de rivières vides : le débit de base (nappes, sources) n\'est pas simulé.</small>');
  $('ep-stats').innerHTML = lines.join('<br>');
}

/* ---------- Calage ---------- */

const score = (r) => Math.abs(r.peakErr) + (r.volErr != null ? 0.5 * Math.abs(r.volErr) : 0) + (r.nse != null ? 30 * Math.max(0, 1 - r.nse) : 0);

async function calibrate() {
  const ep = state.episode;
  if (!ep || state.run?.running) return;
  const out = $('ep-calib-info');
  const job = { cancel: false };
  state.calibrating = job;
  $('ep-calib').textContent = 'Arrêter le calage';
  const tried = [];
  const tryF = async (f) => {
    $('cnf').value = f;
    $('cnf').dispatchEvent(new Event('input'));
    out.innerHTML = `Calage : capacité d'absorption ×${fmtNum(f, 2)} (simulation ${tried.length + 1})…`;
    const res = await startRun();
    if (!res?.ok || !res.run.epScore) return false;
    tried.push({ f, r: res.run.epScore, s: score(res.run.epScore) });
    return true;
  };
  try {
    for (const f of [0.25, 0.4, 0.6, 1, 1.6]) if (job.cancel || !(await tryF(f))) break;
    // Meilleur réglage au bord de la plage essayée : on continue dans ce sens (3 essais au plus)
    for (let n = 0; n < 3 && !job.cancel && tried.length >= 3; n++) {
      const b = tried.reduce((a, x) => (x.s < a.s ? x : a));
      const fs = tried.map((x) => x.f);
      const next = b.f === Math.max(...fs) ? b.f * 1.6 : b.f === Math.min(...fs) ? b.f / 1.6 : null;
      if (!next || next > 8 || next < 0.05 || !(await tryF(Math.round(next * 100) / 100))) break;
    }
    // Affinage autour du meilleur
    if (!job.cancel && tried.length >= 3) {
      const b = tried.reduce((a, x) => (x.s < a.s ? x : a));
      for (const f of [b.f / 1.2, b.f * 1.2]) if (job.cancel || !(await tryF(Math.round(f * 100) / 100))) break;
    }
  } finally {
    state.calibrating = null;
    $('ep-calib').textContent = 'Caler le modèle sur cette crue';
  }
  if (!tried.length) {
    out.textContent = 'Calage interrompu.';
    return;
  }
  tried.sort((a, b) => a.f - b.f);
  const best = tried.reduce((a, x) => (x.s < a.s ? x : a));
  out.innerHTML =
    `<table class="cmp-table"><thead><tr><th>Absorption</th><th>Pic</th><th>Volume</th>${tried.some((x) => x.r.nse != null) ? '<th>Nash</th>' : ''}</tr></thead><tbody>` +
    tried
      .map((x) => `<tr${x === best ? ' class="best"' : ''}><td>×${fmtNum(x.f, 2)}</td><td>${fmtPct(x.r.peakErr)}</td><td>${fmtPct(x.r.volErr)}</td>${tried.some((y) => y.r.nse != null) ? `<td>${x.r.nse != null ? fmtNum(x.r.nse, 2) : '—'}</td>` : ''}</tr>`)
      .join('') +
    `</tbody></table>Meilleur réglage : <strong>×${fmtNum(best.f, 2)}</strong> (pic ${fmtPct(best.r.peakErr)}${best.r.volErr != null ? `, volume ${fmtPct(best.r.volErr)}` : ''}). ` +
    // Pic juste mais volume très faux : le modèle ne reproduit pas la façon dont ce bassin
    // réagit (écoulement par le sol et les nappes, karst…) ; le réglage compense sans expliquer.
    (best.r.volErr != null && Math.abs(best.r.volErr) > 50
      ? '<span class="warn">Le pic est retrouvé mais pas le volume : le simulateur ne reproduit pas la façon dont ce bassin réagit (eau qui passe par le sol et les nappes, karst…). Ce réglage ne vaut que pour des crues semblables ; à ne pas généraliser.</span> '
      : '') +
    `<button type="button" class="chip-btn" id="ep-apply">Garder ce réglage pour ce secteur</button>`;
  $('cnf').value = best.f;
  $('cnf').dispatchEvent(new Event('input'));
  $('ep-apply').onclick = () => {
    saveCalib({ code: ep.station.code, name: ep.station.name, date: ep.flood.date, f: best.f, lon: ep.station.lon, lat: ep.station.lat, peakErr: best.r.peakErr });
    $('ep-apply').replaceWith(Object.assign(document.createElement('span'), { textContent: 'Réglage enregistré : il sera proposé pour les lieux à moins de 30 km.' }));
  };
}

function loadCalibs() {
  try {
    return JSON.parse(localStorage.getItem(CALIB_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveCalib(c) {
  const all = loadCalibs().filter((x) => !(x.code === c.code && x.date === c.date));
  all.push({ ...c, saved: Date.now() });
  try {
    localStorage.setItem(CALIB_KEY, JSON.stringify(all));
  } catch {
    /* stockage plein */
  }
}

/** Réglage calé le plus proche (≤ 30 km) du lieu étudié : appliqué, avec une note. */
export function applyCalibNear() {
  const s = state.study;
  const note = $('calib-note');
  if (!s || state.episode) return;
  const [lon, lat] = s.houseWgs;
  const d = (c) => Math.hypot((c.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180), (c.lat - lat) * 111);
  const near = loadCalibs()
    .map((c) => ({ ...c, d: d(c) }))
    .filter((c) => c.d <= 30)
    .sort((a, b) => a.d - b.d)[0];
  if (!near) {
    note.textContent = '';
    return;
  }
  $('cnf').value = near.f;
  $('cnf').dispatchEvent(new Event('input'));
  note.innerHTML = `Capacité d'absorption du sol calée à <strong>×${fmtNum(near.f, 2)}</strong> sur la crue du ${fmtDay(near.date)} à ${escHtml(near.name)} (${fmtNum(near.d)} km) ; modifiable dans les options avancées.`;
}
