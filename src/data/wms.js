import { WMS_R, WMS_BLOCK } from '../config.js';
import { cacheGet, cachePut } from './cache.js';

/** URL GetMap WMS 1.3.0 en Lambert 93 (ordre des axes x,y pour EPSG:2154). */
export function getMapUrl(layer, bbox, width, height, format) {
  const p = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: layer,
    STYLES: '',
    CRS: 'EPSG:2154',
    BBOX: `${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: format,
  });
  return `${WMS_R}?${p}`;
}

const REQUEST_TIMEOUT = 30000; // ms : au-delà, on relance la requête
// Attentes entre essais : les pannes passagères du service IGN durent parfois ~1 min.
const RETRY_WAIT = [1000, 3000, 8000, 15000, 30000];

export async function fetchWithRetry(url, { tries = 6, signal, onRetry, timeout = REQUEST_TIMEOUT } = {}) {
  let lastErr;
  for (let a = 0; a < tries; a++) {
    // Délai maximum par requête, combiné avec l'annulation demandée par l'appelant.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('délai dépassé')), timeout);
    const onAbort = () => ctrl.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      if (type.includes('xml')) {
        // Le WMS renvoie une exception XML avec un code 200 en cas d'erreur.
        const txt = await res.text();
        throw new Error(`Erreur WMS : ${txt.slice(0, 200)}`);
      }
      return await res.arrayBuffer();
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
      if (a < tries - 1) onRetry?.(a + 2, tries, e);
      if (a === tries - 1) break;
      await new Promise((r) => setTimeout(r, RETRY_WAIT[Math.min(a, RETRY_WAIT.length - 1)]));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

async function cachedBuffer(url, signal, onRetry, tries = 6) {
  const hit = await cacheGet(url);
  if (hit) return hit;
  const buf = await fetchWithRetry(url, { signal, onRetry, tries });
  await cachePut(url, buf);
  return buf;
}

/** Découpe la grille en blocs de WMS_BLOCK pixels au maximum. */
function blocksOf(grid) {
  const blocks = [];
  for (let j0 = 0; j0 < grid.ny; j0 += WMS_BLOCK) {
    for (let i0 = 0; i0 < grid.nx; i0 += WMS_BLOCK) {
      const w = Math.min(WMS_BLOCK, grid.nx - i0);
      const h = Math.min(WMS_BLOCK, grid.ny - j0);
      blocks.push({
        i0,
        j0,
        w,
        h,
        bbox: {
          xmin: grid.xmin + i0 * grid.dx,
          xmax: grid.xmin + (i0 + w) * grid.dx,
          ymax: grid.ymax - j0 * grid.dx,
          ymin: grid.ymax - (j0 + h) * grid.dx,
        },
      });
    }
  }
  return blocks;
}

async function runPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

/**
 * Télécharge une couche altimétrique en float32 (BIL) sur la grille.
 * Les trous éventuels du LiDAR HD sont comblés avec la couche de secours.
 */
export async function fetchFloatGrid(grid, layer, fallbackLayer, { onProgress, onRetry, signal, warnings } = {}) {
  const out = new Float32Array(grid.nx * grid.ny);
  const blocks = blocksOf(grid);
  let done = 0;
  await runPool(blocks, 4, async (b) => {
    const url = getMapUrl(layer, b.bbox, b.w, b.h, 'image/x-bil;bits=32');
    let data;
    try {
      data = new Float32Array(await cachedBuffer(url, signal, onRetry));
    } catch (e) {
      if (!fallbackLayer || signal?.aborted) throw e;
      // Service momentanément indisponible : bloc entier pris sur la couche de secours.
      console.warn('MNT principal indisponible, repli', e);
      warnings?.push(`relief : bloc pris dans ${fallbackLayer}`);
      data = new Float32Array(
        await cachedBuffer(getMapUrl(fallbackLayer, b.bbox, b.w, b.h, 'image/x-bil;bits=32'), signal, onRetry),
      );
    }
    if (data.length !== b.w * b.h) throw new Error('Taille de bloc MNT inattendue');
    let holes = 0;
    for (let k = 0; k < data.length; k++) if (!(data[k] > -1000)) holes++;
    if (holes > 0 && fallbackLayer) {
      const url2 = getMapUrl(fallbackLayer, b.bbox, b.w, b.h, 'image/x-bil;bits=32');
      const fb = new Float32Array(await cachedBuffer(url2, signal, onRetry));
      data = data.slice();
      for (let k = 0; k < data.length; k++) if (!(data[k] > -1000)) data[k] = fb[k];
    }
    for (let r = 0; r < b.h; r++) {
      out.set(data.subarray(r * b.w, (r + 1) * b.w), (b.j0 + r) * grid.nx + b.i0);
    }
    done++;
    onProgress?.(done / blocks.length);
  });
  return out;
}

async function decodePng(buf, w, h) {
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * Télécharge une couche image (PNG) et renvoie les pixels RGBA sur la grille.
 * Les pixels transparents (zone non couverte) sont complétés par la couche de repli.
 */
export async function fetchRgbaGrid(grid, layer, fallbackLayer, { onProgress, onRetry, signal, warnings } = {}) {
  const out = new Uint8ClampedArray(grid.nx * grid.ny * 4);
  const blocks = blocksOf(grid);
  let done = 0;
  await runPool(blocks, 4, async (b) => {
    const load = async (lyr, tries) =>
      decodePng(await cachedBuffer(getMapUrl(lyr, b.bbox, b.w, b.h, 'image/png'), signal, onRetry, tries), b.w, b.h);
    let px;
    try {
      // 3 essais sur le millésime récent, puis bascule sur le précédent (plus rapide que d'insister).
      px = await load(layer, 3);
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn(`${layer} indisponible`, e);
      // Bloc vide : il sera entièrement complété par la couche de repli.
      px = new Uint8ClampedArray(b.w * b.h * 4);
    }
    let holes = 0;
    for (let k = 3; k < px.length; k += 4) if (px[k] < 128) holes++;
    // Trous (zone non couverte par ce millésime) : millésimes précédents, dans l'ordre.
    const fallbacks = Array.isArray(fallbackLayer) ? fallbackLayer : fallbackLayer ? [fallbackLayer] : [];
    for (const fbLayer of fallbacks) {
      if (!holes) break;
      let fb = null;
      try {
        fb = await load(fbLayer, 4);
      } catch (e) {
        if (signal?.aborted) throw e;
        console.warn(`${fbLayer} indisponible`, e);
        continue;
      }
      holes = 0;
      for (let k = 0; k < px.length; k += 4) {
        if (px[k + 3] < 128) {
          px[k] = fb[k];
          px[k + 1] = fb[k + 1];
          px[k + 2] = fb[k + 2];
          px[k + 3] = fb[k + 3];
          if (fb[k + 3] < 128) holes++;
        }
      }
    }
    if (holes > 0) warnings?.push('occupation du sol incomplète (classe « autre » utilisée)');
    for (let r = 0; r < b.h; r++) {
      out.set(px.subarray(r * b.w * 4, (r + 1) * b.w * 4), ((b.j0 + r) * grid.nx + b.i0) * 4);
    }
    done++;
    onProgress?.(done / blocks.length);
  });
  return out;
}
