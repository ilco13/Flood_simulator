import maplibregl from 'maplibre-gl';
import { $, state } from './core.js';
import { studyPlace } from './study.js';

/* ---------- Recherche de lieu (géocodage IGN) ---------- */

export function setupSearch() {
  const input = $('place-search');
  const list = $('place-results');
  let timer = null;
  let ctrl = null;
  let items = [];
  let active = -1;
  input.closest('.search').addEventListener('click', (e) => e.stopPropagation());
  const close = () => {
    list.hidden = true;
    active = -1;
  };
  const render = () => {
    list.innerHTML = '';
    items.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = i === active ? 'on' : '';
      const kind = r.country === 'PositionOfInterest' ? (r.poiType?.[0] || r.kind || '') : r.kind === 'street' ? 'voie' : 'adresse';
      li.innerHTML = `<span></span><small></small>`;
      li.firstChild.textContent = r.fulltext;
      li.lastChild.textContent = kind;
      li.onmousedown = (e) => {
        e.preventDefault();
        choose(r);
      };
      list.appendChild(li);
    });
    list.hidden = !items.length;
  };
  const choose = (r) => {
    input.value = r.fulltext;
    close();
    input.blur();
    const poi = r.country === 'PositionOfInterest';
    const big = poi && /commune|ville|village/i.test((r.poiType || []).join(' '));
    state.map.flyTo({ center: [r.x, r.y], zoom: big ? 13 : 15.5, duration: 1200 });
    if (!state.searchMarker) {
      const el = document.createElement('div');
      el.className = 'search-pin';
      state.searchMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' });
    }
    state.searchMarker.setLngLat([r.x, r.y]).addTo(state.map);
    // En mode « lieu étudié », le lieu cherché est analysé directement.
    if (!state.run?.running) studyPlace(r.x, r.y);
    if (window.matchMedia('(max-width: 760px)').matches) $('panel').classList.add('collapsed');
  };
  const search = async (text) => {
    ctrl?.abort();
    ctrl = new AbortController();
    const q = new URLSearchParams({
      text,
      type: 'PositionOfInterest,StreetAddress',
      maximumResponses: '7',
      lonlat: '5.6,43.47', // priorité aux résultats proches de la vallée de l'Arc
    });
    try {
      const res = await fetch(`https://data.geopf.fr/geocodage/completion?${q}`, { signal: ctrl.signal });
      const json = await res.json();
      items = (json.results || []).filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y));
      active = -1;
      render();
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('Recherche de lieu indisponible', e);
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    ctrl?.abort();
    items = []; // pas de validation d'une suggestion périmée
    close();
    const t = input.value.trim();
    if (t.length < 3) {
      items = [];
      close();
      return;
    }
    timer = setTimeout(() => search(t), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length) choose(items[Math.max(0, active)]);
    } else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('focus', () => items.length && render());
}
