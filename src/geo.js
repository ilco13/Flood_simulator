import proj4 from 'proj4';

proj4.defs(
  'EPSG:2154',
  '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 ' +
    '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
);

const l93 = proj4('EPSG:4326', 'EPSG:2154');

/** [lon, lat] -> [x, y] Lambert 93 */
export function toL93(lon, lat) {
  return l93.forward([lon, lat]);
}

/** [x, y] Lambert 93 -> [lon, lat] */
export function toWgs(x, y) {
  return l93.inverse([x, y]);
}

/**
 * Description d'une grille régulière Lambert 93.
 * Ligne 0 = bord nord (comme une image), colonne 0 = bord ouest.
 */
export function makeGrid(bbox, dx) {
  const nx = Math.round((bbox.xmax - bbox.xmin) / dx);
  const ny = Math.round((bbox.ymax - bbox.ymin) / dx);
  return {
    xmin: bbox.xmin,
    ymax: bbox.ymin + ny * dx,
    ymin: bbox.ymin,
    xmax: bbox.xmin + nx * dx,
    dx,
    nx,
    ny,
  };
}

export function cellOf(grid, x, y) {
  const i = Math.floor((x - grid.xmin) / grid.dx);
  const j = Math.floor((grid.ymax - y) / grid.dx);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) return null;
  return { i, j, k: j * grid.nx + i };
}

export function cellCenter(grid, i, j) {
  return [grid.xmin + (i + 0.5) * grid.dx, grid.ymax - (j + 0.5) * grid.dx];
}

/** Coins de la grille en WGS84, dans l'ordre attendu par MapLibre : NO, NE, SE, SO. */
export function gridCornersWgs(grid) {
  return [
    toWgs(grid.xmin, grid.ymax),
    toWgs(grid.xmax, grid.ymax),
    toWgs(grid.xmax, grid.ymin),
    toWgs(grid.xmin, grid.ymin),
  ];
}
