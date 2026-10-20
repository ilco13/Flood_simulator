// Paramètres de la zone d'étude et des services de données (IGN Géoplateforme).
// Toutes les coordonnées de grille sont en Lambert 93 (EPSG:2154), en mètres.

export const DOMAIN = {
  // Haute vallée de l'Arc : de Pourrières / Ollières (est) à Aix – Pont de l'Arc (ouest),
  // de la Sainte-Victoire (nord) au Regagnas / Mont Aurélien (sud).
  xmin: 892000,
  ymin: 6252000,
  xmax: 932000,
  ymax: 6284000,
};

// Point situé sur l'Arc à l'aval du domaine : sert à délimiter le bassin versant.
export const OUTLET = { x: 897300, y: 6271111 };

export const WMS_R = 'https://data.geopf.fr/wms-r/wms';
export const WFS = 'https://data.geopf.fr/wfs/ows';
export const WMTS = 'https://data.geopf.fr/wmts';

export const LAYERS = {
  dem: 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93', // MNT LiDAR HD (0,5 m)
  demFallback: 'RGEALTI-MNT_PYR-ZIP_FXX_LAMB93_WMS', // RGE ALTI 1 m
  landcover: 'IGNF_COSIA_2024-2026', // Occupation du sol IA IGN (20 cm)
  // Millésime précédent : complète les zones pas encore couvertes (ex. partie varoise).
  landcoverFallback: 'IGNF_COSIA_2021-2023',
  rivers: 'BDTOPO_V3:troncon_hydrographique',
};

export const PLAN_IGN_STYLE =
  'https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/standard.json';

export const ORTHO_TILES =
  `${WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS` +
  '&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg';

export const SHADOW_TILES =
  `${WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW` +
  '&STYLE=estompage_grayscale&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png';

// Taille d'un bloc demandé au WMS (le service accepte jusqu'à 5010 px). Des blocs
// moyens donnent un avancement plus régulier et plus de requêtes en parallèle.
export const WMS_BLOCK = 1000;

// Points de suivi des débits (sections transversales perpendiculaires au cours d'eau).
export const GAUGES = [
  { id: 'trets', name: "L'Arc à Trets", x: 916628, y: 6266426, river: "l'Arc", halfWidth: 350 },
  { id: 'longarel', name: 'Vallat de Longarel (aval)', x: 915420, y: 6265941, river: 'Vallat de Longarel', halfWidth: 120 },
  { id: 'verdalai', name: 'Vallat du Verdalaï (aval)', x: 911781, y: 6266613, river: 'Vallat du Verdalaï', halfWidth: 120 },
  { id: 'rousset', name: "L'Arc à Rousset", x: 911366, y: 6267688, river: "l'Arc", halfWidth: 400 },
  { id: 'chateauneuf', name: "L'Arc à Châteauneuf-le-Rouge", x: 908018, y: 6267991, river: "l'Arc", halfWidth: 400 },
  { id: 'bayeux', name: 'Le Bayeux (aval)', x: 904011, y: 6270272, river: 'le Bayeux', halfWidth: 150 },
  { id: 'meyreuil', name: "L'Arc à Meyreuil", x: 902980, y: 6270179, river: "l'Arc", halfWidth: 400 },
  { id: 'cause', name: 'La Cause (aval)', x: 901700, y: 6271192, river: 'la Cause', halfWidth: 150 },
  { id: 'aix', name: "L'Arc à Aix (Pont de l'Arc)", x: 897300, y: 6271111, river: "l'Arc", halfWidth: 450 },
];

// Résolutions proposées (m). La mémoire et le temps de calcul croissent en 1/dx³.
export const RESOLUTIONS = [50, 25, 15, 10, 5];
