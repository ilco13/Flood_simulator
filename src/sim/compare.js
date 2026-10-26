// Comparaison de scénarios simulés sur le même lieu et la même maille : indicateurs chiffrés,
// analyse rédigée (qualitative), et carte des écarts de hauteur maximale.

const nf = (v, d = 0) => Number(v).toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export const fmtQ = (q) => `${nf(q, q < 10 ? 1 : 0)} m³/s`;
export const fmtVol = (v) =>
  v < 1e3 ? `${nf(v)} m³` : v < 1e6 ? `${nf(v / 1e3, v < 1e4 ? 1 : 0)} milliers de m³` : `${nf(v / 1e6, v < 1e7 ? 2 : 1)} millions de m³`;
export const fmtSurf = (km2) => (km2 < 1 ? `${nf(km2 * 100, km2 < 0.1 ? 1 : 0)} ha` : `${nf(km2, km2 < 10 ? 2 : 1)} km²`);
export const fmtDepthC = (h) => (h < 1 ? `${nf(h * 100)} cm` : `${nf(h, 2)} m`);
export const fmtDurC = (s) => {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${h} h`;
};
export const AMC_NAME = { 1: 'sec', 2: 'normal', 3: 'saturé' };

/** Temps de concentration approché (h) d'un bassin de A km² (même formule que l'estimation du calcul). */
export const concentrationHours = (areaKm2) => Math.max(0.5, 0.6 * Math.max(0.01, areaKm2) ** 0.4);

/** Durée (s) pendant laquelle une série [[t, v]] dépasse `thr` (interpolation linéaire). */
export function durationAbove(series, thr) {
  let s = 0;
  for (let i = 1; i < series.length; i++) {
    const [t0, a] = series[i - 1];
    const [t1, b] = series[i];
    const dt = t1 - t0;
    if (a >= thr && b >= thr) s += dt;
    else if (a >= thr || b >= thr) s += (dt * (Math.max(a, b) - thr)) / Math.abs(b - a);
  }
  return s;
}

/** Volume (m³) sous un hydrogramme [[t (s), Q (m³/s)]]. */
export function volumeOf(series) {
  let v = 0;
  for (let i = 1; i < series.length; i++) v += ((series[i][1] + series[i - 1][1]) / 2) * (series[i][0] - series[i - 1][0]);
  return v;
}

/**
 * Indicateurs d'une simulation terminée.
 * @param o.series      hydrogramme du point de suivi principal [[t, Q]]
 * @param o.gaugeAreaKm2 surface drainée à ce point (pour la part de pluie écoulée)
 * @param o.hmax,tmax,vmax  maxima par maille ; o.mask : mailles du bassin (ou null)
 * @param o.placeK      maille du point étudié (-1 si hors grille) ; o.placeSeries [[t, h]]
 */
export function runMetrics(o) {
  const { series, gaugeAreaKm2, hmax, tmax, vmax, mask, cellKm2, placeK, placeSeries, rainMm } = o;
  let qPeak = 0;
  let tPeak = 0;
  for (const [t, q] of series) if (q > qPeak) [qPeak, tPeak] = [q, t];
  const volume = volumeOf(series);
  const rainVol = (rainMm / 1000) * gaugeAreaKm2 * 1e6;
  let a10 = 0;
  let a50 = 0;
  let a100 = 0;
  for (let k = 0; k < hmax.length; k++) {
    if (mask && !mask[k]) continue;
    const h = hmax[k];
    if (h >= 0.1) a10++;
    if (h >= 0.5) a50++;
    if (h >= 1) a100++;
  }
  const ok = placeK >= 0;
  return {
    qPeak,
    tPeak,
    volume,
    share: rainVol > 0 ? volume / rainVol : null,
    a10: a10 * cellKm2,
    a50: a50 * cellKm2,
    a100: a100 * cellKm2,
    hPlace: ok ? hmax[placeK] : 0,
    tPlace: ok ? tmax[placeK] : null,
    vPlace: ok && vmax ? vmax[placeK] : 0,
    wetPlace: placeSeries?.length ? durationAbove(placeSeries, 0.1) : 0,
  };
}

/** Aléa indicatif (grille hauteur × vitesse usuelle des PPRI). */
export function hazardOf(h, v) {
  if (h < 0.05) return null;
  if (h >= 1) return 'fort';
  if (h >= 0.5) return v >= 0.5 ? 'fort' : 'modéré';
  return v >= 1 ? 'fort' : v >= 0.5 ? 'modéré' : 'faible';
}

const ratio = (b, a) => (a > 1e-6 ? b / a : Infinity);
const fmtRatio = (r) => (!Number.isFinite(r) ? 'apparition' : r < 0.95 ? `−${nf((1 - r) * 100)} %` : `×${nf(r, r < 10 ? 1 : 0)}`);

/**
 * Analyse rédigée d'une comparaison.
 * @param scs [{ label, p: { rainMm, rainH, amc }, m: runMetrics(...) }] — le premier sert de référence
 * @param ctx { areaKm2 } surface drainée au point de suivi principal
 * @returns liste de paragraphes HTML
 */
export function analyseComparison(scs, { areaKm2 }) {
  const out = [];
  if (scs.length < 2) return out;
  const L = (s) => `« ${esc(s.label)} »`;
  const worst = (f) => scs.reduce((a, b) => (f(b.m) > f(a.m) ? b : a));
  const wq = worst((m) => m.qPeak);
  const wv = worst((m) => m.volume);
  const wa = worst((m) => m.a10);
  const wh = worst((m) => m.hPlace);
  const placeWet = scs.some((s) => s.m.hPlace >= 0.1);

  // 1. Verdict
  if (wq === wv && wq === wa && (!placeWet || wh === wq)) {
    out.push(
      `<strong>${L(wq)} est le scénario le plus défavorable sur tous les critères</strong> : pic de ${fmtQ(wq.m.qPeak)} au droit du lieu, ` +
        `${fmtVol(wq.m.volume)} écoulés, ${fmtSurf(wq.m.a10)} sous plus de 10 cm d'eau` +
        (placeWet ? `, ${fmtDepthC(wq.m.hPlace)} au point étudié.` : '.'),
    );
  } else {
    const items = [
      `<li>débit de pointe : <strong>${L(wq)}</strong> (${fmtQ(wq.m.qPeak)})</li>`,
      `<li>volume écoulé : <strong>${L(wv)}</strong> (${fmtVol(wv.m.volume)})</li>`,
      `<li>surface inondée : <strong>${L(wa)}</strong> (${fmtSurf(wa.m.a10)})</li>`,
    ];
    if (placeWet) items.push(`<li>hauteur au point étudié : <strong>${L(wh)}</strong> (${fmtDepthC(wh.m.hPlace)})</li>`);
    out.push(`Le scénario le plus défavorable dépend du critère :<ul>${items.join('')}</ul>`);
  }

  // 2. Écarts avec la référence (premier scénario)
  const ref = scs[0];
  const rows = scs.slice(1).map((s) => {
    const dt = s.m.tPeak - ref.m.tPeak;
    const when = Math.abs(dt) < 600 ? 'à peu près à la même heure' : `${fmtDurC(Math.abs(dt))} plus ${dt < 0 ? 'tôt' : 'tard'}`;
    let t = `<li><strong>${L(s)}</strong> : pic ${fmtRatio(ratio(s.m.qPeak, ref.m.qPeak))} (${fmtQ(ref.m.qPeak)} → ${fmtQ(s.m.qPeak)}), atteint ${when} ; `;
    t += `volume ${fmtRatio(ratio(s.m.volume, ref.m.volume))} ; surface inondée ${fmtSurf(ref.m.a10)} → ${fmtSurf(s.m.a10)}`;
    if (placeWet) t += ` ; au point étudié ${fmtDepthC(ref.m.hPlace)} → ${fmtDepthC(s.m.hPlace)}`;
    return `${t}.</li>`;
  });
  out.push(`Par rapport à ${L(ref)} :<ul>${rows.join('')}</ul>`);

  // 3. Lecture hydrologique selon ce qui varie
  const differ = (f) => scs.some((s) => f(s.p) !== f(ref.p));
  const vRain = differ((p) => p.rainMm);
  const vDur = differ((p) => p.rainH);
  const vAmc = differ((p) => p.amc);
  const vAval = differ((p) => p.avalQ || 0);
  if (vAval && !vRain && !vDur && !vAmc) {
    const lo = scs.reduce((a, b) => ((b.p.avalQ || 0) < (a.p.avalQ || 0) ? b : a));
    const hi = scs.reduce((a, b) => ((b.p.avalQ || 0) > (a.p.avalQ || 0) ? b : a));
    const dH = hi.m.hPlace - lo.m.hPlace;
    let t = `Seul le débit de la rivière aval change (${lo.p.avalQ ? fmtQ(lo.p.avalQ) : 'pas de crue'} → ${fmtQ(hi.p.avalQ)}). `;
    if (Math.abs(dH) >= 0.02 && Math.max(hi.m.hPlace, lo.m.hPlace) >= 0.05)
      t += `Au point étudié, l'eau ${dH > 0 ? 'monte' : 'baisse'} de <strong>${fmtDepthC(Math.abs(dH))}</strong> (${fmtDepthC(lo.m.hPlace)} → ${fmtDepthC(hi.m.hPlace)})${dH > 0 ? ' : la rivière haute freine l\'écoulement du cours d\'eau étudié, dont l\'eau s\'accumule en amont de la confluence (remous)' : ''}. `;
    else t += 'Au point étudié, le niveau ne change pas (moins de 2 cm) : le remous ne remonte pas jusque-là (confluence trop loin ou trop en contrebas). ';
    t += `Surface inondée sur le bassin du cours d'eau : ${fmtSurf(lo.m.a10)} → ${fmtSurf(hi.m.a10)} ; débit de pointe au droit du lieu : ${fmtQ(lo.m.qPeak)} → ${fmtQ(hi.m.qPeak)}.`;
    out.push(t);
  } else if (vAmc && !vRain && !vDur) {
    const sorted = [...scs].sort((a, b) => a.p.amc - b.p.amc);
    const lo = sorted[0];
    const hi = sorted[sorted.length - 1];
    const r = ratio(hi.m.qPeak, lo.m.qPeak);
    let t = 'Seul l\'état du sol change. Sur sol sec, les premiers millimètres s\'infiltrent ; sur sol saturé, presque toute la pluie ruisselle dès le début. ';
    if (scs.some((s) => s.p.capInf))
      t += 'Mais un sol, même sec, n\'absorbe qu\'un certain débit : quand la pluie tombe plus vite, l\'excédent ruisselle quel que soit l\'état du sol, ce qui réduit l\'écart sous les orages violents. ';
    if (scs.every((s) => s.m.share != null))
      t += `Part de la pluie passée au droit du lieu : ${sorted.map((s) => `${AMC_NAME[s.p.amc]} ${nf(Math.min(1, s.m.share) * 100)} %`).join(', ')}. `;
    if (r >= 2)
      t += `Le bassin est <strong>très sensible</strong> à l'humidité du sol : la même pluie donne un pic ${fmtRatio(r)} entre sol sec et sol saturé. Une pluie qui suit plusieurs jours pluvieux est donc nettement plus dangereuse.`;
    else if (r >= 1.3)
      t += `Le bassin est <strong>sensible</strong> à l'humidité du sol (pic ${fmtRatio(r)} entre sol sec et sol saturé).`;
    else
      t += `Le bassin est <strong>peu sensible</strong> à l'humidité du sol (pic ${fmtRatio(r)} entre sol sec et sol saturé) : avec cette pluie, le sol (peu perméable, urbanisé, ou dépassé par l'intensité) ruisselle déjà beaucoup, même sec.`;
    out.push(t);
  } else if (vDur) {
    const tc = concentrationHours(areaKm2);
    const short = scs.reduce((a, b) => (b.p.rainH < a.p.rainH ? b : a));
    const long = scs.reduce((a, b) => (b.p.rainH > a.p.rainH ? b : a));
    const iS = short.p.rainMm / short.p.rainH;
    const iL = long.p.rainMm / long.p.rainH;
    let t =
      `Temps de concentration estimé au droit du lieu : <strong>≈ ${fmtDurC(tc * 3600)}</strong> (temps que met l'eau tombée au plus loin du bassin pour arriver). ` +
      `${L(short)} tombe en ${nf(short.p.rainH, 1)} h à ${nf(iS, 1)} mm/h en moyenne, ${L(long)} en ${nf(long.p.rainH, 1)} h à ${nf(iL, 1)} mm/h. `;
    if (short.m.qPeak > long.m.qPeak * 1.05)
      t += `La pluie courte, d'une durée ${short.p.rainH <= tc * 1.5 ? 'proche de ce temps' : 'pourtant plus longue que ce temps'}, fait arriver en même temps l'eau de tout le bassin avec une intensité ${fmtRatio(iS / iL)} plus forte : <strong>c'est elle qui donne le pic le plus fort</strong>, malgré un cumul ${short.p.rainMm < long.p.rainMm ? 'plus faible' : 'comparable'}. `;
    else if (long.m.qPeak > short.m.qPeak * 1.05)
      t += `Ici <strong>la pluie longue donne aussi le pic le plus fort</strong> : son cumul plus élevé sature peu à peu le sol, si bien qu'en fin d'épisode presque toute la pluie ruisselle, ce qui compense une intensité plus faible${long.p.rainH > 3 * tc ? ' (le bassin, lent à réagir, intègre la pluie sur plusieurs heures)' : ''}. `;
    else t += 'Les deux pluies donnent un pic semblable. ';
    if (long.m.volume > short.m.volume * 1.1)
      t += `En volume, ${L(long)} fait passer ${fmtVol(long.m.volume)} au droit du lieu contre ${fmtVol(short.m.volume)} (${fmtRatio(ratio(long.m.volume, short.m.volume))}) : c'est le scénario à retenir pour les volumes à stocker et la durée des débordements.`;
    out.push(t);
  } else if (vRain && !vAmc) {
    const lo = scs.reduce((a, b) => (b.p.rainMm < a.p.rainMm ? b : a));
    const hi = scs.reduce((a, b) => (b.p.rainMm > a.p.rainMm ? b : a));
    const rp = hi.p.rainMm / lo.p.rainMm;
    const rq = ratio(hi.m.qPeak, lo.m.qPeak);
    out.push(
      `Pluie ${fmtRatio(rp)} → pic ${fmtRatio(rq)} : ` +
        (rq > rp * 1.15
          ? 'la crue augmente plus vite que la pluie, car une fois le sol saturé chaque millimètre supplémentaire ruisselle.'
          : rq < rp * 0.85
            ? 'la crue augmente moins vite que la pluie (débordements et stockage dans les zones basses qui écrêtent le pic).'
            : 'la crue augmente à peu près comme la pluie.'),
    );
  }

  // 4. Au point étudié
  if (!placeWet) {
    const hm = Math.max(...scs.map((s) => s.m.hPlace));
    out.push(`Le point étudié reste hors d'eau dans tous les scénarios${hm >= 0.01 ? ` (au plus ${fmtDepthC(hm)} de ruissellement)` : ''}.`);
  } else {
    const items = scs.map((s) => {
      const hz = hazardOf(s.m.hPlace, s.m.vPlace);
      if (s.m.hPlace < 0.1) return `<li>${L(s)} : hors d'eau</li>`;
      return (
        `<li>${L(s)} : ${fmtDepthC(s.m.hPlace)} au maximum` +
        (s.m.wetPlace > 0 ? `, plus de 10 cm pendant ≈ ${fmtDurC(s.m.wetPlace)}` : '') +
        `, courant jusqu'à ${nf(s.m.vPlace, 1)} m/s` +
        (hz ? ` — aléa <strong>${hz}</strong>` : '') +
        '</li>'
      );
    });
    out.push(`Au point étudié :<ul>${items.join('')}</ul><small>Aléa indicatif d'après la grille hauteur × vitesse des plans de prévention (fort au-delà d'1 m, ou de 50 cm avec un courant de 0,5 m/s).</small>`);
  }
  return out;
}

