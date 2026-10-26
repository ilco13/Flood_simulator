import { renderAval } from './aval.js';
import { $, fmtArea, fmtNum, state } from './core.js';
import { fetchWithTimeout } from './saved.js';
import { studyCands } from './study.js';

/* ---------- Pluies de référence (stations Météo-France proches) ---------- */

/** Département(s) du lieu : le sien d'abord, puis ceux à moins de ~20 km. */
export async function departmentsAround(lon, lat) {
  const deps = [];
  const pts = [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.18], [0, -0.18]];
  for (const [dx, dy] of pts) {
    try {
      const res = await fetchWithTimeout(
        `https://data.geopf.fr/geocodage/reverse?lon=${lon + dx}&lat=${lat + dy}&index=address&limit=1`,
        8000,
      );
      const code = (await res.json()).features?.[0]?.properties?.citycode;
      if (!code) continue;
      let dep = code.startsWith('97') ? code.slice(0, 3) : code.slice(0, 2);
      if (dep === '2A' || dep === '2B') dep = '20';
      if (!deps.includes(dep)) deps.push(dep);
    } catch {
      /* point en mer ou service indisponible */
    }
  }
  return deps.slice(0, 3);
}

export async function fetchRainRef() {
  const s = state.study;
  if (!s) return;
  const el = $('rain-ref');
  state.rainWorker?.terminate();
  el.innerHTML = '<p class="hint">Recherche des pluies observées près du lieu (stations Météo-France)…</p>';
  const [lon, lat] = s.houseWgs;
  const deps = await departmentsAround(lon, lat);
  if (state.study !== s) return;
  if (!deps.length) {
    el.innerHTML = '<p class="hint">Pluies observées indisponibles ici (hors France ?).</p>';
    return;
  }
  const w = new Worker(new URL('../data/rainWorker.js', import.meta.url), { type: 'module' });
  state.rainWorker = w;
  w.onmessage = (e) => {
    const m = e.data;
    if (state.study !== s) return w.terminate();
    if (m.type === 'progress')
      el.innerHTML =
        `<p class="hint">Lecture des pluies journalières Météo-France depuis 1950 (département ${m.k}/${m.n}) : ` +
        `${fmtNum(m.mb, 1)}${m.totalMb ? ` / ${fmtNum(m.totalMb, 0)}` : ''} Mo…</p>`;
    else if (m.type === 'done') {
      w.terminate();
      s.rainRef = m;
      renderRainRef();
    } else if (m.type === 'error') {
      w.terminate();
      el.innerHTML = `<p class="hint">Pluies observées indisponibles : ${m.message}.</p>`;
    }
  };
  w.onerror = () => {
    w.terminate();
    el.innerHTML = '<p class="hint">Pluies observées indisponibles.</p>';
  };
  w.postMessage({ lon, lat, deps });
}

// Pluie journalière (6 h–6 h) → pluie maximale sur 24 h glissantes (coefficient usuel).
export const DAY_TO_24H = 1.13;
// Part de la pluie de 24 h tombant en 3 h lors d'un épisode intense (ordre de grandeur).
export const RATIO_3H = 0.75;

/**
 * Coefficient d'abattement spatial : la pluie de référence est mesurée en un point ; la pluie
 * moyenne sur un bassin de A km² pendant D heures est plus faible (Leclerc et Schaake, 1972,
 * d'après les courbes de l'US Weather Bureau) : 1 − e^(−1,1·D^¼) + e^(−1,1·D^¼ − 0,01·A[mi²]).
 */
export function arealReduction(areaKm2, hours) {
  const k = Math.exp(-1.1 * hours ** 0.25);
  return Math.min(1, 1 - k + k * Math.exp(-0.01 * (areaKm2 / 2.59)));
}

