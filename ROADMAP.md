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

## Étape 2 — Vitesse (≈ 3 séances) ✅ (deux points reportés)

But : mailles de 1–2 m autour du lieu en quelques minutes.

- [x] Calcul emboîté : tout le bassin à maille grossière (25–50 m), débits enregistrés à l'entrée d'un carré de 1–2 km autour du lieu, puis ce carré recalculé finement (1–5 m)
- [ ] Pas de temps par zone : grands pas dans les zones calmes, petits dans les zones profondes (supprime aussi les petits écarts vus dans les ravins quand une rivière profonde est simulée)
  - Reporté : gain surtout quand une rivière profonde est dans la zone ; le calcul en deux temps réduit déjà le besoin.
  - Essayé ensuite (moteur processeur, branche `experiment/pas-par-zone`) : les mailles profondes ne sont que 2 à 4 % du bassin, mais le schéma n'accepte qu'un rapport de pas de 2 sans fausser les pics (rapport 2 : pic −0,05 % ; rapport 3 : +1 % ; rapport 4 : +7 %) ; à rapport 2, le tri des mailles à chaque pas mange presque tout le gain (≈ 1,1 fois plus rapide). Non retenu.
- [ ] Calcul processeur sur plusieurs cœurs (appareils sans carte graphique)
  - Reporté : demande une isolation de la page que GitHub Pages ne permet pas sans contournement (risque de casser les fonds de carte IGN) ; utile seulement sans carte graphique (WebGPU est désormais courant).
- [x] Chargement : bibliothèques (MapLibre, proj4) dans des fichiers à part, gardés en cache d'une version à l'autre (163 Ko à retélécharger au lieu de 1,2 Mo) ; le chargement à la demande de la 3D, de la comparaison et de la coupe ne gagnerait que ≈ 4 % (MapLibre = 77 % du code, nécessaire dès l'ouverture)
- [x] Vérifier : même résultat au point étudié (±5 %) qu'un calcul fin sur tout le bassin, au moins 5 fois plus vite — atteint sur la Torse ; pas sur un petit ravin (voir ci-dessous)
  - Mesuré sur la Torse (80 mm en 1 h), référence 10 m d'un seul tenant : bassin 25 m + zone 2 km à 10 m → −6 %, 7 fois plus vite ; à maille égale → −2 % (couplage fidèle). L'écart restant vient de la maille du bassin.
  - Remesuré après les étapes 3–5 (80 mm en 1 h) : Torse (21 km²), référence 10 m d'un seul tenant 246 m³/s en 245 s ; bassin 25 m + zone 2 km à 10 m → 246 m³/s (+0,04 %) en 36 s, 7 fois plus vite ✓.
  - Verdalaï (4,5 km², ravin étroit), référence 5 m : 69 m³/s. Tout à 10 m −5 %, tout à 25 m −8 % ; bassin 10 m + zone à 5 m −6 % ; bassin 25 m + zone à 5 m −11 % ; à maille égale (10 m + zone à 10 m) −2 %. Le couplage reste fidèle : l'écart vient de la maille grossière, qui étale le lit du ravin sur toute la maille. Un frottement du lit corrigé selon sa largeur a été essayé : trop sensible (à 25 m, pic de −25 % à +14 % selon le réglage), non retenu. L'application le signale désormais : avertissement pour un bassin de moins de 10 km² calculé à 25 m ou plus, et conseil de calculer tout le bassin à la maille fine quand ce n'est guère plus long.
- [x] Lit des cours d'eau : frottement d'un lit naturel (et non de la ripisylve) — résultats beaucoup moins dépendants de la maille

## Étape 3 — Rejouer une crue réelle et caler le modèle (≈ 3 séances) ✅

But : confronter le simulateur aux mesures et régler ses paramètres sur le terrain.

- [x] Vérifier l'accès depuis la page aux pluies horaires historiques (Météo-France, data.gouv) et aux débits historiques (Hub'Eau ; sinon import d'un fichier HydroPortail)
- [x] Mode « Épisode historique » : une date, les pluies horaires des stations proches, le débit mesuré à la station de la rivière la plus proche
- [x] Indicateurs d'écart simulé / mesuré : pic, heure du pic, volume, ressemblance des courbes
- [x] Calage assisté : simulations successives sur la capacité d'absorption du sol (rétention et infiltration ; le frottement n'est pas calé) ; réglage enregistré par secteur (lieux à moins de 30 km)
- [x] Vérifier : sur 2–3 crues connues (Arc, un cours d'eau cévenol, Weiss), pic simulé à ±30 % du pic mesuré après calage
  - Calé sur chaque crue : Arc 23/11/2019 pic +15 % ; Ganière 09/09/2002 +2 % ; Weiss 14/11/2023 pic +2 % mais volume −98 % (écoulement par le sol et les nappes non représenté).
  - Transposition d'une crue à l'autre (même station, sans recaler) : Arc 14/12/2008 +66 % (volume +25 %) avec le réglage de 2019 : objectif non atteint.
  - Sans calage : Arc 2019 +16 %, Arc 2008 +66 %, Ganière −53 %.
  - Avec l'humidité du sol mesurée (étape 4) : calé sur Arc 2019 (×1,5) → +10 % ; transposé à Arc 2008 → +26 % ✓ ; Ganière calée +2 % ✓. Weiss : hors de portée du modèle (pic retrouvé mais pas le volume).
  - Pistes : pluie variable dans l'espace (étape 4), débit de base.

## Étape 4 — Données d'entrée plus réalistes (≈ 2–3 séances) ✅

But : moins de réglages « au jugé ».

- [x] Humidité du sol mesurée : l'indice quotidien Météo-France (SIM2) n'est pas lisible depuis une page (fichiers nationaux de 1,3 Go triés par point) ; remplacé par NASA POWER (réanalyse MERRA-2, part de saturation de la zone des racines, depuis 1981, maille ≈ 50 km, sans clé). Utilisé pour les crues rejouées (la veille de la pluie) et affiché pour aujourd'hui dans la section Sol (bouton pour l'appliquer). Open-Meteo (ERA5-Land, plus fin) envisageable : quota journalier par adresse, non testable depuis l'environnement de développement.
  - Effet sur l'Arc à Meyreuil : même humidité mesurée avant les crues de 2019 et 2008 (75 %) ; calage sur 2019 → ×1,5 (pic +10 %, volume −1 %), appliqué tel quel à 2008 → pic +26 %, volume +12 % (au lieu de +66 % avec l'estimation par les pluies).
