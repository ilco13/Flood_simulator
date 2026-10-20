// Nappe d'eau en volume pour la vue 3D : un maillage posé à la cote « sol + hauteur d'eau »,
// dessiné par une couche WebGL personnalisée de MapLibre.
//
// Les positions sont stockées relativement à une origine (précision float32), et la matrice
// finale est calculée en double précision côté JavaScript.

import maplibregl from 'maplibre-gl';
import { toWgs } from '../geo.js';
import { DEPTH_CAP } from '../sim/snapshots.js';

const MAX_SIDE = 640; // sommets max par côté du maillage

const VS = `
attribute vec2 a_pos;
attribute float a_z;
attribute float a_q;
uniform mat4 u_matrix;
uniform float u_cap;
varying float v_d;
void main() {
  float r = a_q / 255.0;
  float d = r * r * u_cap;
  v_d = d;
  // Sommet sec : légèrement sous le sol pour que le bord de la nappe s'efface proprement.
  float z = a_z + (d > 0.0 ? d : -0.3);
  gl_Position = u_matrix * vec4(a_pos, z, 1.0);
}`;

const FS = `
precision mediump float;
varying float v_d;
uniform float u_thr;
uniform float u_alpha;
void main() {
  if (v_d < u_thr) discard;
  float t = clamp(log(v_d / max(u_thr, 0.01)) / log(4.0 / max(u_thr, 0.01)), 0.0, 1.0);
  vec3 light = vec3(0.45, 0.75, 1.0);
  vec3 deep = vec3(0.02, 0.16, 0.45);
  vec3 c = mix(light, deep, t);
  float a = u_alpha * mix(0.55, 0.9, t);
  gl_FragColor = vec4(c * a, a);
}`;

function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

export class Water3DLayer {
  constructor() {
    this.id = 'water3d';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.threshold = 0.1;
    this.alpha = 0.85;
    this.ready = false;
    this.mesh = null;
    this.pendingDepth = null;
  }

  /** Construit le maillage pour la grille de simulation et le relief (m) correspondant. */
  setGrid(grid, ground) {
    const s = Math.max(1, Math.ceil(Math.max(grid.nx, grid.ny) / MAX_SIDE));
    const mx = Math.ceil(grid.nx / s);
    const my = Math.ceil(grid.ny / s);
    const n = mx * my;
    const cx = grid.xmin + (grid.nx * grid.dx) / 2;
    const cy = grid.ymax - (grid.ny * grid.dx) / 2;
    const origin = maplibregl.MercatorCoordinate.fromLngLat(toWgs(cx, cy), 0);
    const pos = new Float32Array(n * 2);
    const z = new Float32Array(n);
    for (let b = 0; b < my; b++) {
      for (let a = 0; a < mx; a++) {
        const i = Math.min(grid.nx - 1, a * s);
        const j = Math.min(grid.ny - 1, b * s);
        const m = maplibregl.MercatorCoordinate.fromLngLat(
          toWgs(grid.xmin + (i + 0.5) * grid.dx, grid.ymax - (j + 0.5) * grid.dx),
          0,
        );
        const v = b * mx + a;
        pos[2 * v] = m.x - origin.x;
        pos[2 * v + 1] = m.y - origin.y;
        const g = ground[j * grid.nx + i];
        z[v] = g > -1000 ? g : 0;
      }
    }
    const idx = new Uint32Array((mx - 1) * (my - 1) * 6);
    let o = 0;
    for (let b = 0; b < my - 1; b++)
      for (let a = 0; a < mx - 1; a++) {
        const v = b * mx + a;
        idx[o++] = v;
        idx[o++] = v + 1;
        idx[o++] = v + mx;
        idx[o++] = v + 1;
        idx[o++] = v + mx + 1;
        idx[o++] = v + mx;
      }
    this.mesh = { grid, s, mx, my, n, origin, pos, z, idx, q: new Uint8Array(n), dirty: true };
    this.map?.triggerRepaint();
  }