export function renderRainRef() {
  const el = $('rain-ref');
  const ref = state.study?.rainRef;
  if (!ref) {
    el.innerHTML = '';
    return;
  }
  const st = ref.stations;
  const near = st.filter((x) => x.d <= 15);
  const pool = (near.filter((x) => x.q100 != null).length >= 2 ? near : st).filter((x) => x.q100 != null);
  if (!st.length) {
    el.innerHTML = '<p class="hint">Aucune station Météo-France à moins de 25 km.</p>';
    return;
  }
  const wsum = pool.reduce((a, x) => a + 1 / (x.d + 3), 0);
  const avg = (k) => pool.reduce((a, x) => a + x[k] / (x.d + 3), 0) / wsum;
  const fmtDay = (d) => `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`;
  const scen = [];
  if (pool.length) {
    const q10 = avg('q10') * DAY_TO_24H;
    const q100 = avg('q100') * DAY_TO_24H;
    scen.push({ label: 'Décennale', mm: q10, h: 24, note: 'pluie qui revient en moyenne tous les 10 ans' });
    scen.push({ label: 'Centennale', mm: q100, h: 24, note: 'pluie qui revient en moyenne tous les 100 ans' });
    scen.push({ label: 'Orage centennal', mm: q100 * RATIO_3H, h: 3, note: 'estimé : 75 % de la pluie centennale de 24 h tombée en 3 h (orages méditerranéens)' });
  }
  const recSet = near.length ? near : st;
  const rec = recSet.reduce((a, x) => (x.record.mm > a.record.mm ? x : a), recSet[0]);
  if (rec?.record.day)
    scen.push({
      label: 'Record observé',
      mm: rec.record.mm,
      h: 24,
      note: `${fmtNum(rec.record.mm)} mm le ${fmtDay(rec.record.day)} à ${rec.name} (${fmtNum(rec.d)} km)`,
    });
  // Plus forts épisodes (une date = un épisode, maximum des stations proches)
  const ev = new Map();
  for (const x of recSet)
    for (const [day, mm] of x.top) if (!ev.has(day) || ev.get(day).mm < mm) ev.set(day, { day, mm, name: x.name, d: x.d });
  const events = [...ev.values()].sort((a, b) => b.mm - a.mm).slice(0, 8);
  // Pluie moyenne sur les bassins retenus (abattement), arrondie au mm
  const areaKm2 = studyCands().reduce((a, c) => a + c.areaKm2, 0);
  for (const sc of scen) {
    sc.arf = arealReduction(areaKm2, sc.h);
    sc.point = sc.mm;
    sc.mm = sc.mm * sc.arf;
    if (sc.arf < 0.995) sc.note += ` ; ${fmtNum(sc.point)} mm au point, ${fmtNum(sc.mm)} mm en moyenne sur ${fmtArea(areaKm2)} (abattement ×${fmtNum(sc.arf, 2)})`;
  }
  if (state.study) {
    state.study.rainScen = scen;
    // Pluies journalières décennale et centennale (pour estimer les crues de la rivière aval)
    if (pool.length) {
      const hadPj = !!state.study.pj;
      state.study.pj = { q10: avg('q10'), q100: avg('q100') };
      if (!hadPj) renderAval();
    }
  }
  const btn = (sc, i) =>
    `<button type="button" class="ref-chip" data-i="${i}" title="${sc.note}"><strong>${sc.label}</strong>` +
    `<span>${fmtNum(sc.mm)} mm en ${sc.h} h</span></button>`;
  el.innerHTML =
    `<span class="lbl">Pluies de référence près du lieu${scen.some((x) => x.arf < 0.995) ? ' (moyennes sur le bassin)' : ''}</span>` +
    `<div class="ref-chips">${scen.map(btn).join('')}</div>` +
    `<details class="ref-events"><summary>Plus fortes pluies observées (${pool.length || st.length} stations Météo-France, depuis 1950)</summary><ul>` +
    events
      .map(
        (x, i) =>
          `<li><button type="button" class="link" data-e="${i}">${fmtDay(x.day)} : <strong>${fmtNum(x.mm)} mm</strong> en un jour à ${x.name} (${fmtNum(x.d)} km)</button></li>`,
      )
      .join('') +
    `</ul></details>`;
  const apply = (mm, h) => {
    $('rain-mm').value = Math.round(mm);
    $('rain-h').value = h;
    $('rain-mm').dispatchEvent(new Event('input'));
    $('rain-h').dispatchEvent(new Event('input'));
  };
  el.querySelectorAll('.ref-chip').forEach((b) => {
    b.onclick = () => {
      const sc = scen[Number(b.dataset.i)];
      apply(sc.mm, sc.h);
      el.querySelectorAll('.ref-chip').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  el.querySelectorAll('[data-e]').forEach((b) => {
    b.onclick = () => apply(events[Number(b.dataset.e)].mm * arealReduction(areaKm2, 24), 24);
  });
}
