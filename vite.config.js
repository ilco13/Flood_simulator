import { defineConfig } from 'vite';

// base relative : l'application fonctionne aussi bien à la racine d'un domaine que
// dans un sous-dossier (GitHub Pages : /Flood_simulator/).
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