  /** Hauteurs d'eau quantifiées (grille complète) : on garde le maximum de chaque bloc. */
  setDepth(q) {
    const m = this.mesh;
    if (!m) return;
    const { grid, s, mx, my } = m;
    for (let b = 0; b < my; b++)
      for (let a = 0; a < mx; a++) {
        let v = 0;
        const j1 = Math.min(grid.ny, (b + 1) * s);
        const i1 = Math.min(grid.nx, (a + 1) * s);
        for (let j = b * s; j < j1; j++)
          for (let i = a * s; i < i1; i++) {
            const w = q[j * grid.nx + i];
            if (w > v) v = w;
          }
        m.q[b * mx + a] = v;
      }
    m.qDirty = true;
    this.map?.triggerRepaint();
  }

  setThreshold(t) {
    this.threshold = t;
    this.map?.triggerRepaint();
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    const sh = (type, src) => {
      const x = gl.createShader(type);
      gl.shaderSource(x, src);
      gl.compileShader(x);
      if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x));
      return x;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    this.prog = p;
    this.loc = {
      pos: gl.getAttribLocation(p, 'a_pos'),
      z: gl.getAttribLocation(p, 'a_z'),
      q: gl.getAttribLocation(p, 'a_q'),
      matrix: gl.getUniformLocation(p, 'u_matrix'),
      cap: gl.getUniformLocation(p, 'u_cap'),
      thr: gl.getUniformLocation(p, 'u_thr'),
      alpha: gl.getUniformLocation(p, 'u_alpha'),
    };
    this.buf = { pos: gl.createBuffer(), z: gl.createBuffer(), q: gl.createBuffer(), idx: gl.createBuffer() };
    this.uint32 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
      ? true
      : !!gl.getExtension('OES_element_index_uint');
    this.ready = true;
  }

  onRemove() {
    const gl = this.gl;
    if (!gl) return;
    for (const b of Object.values(this.buf)) gl.deleteBuffer(b);
    if (this.vao) gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
    this.ready = false;
  }

  render(gl, args) {
    const m = this.mesh;
    const terrain = this.map.getTerrain?.();
    if (!this.ready || !m || !terrain || !this.uint32) return;
    // Ne pas modifier le VAO éventuellement lié par MapLibre (WebGL2).
    const gl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    if (gl2) {
      if (!this.vao) this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
    }
    if (m.dirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.pos);
      gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.z);
      gl.bufferData(gl.ARRAY_BUFFER, m.z, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
      m.dirty = false;
      m.qDirty = true;
    }
    if (m.qDirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf.q);
      gl.bufferData(gl.ARRAY_BUFFER, m.q, gl.DYNAMIC_DRAW);
      m.qDirty = false;
    }
    // Matrice : MVP × translation(origine) × échelle verticale (mètres -> unités Mercator, exagération)
    const ex = terrain.exaggeration ?? 1;
    const sz = m.origin.meterInMercatorCoordinateUnits() * ex;
    const model = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, sz, 0, m.origin.x, m.origin.y, 0, 1]);
    const mvp = args.defaultProjectionData?.mainMatrix || args.modelViewProjectionMatrix;
    const mat = new Float32Array(mul(mvp, model));

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.matrix, false, mat);
    gl.uniform1f(this.loc.cap, DEPTH_CAP);
    gl.uniform1f(this.loc.thr, this.threshold);
    gl.uniform1f(this.loc.alpha, this.alpha);
    const attr = (loc, buf, size, type) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, false, 0, 0);
    };
    attr(this.loc.pos, this.buf.pos, 2, gl.FLOAT);
    attr(this.loc.z, this.buf.z, 1, gl.FLOAT);
    attr(this.loc.q, this.buf.q, 1, gl.UNSIGNED_BYTE);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.buf.idx);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.drawElements(gl.TRIANGLES, m.idx.length, gl.UNSIGNED_INT, 0);
    if (gl2) gl.bindVertexArray(null);
    else for (const l of [this.loc.pos, this.loc.z, this.loc.q]) gl.disableVertexAttribArray(l);
    gl.depthMask(true);
  }
}
