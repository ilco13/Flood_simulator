# Feuille de route

Plan d'amélioration du simulateur, en 5 étapes. Chaque étape apporte quelque chose d'utilisable
seule ; l'ordre est choisi pour que chacune profite des précédentes (la vitesse avant le calage,
qui demande beaucoup de simulations). Taille indicative en séances de travail.

Légende : `[x]` fait · `[ ]` à faire.

## Déjà en place

- [x] Lieu étudié n'importe où en France : cours d'eau proches, bassins versants, dénivelé lieu / lit
- [x] Simulation 2D sur carte graphique (WebGPU) ou processeur, relief LiDAR HD
- [x] Pluies de référence du lieu (stations Météo-France, Gumbel, abattement spatial)
- [x] Type de sol automatique (SoilGrids) ; humidité sec / normal / saturé
- [x] Plafond d'infiltration selon l'intensité de la pluie (Horton)
- [x] Bâtiments et murs dessinés à la main, pris en compte dans le calcul et la coupe
- [x] Résultats : hauteurs, débits et flèches, ruissellement, coupe en travers, enregistrement
- [x] Comparaison de scénarios : tableau, analyse rédigée, carte des écarts
- [x] Rivière aval en crue (remous à la confluence)
- [x] Campagne de tests sur 14 cours d'eau en France
- [x] Tests unitaires lancés avant chaque mise en ligne (GitHub Actions)

## Étape 1 — Fondations et bâtiments (≈ 2 séances)

But : rendre le code plus sûr à faire évoluer, et corriger la plus grosse erreur en ville.

- [ ] Découper `src/main.js` (≈ 3 500 lignes) en modules : lieu étudié, pluies, sol, calcul, résultats, coupe, comparaison, rivière aval
- [ ] Tests navigateur de bout en bout dans le dépôt, sur 4 lieux de référence (Touloubre, Weiss, Roya, Torse + Arc) : surfaces de bassin, bilan de masse, arrêt après le pic, coupe
- [ ] Bâtiments IGN automatiques (BD TOPO, avec leur hauteur) traités comme les bâtiments dessinés, option pour les désactiver
- [ ] Ne pas boucher les rues entre bâtiments aux mailles grossières (bâti partiel par maille)
- [ ] Vérifier : en zone urbaine, l'eau contourne les maisons ; une rue entre deux bâtiments reste ouverte à 5 m

## Étape 2 — Vitesse (≈ 3 séances)

But : mailles de 1–2 m autour du lieu en quelques minutes.

- [ ] Calcul emboîté : tout le bassin à maille grossière (25–50 m), débits enregistrés à l'entrée d'un carré de 1–2 km autour du lieu, puis ce carré recalculé finement (1–5 m)
- [ ] Pas de temps par zone : grands pas dans les zones calmes, petits dans les zones profondes (supprime aussi les petits écarts vus dans les ravins quand une rivière profonde est simulée)
- [ ] Calcul processeur sur plusieurs cœurs (appareils sans carte graphique)
- [ ] Chargement à la demande de la 3D, de la comparaison et de la coupe (démarrage plus rapide sur téléphone)
- [ ] Vérifier : même résultat au point étudié (±5 %) qu'un calcul fin sur tout le bassin, au moins 5 fois plus vite

## Étape 3 — Rejouer une crue réelle et caler le modèle (≈ 3 séances)

But : confronter le simulateur aux mesures et régler ses paramètres sur le terrain.

- [ ] Vérifier l'accès depuis la page aux pluies horaires historiques (Météo-France, data.gouv) et aux débits historiques (Hub'Eau ; sinon import d'un fichier HydroPortail)
- [ ] Mode « Épisode historique » : une date, les pluies horaires des stations proches, le débit mesuré à la station de la rivière la plus proche
- [ ] Indicateurs d'écart simulé / mesuré : pic, heure du pic, volume, ressemblance des courbes
- [ ] Calage assisté : quelques simulations pour ajuster infiltration, frottement et humidité du sol ; réglage enregistré par secteur
- [ ] Vérifier : sur 2–3 crues connues (Arc, un cours d'eau cévenol, Weiss), pic simulé à ±30 % du pic mesuré après calage

## Étape 4 — Données d'entrée plus réalistes (≈ 2–3 séances)

But : moins de réglages « au jugé ».

- [ ] Humidité du sol du jour (indice quotidien Météo-France) : sec / normal / saturé proposé automatiquement pour une date — accès à vérifier
- [ ] Pluie variable dans l'espace : pluie de chaque station répartie sur le bassin (épisodes historiques) ; radar plus tard si les données sont ouvertes
- [ ] Ponts et buses : ouvrages repérés sur les cours d'eau étudiés, dimensions estimées ou saisies (largeur, hauteur sous tablier), débordement par-dessus la route au-delà de leur capacité (pont de l'avenue de Villelongue)
- [ ] Rivière aval : reprendre les débits de crue décennale / centennale des stations quand ils existent, à la place de la formule

## Étape 5 — Partage et confort (≈ 2 séances)

But : rendre les résultats faciles à transmettre.

- [ ] Rapport PDF d'une simulation ou d'une comparaison : carte, coupe, courbes, tableau, hypothèses et limites
- [ ] Lien de partage d'un scénario (lieu et réglages), relançable par quelqu'un d'autre
- [ ] Mode simple au premier lancement : lieu → pluie de référence → lancer
- [ ] Gestion du stockage : place utilisée, nettoyage des anciennes simulations

## Points de vigilance

- Accès aux données : chaque source (pluies horaires, humidité du sol, radar, débits historiques) est vérifiée au début de l'étape concernée ; à défaut, import d'un fichier.
- Les chiffres restent ceux d'un modèle simplifié tant que l'étape 3 n'est pas faite : à lire pour comparer des scénarios, pas comme une prévision.
