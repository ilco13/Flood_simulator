import { defineConfig } from 'vite';

// base relative : l'application fonctionne aussi bien à la racine d'un domaine que
// dans un sous-dossier (GitHub Pages : /Flood_simulator/).
// Bibliothèques (MapLibre ≈ 940 Ko, proj4) dans des fichiers à part : leur nom ne change pas
// d'une version de l'application à l'autre, le navigateur les garde en cache.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre';
          if (id.includes('node_modules/proj4') || id.includes('node_modules/mgrs') || id.includes('node_modules/wkt-parser')) return 'proj4';
        },
      },
    },
  },
});
