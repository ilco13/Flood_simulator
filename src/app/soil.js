import { toWgs } from '../geo.js';
import { $, fmtNum, state } from './core.js';
import { updateRainInfo } from './params.js';
import { fetchWithTimeout } from './saved.js';
import { saveStudy, studyCands } from './study.js';

/* ---------- Type de sol automatique (texture SoilGrids, ISRIC) ---------- */

export const SOIL_LABEL = { 1: 'perméable', 2: 'moyen', 3: 'peu perméable' };

/** Texture (argile, sable en %) d'un point, d'après SoilGrids (surface et 30-60 cm). */
export async function soilTexture(lon, lat) {
  const q = new URLSearchParams({ lon: lon.toFixed(5), lat: lat.toFixed(5), value: 'mean' });
  for (const pr of ['clay', 'sand']) q.append('property', pr);
  for (const d of ['0-5cm', '30-60cm']) q.append('depth', d);
  // Service parfois lent ou limité en débit : jusqu'à 3 essais espacés.
  let res;
  for (let a = 0; a < 3; a++) {
    try {
      res = await fetchWithTimeout(`https://rest.isric.org/soilgrids/v2.0/properties/query?${q}`, 25000);
      if (res.ok) break;
    } catch (e) {
      if (a === 2) throw e;
    }
    await new Promise((r) => setTimeout(r, 4000 * (a + 1)));
  }
  if (!res?.ok) throw new Error(`SoilGrids HTTP ${res?.status}`);
  const layers = (await res.json()).properties?.layers || [];
  const get = (name) =>
    (layers.find((l) => l.name === name)?.depths || []).map((d) => d.values?.mean).filter((v) => v != null).map((v) => v / 10);
  const clay = get('clay');
  const sand = get('sand');
  if (!clay.length) return null; // zone urbaine, eau… : pas de donnée
  return { clay: Math.max(...clay), sand: sand.length ? sand[0] : null };
}

/**
 * Groupe hydrologique (méthode SCS) déduit de la texture : l'argile (horizon le plus argileux)
 * freine l'infiltration. < 20 % : perméable (B) ; 20-40 % : moyen (C) ; > 40 % : peu perméable (D).
 */
export const soilGroupOf = (clay) => (clay < 20 ? 1 : clay <= 40 ? 2 : 3);

/** Texture moyenne du lieu étudié et de ses bassins (quelques points, pondérés par la surface). */
export async function fetchSoil() {
  const s = state.study;
  if (!s) return;
  s.soil = { pending: true };
  renderSoilInfo();
  const pts = [{ ll: s.houseWgs, w: 0.3 }];
  for (const c of studyCands().filter((c) => c.kind === 'stream').slice(0, 3)) {
    const b = c.bbox;
    pts.push({ ll: toWgs((b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2), w: Math.max(0.3, c.areaKm2) });
  }
  let sw = 0;
  let clay = 0;
  let sand = 0;
  let sandW = 0;
  for (const pt of pts) {
    try {
      const t = await soilTexture(pt.ll[0], pt.ll[1]);
      if (!t) continue;
      sw += pt.w;
      clay += pt.w * t.clay;
      if (t.sand != null) {
        sand += pt.w * t.sand;
        sandW += pt.w;
      }
    } catch (e) {
      console.warn('Texture du sol indisponible', e);
    }
  }
  if (state.study !== s) return;
  s.soil = sw ? { group: soilGroupOf(clay / sw), clay: clay / sw, sand: sandW ? sand / sandW : null } : { failed: true };
  saveStudy();
  renderSoilInfo();
  updateRainInfo();
}

export function renderSoilInfo() {
  const el = $('soil-info');
  const mode = $('soil').value;
  if (mode !== 'auto') {
    el.innerHTML = `Type de sol : <strong>${SOIL_LABEL[mode]}</strong> (choisi dans les options avancées).`;
    return;
  }
  const soil = state.study?.soil;
  if (!state.study) el.textContent = 'Type de sol : déduit automatiquement du lieu étudié.';
  else if (soil?.pending) el.textContent = 'Recherche de la texture du sol…';
  else if (soil?.group)
    el.innerHTML =
      `Type de sol : <strong>${SOIL_LABEL[soil.group]}</strong>, d'après sa texture ` +
      `(argile ${fmtNum(soil.clay)} %${soil.sand != null ? `, sable ${fmtNum(soil.sand)} %` : ''} ; SoilGrids). ` +
      'Modifiable dans les options avancées.';
  else el.textContent = 'Type de sol : moyen (texture du sol indisponible ici). Modifiable dans les options avancées.';
}
