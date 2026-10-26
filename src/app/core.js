import { SCALES, buildFlowLut } from '../render/water.js';

export const $ = (id) => document.getElementById(id);
// Limites mémoire (au-delà, le navigateur risque de manquer de mémoire) ; le temps de calcul,
// lui, n'est jamais bloquant : on prévient seulement.
export const GPU_CELL_CAP = 30e6;
export const CPU_CELL_CAP = 8e6;
export const ZOOM_RESOLUTIONS = [10, 5, 2, 1];
export const STUDY_RESOLUTIONS = [50, 25, 15, 10, 5, 2, 1];
export const COLORS_KEY = 'flood-sim-colors';
/** Hauteur (m) à partir de laquelle l'eau est dessinée comme inondation (1er palier). */
export const floodThreshold = () => SCALES[state.scale].breaks[0];
export const GAUGE_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#000075'];

export const state = {
  map: null,
  overlayIds: [],
  gpu: null,
  data: null, // résultat du worker de préparation
  run: null, // simulation en cours ou terminée
  amc: 2,
  viewMode: 't',
  threshold: 0.1,
  lut: null,
  runoff: true,
  palette: 'bleus',
  layerMode: 'depth', // ou 'flow' : couleur selon le débit
  arrows: true,
  flowLut: buildFlowLut(),
  scale: 'standard',
  hiddenGauges: new Set(),
  probe: null,
};

/* ---------- Mise en forme ---------- */

export const fmtH = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.round((s - h * 3600) / 60);
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
};
export const fmtNum = (v, d = 0) => v.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
export const fmtArea = (km2) =>
  km2 < 0.01 ? 'moins d\'1 ha' : km2 < 0.5 ? `${fmtNum(km2 * 100)} ha` : `${fmtNum(km2, km2 < 10 ? 1 : 0)} km²`;
export const fmtDepth = (h) => (h < 1 ? `${fmtNum(h * 100)} cm` : `${fmtNum(h, 2)} m`);
