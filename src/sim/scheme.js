// Constantes et pas de temps du schéma « inertie locale » (Bates et al. 2010,
// de Almeida et al. 2012), partagées par les solveurs CPU et GPU.

export const G = 9.81;
export const H_MIN = 0.001; // m : en dessous, une face est considérée sèche
export const FROUDE_MAX = 1.5; // limiteur de stabilité sur fortes pentes
export const V_MAX = 8; // m/s
export const CFL = 0.6;
export const THETA = 0.9; // pondération de de Almeida (1 = schéma de Bates d'origine)
export const DT_MAX = 10; // s
export const BOUNDARY_SLOPE = 0.002; // pente de sortie libre aux bords du domaine

/** Pas de temps stable pour une profondeur max donnée. */
export function stableDt(dx, hmax) {
  return Math.min(DT_MAX, (CFL * dx) / Math.sqrt(G * Math.max(hmax, 0.01)));
}
