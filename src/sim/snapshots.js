// Stockage des hauteurs d'eau successives, quantifiées sur 8 bits et compressées.
// Échelle racine carrée : précision ~1 cm vers 10 cm, ~5 cm vers 2 m, plafond 12 m.

export const DEPTH_CAP = 12;
// En dessous d'1 cm on stocke 0 : la lame d'eau de ruissellement diffus ne nous intéresse
// pas et cela rend les instantanés très compressibles.
const MIN_DEPTH = 0.01;

export function quantize(h) {
  const out = new Uint8Array(h.length);
  const inv = 1 / DEPTH_CAP;
  for (let k = 0; k < h.length; k++) {
    const v = h[k];
    if (v < MIN_DEPTH) continue;
    out[k] = Math.min(255, Math.round(Math.sqrt(Math.min(v, DEPTH_CAP) * inv) * 255));
  }
  return out;
}

export function dequantize(v) {
  const r = v / 255;
  return r * r * DEPTH_CAP;
}

const canCompress = typeof CompressionStream !== 'undefined';

export async function compress(bytes) {
  if (!canCompress) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Blob([await new Response(stream).arrayBuffer()]);
}

export async function decompress(stored) {
  if (!(stored instanceof Blob)) return stored;
  const stream = stored.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class SnapshotStore {
  constructor() {
    this.items = []; // { t, data }
    this.cache = new Map();
    this.bytes = 0;
  }
  async add(t, h) {
    const q = quantize(h);
    const data = await compress(q);
    this.items.push({ t, data });
    this.bytes += data.size ?? data.byteLength;
    this.cache.set(this.items.length - 1, q);
    this.#trim();
    return q;
  }
  #trim() {
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
  }
  get length() {
    return this.items.length;
  }
  timeOf(i) {
    return this.items[i]?.t ?? 0;
  }
  async get(i) {
    if (this.cache.has(i)) return this.cache.get(i);
    const q = await decompress(this.items[i].data);
    this.cache.set(i, q);
    this.#trim();
    return q;
  }
  /** Série temporelle de hauteur d'eau (m) en une maille. */
  async series(k) {
    const out = [];
    for (let i = 0; i < this.items.length; i++) {
      const q = await this.get(i);
      out.push([this.items[i].t, dequantize(q[k])]);
    }
    return out;
  }
}