/* ---------- Carte des écarts de hauteur maximale ---------- */

export const DIFF_MAX = 1; // m : écart pour la couleur la plus foncée

/**
 * Codes 0–255 d'écart B − A : 0 = sec dans les deux, 128 = inondé dans les deux sans écart
 * notable (< 5 cm), au-dessus = plus haut dans B, au-dessous = plus bas dans B.
 */
export function diffCodes(hA, hB, mask) {
  const out = new Uint8Array(hA.length);
  const st = { more: 0, less: 0, newWet: 0, newDry: 0 };
  for (let k = 0; k < hA.length; k++) {
    if (mask && !mask[k]) continue;
    const a = hA[k];
    const b = hB[k];
    if (a < 0.1 && b < 0.1) continue;
    const d = b - a;
    if (a < 0.1) st.newWet++;
    else if (b < 0.1) st.newDry++;
    if (Math.abs(d) < 0.05) {
      out[k] = 128;
      continue;
    }
    if (d > 0) st.more++;
    else st.less++;
    const r = Math.sqrt(Math.min(Math.abs(d), DIFF_MAX) / DIFF_MAX);
    out[k] = d > 0 ? Math.min(255, 129 + Math.round(r * 126)) : Math.max(1, 127 - Math.round(r * 126));
  }
  return { codes: out, stats: st };
}

const lerp = (a, b, t) => a + (b - a) * t;
const UP = [[254, 204, 92], [240, 59, 32], [140, 0, 30]];
const DOWN = [[166, 219, 240], [49, 130, 189], [30, 40, 120]];
function ramp(stops, t) {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  return stops[i].map((v, c) => Math.round(lerp(v, stops[i + 1][c], f)));
}
/** Couleur RGB d'un écart (m) pour la légende. */
export const diffColor = (d) => (d >= 0 ? ramp(UP, Math.sqrt(Math.min(d, DIFF_MAX) / DIFF_MAX)) : ramp(DOWN, Math.sqrt(Math.min(-d, DIFF_MAX) / DIFF_MAX)));

export function buildDiffLut() {
  const lut = new Uint32Array(256);
  for (let v = 1; v < 256; v++) {
    let rgb;
    let al;
    if (v === 128) {
      rgb = [150, 160, 170];
      al = 0.45;
    } else {
      const r = Math.abs(v - 128) / 127;
      rgb = v > 128 ? ramp(UP, r) : ramp(DOWN, r);
      al = 0.6 + 0.3 * r;
    }
    lut[v] = (Math.round(al * 255) << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0];
  }
  return lut;
}
