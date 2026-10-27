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

## Étape 1 — Fondations et bâtiments (≈ 2 séances) ✅

But : rendre le code plus sûr à faire évoluer, et corriger la plus grosse erreur en ville.

- [x] Découper `src/main.js` (≈ 3 500 lignes) en modules : lieu étudié, pluies, sol, calcul, résultats, coupe, comparaison, rivière aval
- [x] Tests navigateur de bout en bout dans le dépôt, sur 4 lieux de référence (Touloubre, Weiss, Roya, Torse + Arc) : surfaces de bassin, bilan de masse, arrêt après le pic, coupe
- [x] Bâtiments IGN automatiques (BD TOPO, avec leur hauteur) traités comme les bâtiments dessinés, option pour les désactiver
- [x] Ne pas boucher les rues entre bâtiments aux mailles grossières (bâti partiel par maille)
- [x] Vérifier : en zone urbaine, l'eau contourne les maisons ; une rue entre deux bâtiments reste ouverte — vérifié sur la Torse (Val Saint-André, maille 10 m) : 1 maille bâtie mouillée sur 3 534, 843 mailles de rue en eau

## Étape 2 — Vitesse (≈ 3 séances)

But : mailles de 1–2 m autour du lieu en quelques minutes.

- [x] Calcul emboîté : tout le bassin à maille grossière (25–50 m), débits enregistrés à l'entrée d'un carré de 1–2 km autour du lieu, puis ce carré recalculé finement (1–5 m)
- [ ] Pas de temps par zone : grands pas dans les zones calmes, petits dans les zones profondes (supprime aussi les petits écarts vus dans les ravins quand une rivière profonde est simulée)
  - Reporté : gain surtout quand une rivière profonde est dans la zone ; le calcul en deux temps réduit déjà le besoin.
- [ ] Calcul processeur sur plusieurs cœurs (appareils sans carte graphique)
  - Reporté : demande une isolation de la page que GitHub Pages ne permet pas sans contournement (risque de casser les fonds de carte IGN) ; utile seulement sans carte graphique (WebGPU est désormais courant).
- [x] Chargement : bibliothèques (MapLibre, proj4) dans des fichiers à part, gardés en cache d'une version à l'autre (163 Ko à retélécharger au lieu de 1,2 Mo) ; le chargement à la demande de la 3D, de la comparaison et de la coupe ne gagnerait que ≈ 4 % (MapLibre = 77 % du code, nécessaire dès l'ouverture)
- [ ] Vérifier : même résultat au point étudié (±5 %) qu'un calcul fin sur tout le bassin, au moins 5 fois plus vite
  - Mesuré sur la Torse (80 mm en 1 h), référence 10 m d'un seul tenant : bassin 25 m + zone 2 km à 10 m → −6 %, 7 fois plus vite ; à maille égale → −2 % (couplage fidèle). L'écart restant vient de la maille du bassin.
- [x] Lit des cours d'eau : frottement d'un lit naturel (et non de la ripisylve) — résultats beaucoup moins dépendants de la maille

## Étape 3 — Rejouer une crue réelle et caler le modèle (≈ 3 séances)

But : confronter le simulateur aux mesures et régler ses paramètres sur le terrain.

- [x] Vérifier l'accès depuis la page aux pluies horaires historiques (Météo-France, data.gouv) et aux débits historiques (Hub'Eau ; sinon import d'un fichier HydroPortail)
- [x] Mode « Épisode historique » : une date, les pluies horaires des stations proches, le débit mesuré à la station de la rivière la plus proche
- [x] Indicateurs d'écart simulé / mesuré : pic, heure du pic, volume, ressemblance des courbes
- [x] Calage assisté : simulations successives sur la capacité d'absorption du sol (rétention et infiltration ; le frottement n'est pas calé) ; réglage enregistré par secteur (lieux à moins de 30 km)
- [ ] Vérifier : sur 2–3 crues connues (Arc, un cours d'eau cévenol, Weiss), pic simulé à ±30 % du pic mesuré après calage
  - Calé sur chaque crue : Arc 23/11/2019 pic +15 % ; Ganière 09/09/2002 +2 % ; Weiss 14/11/2023 pic +2 % mais volume −98 % (écoulement par le sol et les nappes non représenté).
  - Transposition d'une crue à l'autre (même station, sans recaler) : Arc 14/12/2008 +66 % (volume +25 %) avec le réglage de 2019 : objectif non atteint.
  - Sans calage : Arc 2019 +16 %, Arc 2008 +66 %, Ganière −53 %.
  - Pistes : humidité du sol mesurée (étape 4), pluie variable dans l'espace (étape 4), débit de base.

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
