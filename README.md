# Simulateur de crue (France entière)

Application web qui simule la montée des eaux **autour d'un lieu choisi n'importe où en France métropolitaine** pour une pluie donnée (par exemple 100 mm en 24 h). Elle repère les cours d'eau qui peuvent atteindre le lieu, délimite leurs bassins versants, puis fait tomber la pluie sur le relief **LiDAR HD de l'IGN** : l'eau ruisselle selon l'occupation du sol et s'écoule en 2D dans les cours d'eau. Un préréglage couvre la haute vallée de l'Arc (Bouches-du-Rhône), point de départ du projet. La hauteur d'eau s'affiche heure par heure en bleu transparent sur la photo aérienne, avec les routes et les noms de lieux.

> ⚠️ Outil pédagogique et exploratoire. Il ne remplace ni le PPRI, ni Vigicrues, ni les consignes des autorités.

## Utilisation

1. **Lieu étudié** : chercher un lieu, une adresse ou un cours d'eau (champ en haut du panneau, géocodage IGN), ou toucher « Choisir le lieu étudié » puis la carte. L'application liste les cours d'eau à moins de 600 m (BD TOPO), avec pour chacun la distance, le **dénivelé entre le lieu et le lit** et la surface de son **bassin versant amont**, plus le ruissellement du versant qui domine le lieu. Elle coche ceux dont un débordement peut atteindre le lieu (dénivelé inférieur à une tolérance qui croît avec la taille du bassin) ; on peut cocher ou décocher. La simulation porte sur l'union des bassins cochés et la pluie ne tombe que dessus, avec un point de suivi du débit au droit du lieu pour chaque cours d'eau. Les très grands bassins (> 2 000 km², ex. Rhône, Loire) relèvent d'un modèle fluvial et ne sont pas proposés.
2. **Pluie** : cumul (mm) et durée (h), ou un clic sur une **pluie de référence du lieu** : l'application lit les pluies journalières des stations Météo-France à moins de 25 km depuis 1950 (données ouvertes data.gouv.fr, ~15 Mo par département, gardées en cache) et propose la pluie **décennale** et **centennale** en 24 h (loi de Gumbel sur les maxima annuels, ×1,13 pour passer du jour fixe aux 24 h glissantes), un **orage centennal de 3 h** (estimé à 75 % de la centennale de 24 h) et le **record observé**, ainsi que la liste des plus fortes pluies observées (cliquables). Répartition dans le temps : Chicago par défaut (modifiable dans les options avancées).
3. **Sol** : humidité avant l'épisode (sec, normal, saturé). Le type de sol est **déduit automatiquement** de la texture du sol (SoilGrids, ISRIC : taux d'argile et de sable au lieu et au centre des bassins) ; il peut être forcé dans les options avancées.
4. **Arrêt après le pic** (case cochée par défaut) : une fois la pluie finie depuis 30 min, le calcul s'arrête dès que le débit est retombé sous 70 % de son maximum à tous les points de suivi (deux mesures de suite) ; la simulation est enregistrée comme terminée.
5. **Maille de calcul** : chaque maille affiche son temps de calcul estimé (arrêt après le pic compris, d'après le temps de concentration du bassin), recalé sur la vitesse réellement mesurée sur l'appareil à chaque simulation ; le temps restant affiché pendant le calcul suit le même modèle. La plus fine calculable en une dizaine de minutes est choisie d'office ; une maille plus fine reste possible (avertissement si le calcul est long, arrêt possible à tout moment avec résultats partiels conservés). Seules les mailles qui dépassent la mémoire de l'appareil sont refusées.
5. **Lancer la simulation**. Les résultats s'ouvrent dans une **fenêtre flottante en haut à gauche de la carte**, avec **une seule barre de temps** (lecture, « Max ») qui pilote la carte, les débits et la coupe :
   - **légende verticale sur le bord droit de la carte** (dégradé et hauteurs associées) ; case **« Ruissellement »** : la lame d'eau mince (de 1 cm au premier palier) est dessinée en turquoise, distincte de l'inondation ;
   - débits aux points de suivi ;
   - en touchant la carte : hauteur d'eau, maximum, heure du pic et vitesse en ce point ; **bulle au survol** de la carte ;
   - **coupe en travers** : « Placer une coupe » puis clic sur la carte ; la coupe s'affiche dans un panneau flottant en bas de la carte ; orientation (auto = perpendiculaire au vallon) et largeur réglables ; poignée « main » au centre pour la déplacer sans la modifier, et curseur « Avancer / reculer » pour la faire glisser le long du cours d'eau. Terrain LiDAR HD à pleine résolution (jusqu'à 0,5 m), surface d'eau plate propagée sur le terrain fin, niveau maximal en pointillé ;
   - « Bilan du calcul » (surfaces inondées, pics de débit, bilan de masse).
6. **Simulations enregistrées** : chaque simulation terminée est enregistrée dans le navigateur et peut être rouverte sans recalcul, renommée, supprimée, ou exportée en fichier `.crue`.
7. **Options avancées** : répartition de la pluie, type de sol forcé, durée simulée après la pluie, gravure du réseau, calage, moteur de calcul, **couleurs de l'eau** (palettes bleus, viridis, alerte, cividis pour daltoniens, arc-en-ciel ; paliers standard 10 cm–4 m, resserrés 10 cm–2 m, très resserrés 5 cm–1 m, étendus 10 cm–8 m — appliqués aussi à la 3D), couches de la carte, **vue 3D** (relief LiDAR HD et nappe d'eau en volume, aussi via le bouton « 3D » de la carte).

Le calcul tourne **dans le navigateur**, sur la carte graphique (WebGPU) quand elle est disponible, sinon sur le processeur, plus lentement et à une résolution plus grossière. Aucun serveur de calcul n'est nécessaire. Les données IGN sont chargées à la demande, puis gardées en cache dans le navigateur.

## Données (IGN Géoplateforme, gratuites et sans clé)

| Donnée | Couche | Usage |
|---|---|---|
| Relief | `IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93` (MNT LiDAR HD 0,5 m), avec repli sur RGE ALTI 1 m (`RGEALTI-MNT_PYR-ZIP_FXX_LAMB93_WMS`) | altitude du terrain (float32 via WMS-R) |
| Occupation du sol | `IGNF_COSIA_2024-2026` (IA, 20 cm), complété par les millésimes 2021-2023 puis 2017-2020 | coefficient de ruissellement (CN) et rugosité (Manning) |
| Cours d'eau | `BDTOPO_V3:troncon_hydrographique` (WFS) | gravure des vallats dans le relief, points de suivi, affichage |
| Fond de carte | BD ORTHO (WMTS) + Plan IGN vectoriel (routes, noms) | vue « hybride » |
| Pluies observées | Météo-France, données climatologiques de base quotidiennes (data.gouv.fr) | pluies de référence du lieu |
| Texture du sol | SoilGrids (ISRIC, API REST) : argile et sable, 0-5 et 30-60 cm | groupe hydrologique du sol (< 20 % d'argile : perméable ; 20-40 % : moyen ; > 40 % : peu perméable) |

## Modèle

- **Pluie** : hyétogramme Chicago (par défaut : les hauteurs tombées sur 6 min, 30 min, 1 h… suivent la loi de Montana, b = 0,433 à Aix pour 100 ans), uniforme ou double triangle de Desbordes, intégré exactement à chaque pas de temps.
- **Pluie nette** : méthode SCS Curve Number par maille. Le CN dépend de la classe COSIA et du groupe de sol, et il est ajusté selon l'humidité initiale (AMC I/II/III). Un multiplicateur de rétention permet de caler le modèle.
- **Écoulement** : équations « inertie locale » (Bates et al. 2010), avec la pondération θ = 0,9 de de Almeida et al. (2012) et un frottement de Manning semi-implicite. Le pas de temps est adaptatif (CFL 0,6). Un limiteur proportionnel des sorties de chaque maille garantit la positivité et la **conservation exacte de la masse**. Les bords sont des sorties libres.
- **Préparation du relief** :
  - gravure du réseau BD TOPO en chemin 4-connexe (passage sous les ponts et remblais) ;
  - débrèchage contraint (Lindsay 2016) des micro-cuvettes créées par le rééchantillonnage ;
  - délimitation du bassin versant de l'Arc par *priority-flood* (Barnes 2014) ;
  - bassin versant d'un point : directions d'écoulement D8 sur le relief comblé, calage du point sur le tracé BD TOPO puis sur la maille la plus drainée, et emprise agrandie par paliers (4 km à 10 m → 60 km à 100 m) tant que le bassin touche le bord.
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
- La forme du hyétogramme Chicago utilise le coefficient de Montana b d'Aix-en-Provence ; ailleurs, c'est une approximation (le cumul reste celui saisi).
- Les crues des grands fleuves (débit venu de très loin à l'amont) ne sont pas simulées.

## Pistes suivantes

- Calage sur les stations Hydroportail de l'Arc et comparaison avec les emprises du PPRI / AZI.
- Pluie spatialisée (lames d'eau radar Météo-France), scénarios de crues historiques.
- Carte d'aléa (hauteur × vitesse), routes coupées, bâtiments touchés.
- Export GeoTIFF des hauteurs maximales.
