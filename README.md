# Crue de l'Arc : simulateur d'inondation

Application web qui simule la montée des eaux dans la **haute vallée de l'Arc** (Bouches-du-Rhône) pour une pluie donnée (par exemple 100 mm en 24 h). La pluie tombe sur le relief **LiDAR HD de l'IGN**, ruisselle selon l'occupation du sol, puis s'écoule en 2D dans l'Arc et ses vallats (Verdalaï, Longarel, Bayeux, Cause…). La hauteur d'eau s'affiche heure par heure en bleu transparent sur la photo aérienne, avec les routes et les noms de lieux.

> ⚠️ Outil pédagogique et exploratoire. Il ne remplace ni le PPRI, ni Vigicrues, ni les consignes des autorités.

## Utilisation

1. Saisir le **cumul de pluie** (mm) et la **durée** (h), puis choisir la répartition dans le temps.
2. Choisir l'**humidité du sol** avant l'épisode (sec, normal ou saturé) et le type de sol.
3. Choisir la **zone** :
   - *Haute vallée de l'Arc* : tout le bassin, de Pourrières à Aix (Pont de l'Arc), à 50, 25, 15, 10 ou 5 m ;
   - *Zone affichée* : la portion visible de la carte, en détail fin (jusqu'à 1 m). L'eau venant de l'amont hors écran n'y est pas comptée.
4. **Lancer la simulation**. L'eau apparaît au fil du calcul.
5. Explorer les résultats :
   - curseur temporel et lecture animée ;
   - vue « maximum atteint » ;
   - débits aux points de suivi (Arc à Trets, Rousset, Châteauneuf, Meyreuil, Aix ; Verdalaï, Longarel, Bayeux, Cause) ;
   - en touchant la carte : hauteur d'eau, maximum, heure du pic et vitesse en ce point ;
   - **bulle au survol de la carte** : hauteur d'eau sous la souris à l'heure affichée, maximum atteint et son heure ;
   - **coupe en travers** : « Placer une coupe » puis clic sur la carte ; la coupe s'affiche dans un panneau flottant en bas de la carte, avec son propre curseur de temps et bouton lecture ; orientation (auto = perpendiculaire au vallon) et largeur réglables. Le terrain est tiré du LiDAR HD à pleine résolution (jusqu'à 0,5 m), l'eau suit le curseur de temps, le niveau maximal est en pointillé, et le survol donne altitude et hauteur d'eau ;
   - **simulations enregistrées** : chaque simulation terminée est enregistrée automatiquement dans le navigateur (IndexedDB) et peut être rouverte sans recalcul, renommée, supprimée, ou exportée en fichier `.crue` pour l'ouvrir sur un autre ordinateur (bouton « Importer un fichier .crue ») ;
   - **vue 3D** (bouton « 3D » de la carte ou case « Relief 3D ») : relief LiDAR HD en relief, photo aérienne drapée, et nappe d'eau en volume posée à la cote « sol + hauteur d'eau », animée avec le curseur de temps. Exagération du relief réglable (×1 à ×4).

Le calcul tourne **dans le navigateur**, sur la carte graphique (WebGPU) quand elle est disponible, sinon sur le processeur, plus lentement et à une résolution plus grossière. Aucun serveur de calcul n'est nécessaire. Les données IGN sont chargées à la demande, puis gardées en cache dans le navigateur.

## Données (IGN Géoplateforme, gratuites et sans clé)

| Donnée | Couche | Usage |
|---|---|---|
| Relief | `IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93` (MNT LiDAR HD 0,5 m), avec repli sur RGE ALTI 1 m (`RGEALTI-MNT_PYR-ZIP_FXX_LAMB93_WMS`) | altitude du terrain (float32 via WMS-R) |
| Occupation du sol | `IGNF_COSIA_2024-2026` (IA, 20 cm) | coefficient de ruissellement (CN) et rugosité (Manning) |
| Cours d'eau | `BDTOPO_V3:troncon_hydrographique` (WFS) | gravure des vallats dans le relief, points de suivi, affichage |
| Fond de carte | BD ORTHO (WMTS) + Plan IGN vectoriel (routes, noms) | vue « hybride » |

