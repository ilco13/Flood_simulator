// Lien de partage d'un scénario : le lieu étudié et les réglages, codés dans l'adresse de la
// page (après #s=). Rien n'est envoyé à un serveur ; la personne qui ouvre le lien relance
// l'analyse du lieu puis le calcul sur son appareil.

import { toL93 } from '../geo.js';
import { $, state } from './core.js';
import { avalSettings, renderAval } from './aval.js';
import { renderObstacles, saveObstacles } from './obstacles.js';
import { describeRes, params, updateRainInfo } from './params.js';
import { loadOverrides, saveOverrides } from './structures.js';
import { renderStudy, saveStudy, showStudy, studyPlace } from './study.js';

const VERSION = 1;
// Adresse lue dès le chargement : la carte remplace ensuite #… par sa position.
const INITIAL_HASH = typeof location !== 'undefined' ? location.hash : '';
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));

/** Scénario courant (objet compact). */
export function shareData() {
  const s = state.study;
  if (!s) return null;
  const p = params();
  const a = avalSettings();
  const { x: hx, y: hy } = s.house;
  return {
    v: VERSION,
    at: s.houseWgs.map(r5),
    cands: s.cands.filter((c) => c.checked).map((c) => [c.kind, c.name]),
    rain: [p.rainMm, p.rainH, p.shape],
    amc: p.amc,
    soil: p.soilMode,
    res: p.res,
    tail: p.tailH,
    burn: p.burn,
    cnf: p.cnFactor,
    cap: p.capInf ? 1 : 0,
    nest: p.nest ? [p.nest.radius, p.nest.res] : 0,
    peak: p.stopAfterPeak ? 1 : 0,
    bati: p.bdtopo ? 1 : 0,
    ouvr: p.structures ? 1 : 0,
    obst: Number($('ouvr-obst').value) || 0,
    aval: a.on ? [a.mode, a.custom ?? 0] : 0,
    obs: (state.obstacles || []).map((o) => ({ ...o, coords: o.coords.map(([x, y]) => [r6(x), r6(y)]) })),
    // Dimensions saisies des ponts et buses à moins de 20 km du lieu
    st: loadOverrides().filter((o) => Math.hypot(o.x - hx, o.y - hy) < 20000),
  };
}

export const shareUrl = (d) => `${location.origin}${location.pathname}#s=${b64url(JSON.stringify(d))}`;

/** Bouton « Partager » : partage natif sur téléphone, sinon copie dans le presse-papiers. */
export async function shareScenario() {
  const info = $('share-info');
  const d = shareData();
  if (!d) {
    info.textContent = "Choisissez d'abord un lieu à étudier.";
    return;
  }
  const url = shareUrl(d);
  const title = 'Simulation de crue';
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title, url });
      info.textContent = 'Lien partagé.';
      return;
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(url);
    info.textContent = 'Lien copié : collez-le dans un message.';
  } catch {
    info.innerHTML = 'Copiez ce lien : <input id="share-url" readonly>';
    const el = $('share-url');
    el.value = url;
    el.select();
  }
  info.append(' Il contient la position du lieu étudié et les réglages ; la personne qui l\'ouvre relance le calcul sur son appareil.');
}

const setVal = (id, v) => {
  const el = $(id);
  if (!el || v == null) return;
  if (el.type === 'checkbox') el.checked = !!v;
  else el.value = String(v);
  el.dispatchEvent(new Event(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input'));
};

/** Lit un scénario partagé dans l'adresse (#s=…) : null s'il n'y en a pas ou s'il est illisible. */
export function parseShared(hash = INITIAL_HASH) {
  const m = /[#&]s=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  try {
    const d = JSON.parse(unb64url(m[1]));
    return d?.v === VERSION && Array.isArray(d.at) ? d : null;
  } catch {
    return null;
  }
}

/** Ouvre le scénario de l'adresse, s'il y en a un (appelé quand la carte est prête). */
export function loadShared() {
  const d = parseShared();
  if (!d || state.sharedLoaded) return false;
  state.sharedLoaded = true;
  setVal('rain-mm', d.rain?.[0]);
  setVal('rain-h', d.rain?.[1]);
  setVal('rain-shape', d.rain?.[2]);
  if (d.amc != null) {
    state.amc = d.amc;
    $('amc').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === d.amc));
  }
  setVal('soil', d.soil);
  setVal('tail-h', d.tail);
  setVal('burn', d.burn);
  setVal('cnf', d.cnf);
  setVal('cap-inf', d.cap);
  setVal('stop-peak', d.peak);
  setVal('bati-ign', d.bati);
  setVal('ouvr-on', d.ouvr);
  setVal('ouvr-obst', d.obst);
  setVal('nest-on', !!d.nest);
  if (d.nest) {
    setVal('nest-r', d.nest[0]);
    setVal('nest-res', d.nest[1]);
  }
  // Ouvrages dessinés : ajoutés à ceux de cet appareil (sans doublon)
  if (Array.isArray(d.obs) && d.obs.length) {
    const have = new Set((state.obstacles || []).map((o) => JSON.stringify(o.coords)));
    for (const o of d.obs) if (o?.coords?.length && !have.has(JSON.stringify(o.coords))) state.obstacles.push(o);
    saveObstacles();
    renderObstacles();
  }
  if (Array.isArray(d.st) && d.st.length) {
    const list = loadOverrides().filter((o) => !d.st.some((n) => Math.hypot(n.x - o.x, n.y - o.y) < 30));
    saveOverrides([...list, ...d.st]);
  }
  updateRainInfo();
  state.pendingShare = d;
  const [lng, lat] = d.at;
  state.map?.flyTo({ center: [lng, lat], zoom: Math.max(state.map.getZoom(), 13) });
  studyPlace(lng, lat);
  return true;
}

/** Fin de l'analyse du lieu : cours d'eau retenus, rivière aval et maille du scénario partagé. */
export function applyPendingShare() {
  const d = state.pendingShare;
  const s = state.study;
  if (!d || !s) return;
  state.pendingShare = null;
  // Le lieu analysé doit être celui du lien (sinon l'utilisateur a cliqué ailleurs entre-temps)
  const [x, y] = toL93(...d.at);
  if (Math.hypot(s.house.x - x, s.house.y - y) > 50) return;
  if (Array.isArray(d.cands) && d.cands.length) {
    const want = new Set(d.cands.map(([k, n]) => `${k}|${n}`));
    s.cands.forEach((c) => (c.checked = want.has(`${c.kind}|${c.name}`)));
    if (!s.cands.some((c) => c.checked)) s.cands.forEach((c, i) => (c.checked = i === 0));
  }
  const a = avalSettings();
  a.on = !!d.aval;
  if (d.aval) {
    a.mode = d.aval[0];
    a.custom = d.aval[1] || null;
  }
  saveStudy();
  showStudy();
  renderStudy();
  renderAval();
  if (d.res && [...$('res').options].some((o) => Number(o.value) === d.res)) setVal('res', d.res);
  describeRes();
  $('share-info').textContent = 'Scénario partagé chargé : vérifiez les réglages puis lancez la simulation.';
  $('map-status').className = '';
  $('map-status').textContent = 'Scénario partagé chargé : lancez la simulation.';
  $('map-status').hidden = false;
  setTimeout(() => ($('map-status').hidden = true), 6000);
}
