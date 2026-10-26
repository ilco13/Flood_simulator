import { $ } from './core.js';

/* ---------- Avancement ---------- */

export const STEPS = {
  dem: { label: 'Téléchargement du relief LiDAR HD', weight: 0.12, pct: true },
  lc: { label: "Téléchargement de l'occupation du sol", weight: 0.12, pct: true },
  rivers: { label: 'Téléchargement des cours d\'eau', weight: 0.03 },
  prep: { label: 'Préparation du relief et du bassin versant', weight: 0.05 },
  sim: { label: 'Simulation de la crue', weight: 0.68, pct: true },
};

export const CONNECTING = 'Connexion aux services de l\'IGN…';
export const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Panneau d'avancement + badge sur la carte. */
export const prog = {
  st: {},
  timer: null,
  t0: 0,
  note: '',
  el(sel) {
    return $('progress').querySelector(sel);
  },
  start() {
    this.st = {};
    this.note = '';
    this.t0 = performance.now();
    $('progress').hidden = false;
    $('progress').classList.remove('error');
    $('map-status').className = '';
    clearInterval(this.timer);
    this.timer = setInterval(() => this.render(), 1000);
    this.render();
    $('progress').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
  set(step, p, detail) {
    if (this.note === CONNECTING) this.note = '';
    this.st[step] = { p: Math.max(0, Math.min(1, p)), detail };
    this.render();
  },
  status(text) {
    this.note = text;
    this.render();
  },
  overall() {
    let o = 0;
    for (const [k, def] of Object.entries(STEPS)) o += def.weight * (this.st[k]?.p ?? 0);
    return o;
  },
  render() {
    const pct = Math.floor(this.overall() * 100);
    const el = (performance.now() - this.t0) / 1000;
    this.el('.pct').textContent = `${pct} %`;
    this.el('.bar span').style.width = `${pct}%`;
    this.el('.elapsed').textContent = this.timer ? `écoulé ${fmtClock(el)}` : '';
    const active = [];
    for (const [k, def] of Object.entries(STEPS)) {
      const li = $('progress').querySelector(`[data-step="${k}"]`);
      const s = this.st[k];
      li.classList.toggle('done', !!s && s.p >= 1);
      li.classList.toggle('active', !!s && s.p < 1);
      const span = li.querySelector('span');
      if (!s) span.textContent = '';
      else if (s.p >= 1) span.textContent = s.detail || 'ok';
      else {
        span.textContent = [def.pct ? `${Math.floor(s.p * 100)} %` : '…', s.detail].filter(Boolean).join(' · ');
        active.push(def.label + (def.pct ? ` ${Math.floor(s.p * 100)} %` : '') + (s.detail && k !== 'sim' ? ` (${s.detail})` : ''));
      }
    }
    const text = this.note || (active.length ? `${active.join(' · ')}…` : '');
    this.el('.status').textContent = text;
    if (this.timer) {
      const badge = $('map-status');
      badge.hidden = false;
      badge.textContent = `⏳ ${pct} % · ${active[0] || this.note || 'Calcul'} · ${fmtClock(el)}`;
    }
  },
  stopTimer() {
    clearInterval(this.timer);
    this.timer = null;
  },
  finish(text, ok = true) {
    this.stopTimer();
    this.note = text;
    this.render();
    const badge = $('map-status');
    badge.hidden = false;
    badge.className = ok ? 'ok' : '';
    badge.textContent = `${ok ? '✓' : '■'} ${text}`;
    setTimeout(() => {
      if (!this.timer) badge.hidden = true;
    }, 8000);
  },
  error(text) {
    this.stopTimer();
    $('progress').hidden = false;
    $('progress').classList.add('error');
    this.note = text;
    this.render();
    const badge = $('map-status');
    badge.hidden = false;
    badge.className = 'error';
    badge.textContent = `⚠ ${text}`;
    $('progress').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
};