## Modèle

- **Pluie** : hyétogramme Chicago (par défaut : les hauteurs tombées sur 6 min, 30 min, 1 h… suivent la loi de Montana, b = 0,433 à Aix pour 100 ans), uniforme ou double triangle de Desbordes, intégré exactement à chaque pas de temps.
- **Pluie nette** : méthode SCS Curve Number par maille. Le CN dépend de la classe COSIA et du groupe de sol, et il est ajusté selon l'humidité initiale (AMC I/II/III). Un multiplicateur de rétention permet de caler le modèle.
- **Écoulement** : équations « inertie locale » (Bates et al. 2010), avec la pondération θ = 0,9 de de Almeida et al. (2012) et un frottement de Manning semi-implicite. Le pas de temps est adaptatif (CFL 0,6). Un limiteur proportionnel des sorties de chaque maille garantit la positivité et la **conservation exacte de la masse**. Les bords sont des sorties libres.
- **Préparation du relief** :
  - gravure du réseau BD TOPO en chemin 4-connexe (passage sous les ponts et remblais) ;
  - débrèchage contraint (Lindsay 2016) des micro-cuvettes créées par le rééchantillonnage ;
  - délimitation du bassin versant de l'Arc par *priority-flood* (Barnes 2014).
- **Points de suivi** : débit à travers une section perpendiculaire au cours d'eau.

Les solveurs CPU (JavaScript, `src/sim/cpuSolver.js`) et GPU (WGSL, `src/sim/gpuSolver.js`) implémentent le même schéma. Un test vérifie qu'ils concordent.

## Développement

```bash
npm install
npm run dev        # serveur de développement
npm test           # tests numériques (masse, lac au repos, Manning, Stoker, bassin)
npm run build      # version de production dans dist/
```

Autres outils de test :

- `node test/local-run.mjs <dossier> <res> <mm> <h> <forme> <amc> <après h> <sortie>` : simulation fine d'un petit secteur autour d'un point (débit dans le vallat, hauteur d'eau au point) ;
- `node test/real-run.mjs <dossier> <res>` : simulation complète hors navigateur sur des données IGN téléchargées (MNT `.bil`, COSIA `.rgba`, BD TOPO `.json`) ;
- `node test/gpu-vs-cpu.cjs` : compare les solveurs GPU et CPU dans Chromium (Playwright, avec le serveur de développement lancé) ;
- `node test/e2e.cjs <url> <dossier>` : parcours complet dans le navigateur, avec captures d'écran ;
- `node test/e2e-3d.cjs <url> <dossier> …` : simulation puis captures de la vue 3D.

## Déploiement

Le workflow `.github/workflows/deploy.yml` publie `dist/` sur **GitHub Pages** à chaque push sur `main`. Pour l'activer : *Settings → Pages → Source : GitHub Actions*.

## Limites connues

- La pluie est uniforme dans l'espace (pas de cellule orageuse localisée).
- L'infiltration ne se poursuit pas sous l'eau stagnante. L'évaporation et les apports souterrains (karst) sont ignorés.
- Les ouvrages ne sont représentés que par le relief et la gravure BD TOPO : buses sous-dimensionnées, bassins de rétention, clapets, digues, etc.
- Le schéma « inertie locale » néglige l'accélération convective. Il est adapté aux plaines d'inondation, moins aux écoulements torrentiels très rapides.
- Le modèle n'est pas encore calé sur des crues observées (Hydroportail, PPRI de l'Arc).

## Pistes suivantes

- Calage sur les stations Hydroportail de l'Arc et comparaison avec les emprises du PPRI / AZI.
- Pluie spatialisée (lames d'eau radar Météo-France), scénarios de crues historiques.
- Carte d'aléa (hauteur × vitesse), routes coupées, bâtiments touchés.
- Export GeoTIFF des hauteurs maximales.
