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

export async function fetchWithRetry(url, { tries = 4, signal } = {}) {
  let lastErr;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(url, { signal });
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
      await new Promise((r) => setTimeout(r, 1000 * 2 ** a));
    }
  }
  throw lastErr;
}

async function cachedBuffer(url, signal) {
  const hit = await cacheGet(url);
  if (hit) return hit;
  const buf = await fetchWithRetry(url, { signal });
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
export async function fetchFloatGrid(grid, layer, fallbackLayer, { onProgress, signal } = {}) {
  const out = new Float32Array(grid.nx * grid.ny);
  const blocks = blocksOf(grid);
  let done = 0;
  await runPool(blocks, 4, async (b) => {
    const url = getMapUrl(layer, b.bbox, b.w, b.h, 'image/x-bil;bits=32');
    let data = new Float32Array(await cachedBuffer(url, signal));
    if (data.length !== b.w * b.h) throw new Error('Taille de bloc MNT inattendue');
    let holes = 0;
    for (let k = 0; k < data.length; k++) if (!(data[k] > -1000)) holes++;
    if (holes > 0 && fallbackLayer) {
      const url2 = getMapUrl(fallbackLayer, b.bbox, b.w, b.h, 'image/x-bil;bits=32');
      const fb = new Float32Array(await cachedBuffer(url2, signal));
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

/** Télécharge une couche image (PNG) et renvoie les pixels RGBA sur la grille. */
export async function fetchRgbaGrid(grid, layer, { onProgress, signal } = {}) {
  const out = new Uint8ClampedArray(grid.nx * grid.ny * 4);
  const blocks = blocksOf(grid);
  let done = 0;
  await runPool(blocks, 4, async (b) => {
    const url = getMapUrl(layer, b.bbox, b.w, b.h, 'image/png');
    const buf = await cachedBuffer(url, signal);
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const cv = new OffscreenCanvas(b.w, b.h);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, b.w, b.h).data;
    for (let r = 0; r < b.h; r++) {
      out.set(px.subarray(r * b.w * 4, (r + 1) * b.w * 4), ((b.j0 + r) * grid.nx + b.i0) * 4);
    }
    done++;
    onProgress?.(done / blocks.length);
  });
  return out;
}
