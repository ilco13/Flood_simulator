// Rapport d'une simulation ou d'une comparaison : page imprimable (carte, courbes, coupe,
// résumé, réglages, hypothèses et limites), enregistrée en PDF par l'impression du navigateur.

import { $, fmtNum, state } from './core.js';
import { escHtml } from './compareUi.js';
import { shareData, shareUrl } from './share.js';
import { studyCands } from './study.js';
import { STRUCT_MAX_DX } from './structures.js';

const AMC = { 1: 'sec', 2: 'normal', 3: 'saturé' };
const SHAPE = { chicago: 'Chicago (pointe au tiers)', uniform: 'uniforme', desbordes: 'double triangle (Desbordes)', observed: 'pluies observées heure par heure' };

/** Image de la carte telle qu'affichée (prise juste après un rendu, sans conserver le tampon). */
function mapImage() {
  const map = state.map;
  if (!map) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    map.once('render', () => {
      clearTimeout(t);
      try {
        resolve(map.getCanvas().toDataURL('image/jpeg', 0.88));
      } catch {
        resolve(null); // tuile sans autorisation de lecture : pas d'image
      }
    });
    map.triggerRepaint();
  });
}

function canvasImage(id) {
  const c = $(id);
  if (!c || !c.width || !c.height || c.offsetParent === null) return null;
  try {
    return c.toDataURL('image/png');
  } catch {
    return null;
  }
}

const img = (src, alt, cls = '') => (src ? `<img class="${cls}" src="${src}" alt="${escHtml(alt)}">` : '');
const row = (k, v) => `<tr><th>${escHtml(k)}</th><td>${v}</td></tr>`;

