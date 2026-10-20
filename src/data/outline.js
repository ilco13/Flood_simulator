import { maskOutline } from '../hydrology/terrain.js';
import { toWgs } from '../geo.js';

/** Contour d'un masque de grille en anneaux WGS84, sans les points alignés. */
export function outlineWgs(mask, grid) {
  return maskOutline(mask, grid.nx, grid.ny).map((ring) => {
    const out = [ring[0]];
    for (let i = 1; i < ring.length - 1; i++) {
      const [ax, ay] = out[out.length - 1];
      const [bx, by] = ring[i];
      const [cx, cy] = ring[i + 1];
      if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) !== 0) out.push(ring[i]);
    }
    out.push(ring[ring.length - 1]);
    return out.map(([gx, gy]) => toWgs(grid.xmin + gx * grid.dx, grid.ymax - gy * grid.dx));
  });
}