- [x] Pluie variable dans l'espace (épisodes réels) : blocs d'≈ 1 km (2 048 au plus), pluie horaire de chaque bloc interpolée depuis les stations (inverse du carré de la distance), dans les deux moteurs ; radar plus tard si les données sont ouvertes
  - Corrigé au passage : les départements voisins n'étaient pas tous lus (géocodage inverse IGN muet loin des adresses ; lecture arrêtée trop tôt) → service des communes de l'État et lecture de tous les départements.
  - Ganière 09/09/2002 sans calage : −53 % (5 stations d'Ardèche) → −35 % (9 stations, dont le Gard : La Grand-Combe 257 mm, Salindres 510 mm).
  - Arc, réglage ×1,5 : 2019 +26 %, 2008 +10 % (les deux dans ±30 %).
- [x] Ponts et buses : ouvrages repérés sur les cours d'eau étudiés, dimensions estimées ou saisies (largeur, hauteur sous tablier), débordement par-dessus la route au-delà de leur capacité (pont de l'avenue de Villelongue)
  - Repérage : remblai qui barre le lit (plus d'1 m au-dessus du lit amont et de la maille suivante, impossible à contourner dans un carré d'≈ 50 m), mailles de 10 m ou moins ; à 25–50 m, les « remblais » vus sont surtout des bosses du relief (211 sur la Roya) : le lit y reste creusé comme avant.
  - Dimensions par défaut : ouvrage qui laisse passer la crue centennale estimée ; modifiables sur la carte ; option embâcles (un tiers, deux tiers, bouché).
  - Calcul identique dans les deux moteurs (débit maximal dans une buse : 5,22 m³/s processeur, 5,21 GPU).
  - Verdalaï × avenue de Villelongue (pluie de test, 21 m³/s au lieu) : repéré à 10 m comme à 5 m (remblai de 2,6 m à 10 m, 4,6 m à 5 m) ; l'ouvrage estimé passe 13 à 17 m³/s, la route est submergée de 10 à 23 cm. À corriger avec les vraies dimensions du pont.
- [x] Rivière aval : reprendre les débits de crue décennale / centennale des stations quand ils existent, à la place de la formule
  - Station Hub'Eau de la rivière (même nom, bassin comparable, ≥ 15 années complètes), maxima annuels de septembre à août, loi de Gumbel, transposition à la confluence (Q ∝ S^0,8) ; formule en secours.
  - Arc sous la Torse (358 km²) : station de Meyreuil, 53 ans (1972–2026) → décennale 115, centennale 201 m³/s à la station, 234 m³/s à la confluence, au lieu de 430 m³/s par la formule.

## Étape 5 — Partage et confort (≈ 2 séances) ✅

But : rendre les résultats faciles à transmettre.

- [x] Rapport PDF d'une simulation ou d'une comparaison : carte, coupe, courbes, tableau, hypothèses et limites (page imprimable, « Enregistrer en PDF » du navigateur, aussi sur téléphone)
- [x] Lien de partage d'un scénario (lieu et réglages), relançable par quelqu'un d'autre (tout est dans l'adresse, rien sur un serveur)
- [x] Mode simple au premier lancement : lieu → pluie de référence → lancer
- [x] Gestion du stockage : place utilisée, nettoyage des anciennes simulations (20 dernières gardées automatiquement)

## Points de vigilance

- Accès aux données : chaque source (pluies horaires, humidité du sol, radar, débits historiques) est vérifiée au début de l'étape concernée ; à défaut, import d'un fichier.
- Les chiffres restent ceux d'un modèle simplifié tant que l'étape 3 n'est pas faite : à lire pour comparer des scénarios, pas comme une prévision.