/** Réglages de la simulation affichée. */
function paramsTable(p, run) {
  const rows = [];
  const cands = studyCands();
  if (cands.length) rows.push(row("Cours d'eau et versants retenus", cands.map((c) => `${escHtml(c.name)} (${fmtNum(c.areaKm2, c.areaKm2 < 10 ? 1 : 0)} km²)`).join(', ')));
  if (p.episode) rows.push(row('Pluie', `crue du ${p.episode.date.split('-').reverse().join('/')} : ${fmtNum(p.rainMm)} mm observés en ${p.rainH} h${p.rainStations ? ', variable dans l\'espace (blocs d\'≈ 1 km)' : ''}`));
  else rows.push(row('Pluie', `${fmtNum(p.rainMm)} mm en ${fmtNum(p.rainH, 2)} h, répartition ${SHAPE[p.shape] || escHtml(p.shape)}`));
  rows.push(row('Sol', `humidité ${AMC[p.amc] || p.amc}${p.amcIdx ? ` (indice ${fmtNum(p.amcIdx, 2)})` : ''} ; groupe de sol ${p.soil}${p.soilMode === 'auto' ? ' (déduit du lieu)' : ''}${p.capInf ? ' ; plafond d\'infiltration selon l\'intensité' : ''}${p.cnFactor !== 1 ? ` ; capacité d'absorption ×${fmtNum(p.cnFactor, 2)} (calage)` : ''}`));
  rows.push(row('Maille de calcul', p.nestOf ? `${p.res} m autour du lieu, bassin à ${p.nestOf.coarse} m (calcul en deux temps)` : `${p.res} m`));
  const opts = [p.bdtopo ? 'bâtiments IGN' : null, p.structures && p.res <= STRUCT_MAX_DX ? `ponts et buses${p.obstruction ? ` (bouchés à ${fmtNum(p.obstruction * 100)} %)` : ''}` : null, (state.obstacles?.length ? `${state.obstacles.length} ouvrage(s) dessiné(s)` : null)].filter(Boolean);
  if (opts.length) rows.push(row('Ouvrages', opts.join(', ')));
  if (p.aval) rows.push(row('Rivière aval', `maintenue en crue à ${fmtNum(p.aval.Q)} m³/s`));
  if (run?.totalTime) rows.push(row('Durée simulée', `${fmtNum((run.tEnd ?? run.totalTime) / 3600, 1)} h`));
  return `<table class="rp-params">${rows.join('')}</table>`;
}

const LIMITS = `<ul>
<li>Modèle simplifié (ondes « inertie locale » sur un maillage, pluie nette SCS) : les chiffres servent à comparer des scénarios et à repérer les zones exposées, pas à prévoir une crue.</li>
<li>Relief : MNT LiDAR HD de l'IGN (sol nu) rééchantillonné à la maille de calcul ; les détails plus petits que la maille (murets, fossés, buses) ne sont pas vus, sauf s'ils sont dessinés.</li>
<li>Ponts et buses : repérés sous les remblais seulement (mailles de 10 m ou moins), dimensions estimées tant qu'elles ne sont pas saisies.</li>
<li>Pas d'infiltration sous l'eau stagnante, pas d'évaporation, pas d'écoulement souterrain (karst, nappes) ; réseaux d'eaux pluviales ignorés.</li>
<li>Débits de crue de référence estimés (formules ou loi de Gumbel sur les mesures) : incertitude de plusieurs dizaines de pour cent.</li>
<li>Données IGN (RGE ALTI, LiDAR HD, BD TOPO, COSIA), Météo-France, Hub'Eau, NASA POWER, SoilGrids, à leur date de consultation.</li>
</ul>`;

/** Construit le rapport puis ouvre l'impression (« Enregistrer en PDF »). */
export async function makeReport({ comparison = false } = {}) {
  const run = state.run;
  if (!run?.maxima && !comparison) return;
  const btn = comparison ? $('cmp-report') : $('report');
  if (btn) btn.disabled = true;
  try {
    const place = (await Promise.race([run?.placeP, new Promise((r) => setTimeout(() => r(null), 3000))])) || '';
    const date = new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
    const map = await mapImage();
    const legend = $('map-legend')?.hidden ? '' : $('map-legend').innerHTML;
    const what = state.viewMode === 'max' ? "hauteur d'eau maximale atteinte" : `hauteur d'eau à ${$('time-label').textContent}`;
    const p = run?.params || {};
    let body = '';
    if (comparison) {
      body += `<h2>Comparaison des scénarios</h2>
        <div class="rp-legend">${$('cmp-legend').innerHTML}</div>
        <h3>${escHtml($('cmp-hydro-title').textContent)}</h3>${img(canvasImage('cmp-hydro'), 'Débits comparés', 'rp-chart')}
        <h3>Hauteur d'eau au point étudié (m)</h3>${img(canvasImage('cmp-place'), 'Hauteur au point', 'rp-chart')}
        <div class="rp-table">${$('cmp-table').outerHTML}</div>
        <h3>Analyse</h3><div>${$('cmp-analysis').innerHTML}</div>`;
    }
    body += `<h2>${comparison ? 'Scénario affiché sur la carte' : 'Carte'}</h2>
      ${img(map, 'Carte', 'rp-map')}<p class="rp-cap">${escHtml(what)}${legend ? '' : ''}</p>
      ${legend ? `<div class="rp-maplegend">${legend}</div>` : ''}`;
    if (!comparison) {
      const hydro = canvasImage('hydro');
      if (hydro) body += `<h2>Débits (m³/s)</h2>${img(hydro, 'Hydrogrammes', 'rp-chart')}<div class="rp-legend">${$('gauge-legend').innerHTML}</div>`;
      const ep = !$('ep-compare-box').hidden && canvasImage('ep-chart');
      if (ep) body += `<h2>Comparaison aux débits mesurés</h2>${img(ep, 'Simulé et mesuré', 'rp-chart')}<p>${$('ep-stats').innerHTML}</p>`;
    }
    const sec = !$('section-dock').hidden && canvasImage('section-canvas');
    if (sec) body += `<h2>Coupe en travers</h2>${img(sec, 'Coupe', 'rp-chart')}`;
    if (run?.maxima) body += `<h2>Résultats</h2><div class="rp-summary">${$('summary').innerHTML}</div>`;
    if (run?.params) body += `<h2>Hypothèses</h2>${paramsTable(p, run)}`;
    body += `<h2>Limites</h2>${LIMITS}`;
    const d = shareData();
    if (d) body += `<p class="rp-link">Scénario relançable : <a href="${escHtml(shareUrl(d))}">lien du scénario</a> (contient la position du lieu et les réglages).</p>`;
    const el = $('report-print');
    el.innerHTML = `<header><h1>Simulation de crue${place ? ` — ${escHtml(place)}` : ''}</h1>
      <p>${escHtml(date)} · ${escHtml(location.origin + location.pathname)}</p></header>${body}`;
    // Laisse les images se décoder avant l'impression
    await Promise.all([...el.querySelectorAll('img')].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)))));
    window.print();
  } finally {
    if (btn) btn.disabled = false;
  }
}
