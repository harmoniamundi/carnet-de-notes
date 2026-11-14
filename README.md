# Carnet de notes

Appli autonome extraite du module **annotation** de Chord Scales : des pages libres où l'on pose des **cadres de texte** mis en forme et des **portées** (VexFlow) éditables, que le piano peut lire. Elle y ajoute des **blocs d'accords jouables**, construits avec le sélecteur d'accords de Chord Scales. Aucune grille d'accords, aucun autre module.

Pas de build : on ouvre `index.html` (ou n'importe quel serveur statique, par ex. `python3 -m http.server`). Hébergeable tel quel sur GitHub Pages. Fonctionne hors ligne (service worker).

## Fonctions

- **Pages** (onglets) : ajouter, renommer (double-clic), dupliquer, déplacer, supprimer. 40 pages max.
- **Édition** : double-clic sur la page = nouveau texte (cadre de texte) ; bouton « Texte » de la barre = idem, à une place vierge de la page (comme « Portée », « Accords » et « Dessin » : un nouveau bloc ne se pose jamais sur un autre, de préférence dans la partie visible) ; en mode édition, la barre n'affiche par défaut que les boutons **Texte, Portée, Dessin, Accords** (dans cet ordre) ; les menus de réglage du texte (police, taille, gras, italique, couleur, listes…) n'apparaissent que lorsqu'un cadre de texte est sélectionné ; un bouton **Supprimer** apparaît dès qu'un bloc est sélectionné (utilisable au doigt, sur téléphone et tablette) ; bouton « Portée » pour insérer une portée (durées, silences, altérations, tuplets, clé, mesure, armure, copier/coller, sélection…).
- **Blocs d'accords** : bouton « Accords » de la barre. Un bloc est une suite de **dominos** (un cadre complet par accord, largeur selon sa durée) : un simple clic sur un domino joue cet accord. Chaque accord a sa fondamentale, sa qualité (sélecteur « Construire » ou « Catalogue » de Chord Scales) et sa durée en temps. Double-clic ou crayon pour éditer ; dans l'éditeur, un clic sur le nom d'un accord (en haut) joue cet accord. Plaqué ou arpégé se choisit **à la lecture**, hors édition : ▶ joue la suite en plaqué, l'icône chevrons au-dessus (au survol) la joue en arpèges ; chaque domino porte aussi un petit chevron qui joue son accord en arpège. Jusqu'à 16 accords par bloc, 12 blocs par page. Copier/coller et annulation fonctionnent comme pour les portées.
- **Cadres de dessin libre** : bouton « Dessin » de la barre. On dessine à la souris, au stylet ou au doigt (palm rejection : si un stylet est utilisé, le toucher de la paume est ignoré). La fenêtre d'outils (à côté du cadre, déplaçable par son bandeau comme celle des accords) propose crayon, surligneur translucide, **remplissage** (un clic dans une forme fermée la remplit de la couleur choisie ; les petits trous dans le contour sont tolérés ; le remplissage passe sous les traits ; recliquer change sa couleur ; la gomme appuyée sur un remplissage le supprime) et gomme (n'efface que la partie touchée par le rond : un trait peut être coupé en deux), 9 couleurs + sélecteur libre, épaisseur 1 à 20 px, **lissage du tracé** de 0 (trait tel que tracé) à 10 (très lisse, réglage mémorisé), **pression du stylet** (le trait s'épaissit quand on appuie et s'affine quand on allège ; l'épaisseur réglée est celle d'une pression moyenne ; sans effet à la souris et au doigt ; désactivable), **taille de la gomme** réglable (6 à 60 px) avec un rond à la taille réelle qui suit le curseur, **fond du cadre** (transparent par défaut — pastille « rond blanc barré », et alors aucun trait de cadre n'est visible —, ou blanc, 8 couleurs, couleur libre ; les cadres enregistrés sans fond restent blancs), annuler / rétablir, « Tout effacer ». La poignée en bas à droite agrandit ou réduit le cadre **et son dessin** (proportions conservées, comme les autres cadres) ; le bouton « Le dessin suit le cadre » de la fenêtre d'outils, une fois éteint, ne change que la taille du cadre ; le cadre se déplace, se copie-colle et s'annule comme les autres blocs. Jusqu'à 6 cadres par page. **Tablette et téléphone** : pendant l'édition d'un cadre, un geste du stylet ou du doigt dans le cadre dessine et ne fait jamais défiler la page (`touch-action: none` + annulation de touchstart / touchmove) ; le bouton « ▾ Réduire » de la fenêtre d'outils la replie en un bandeau (annuler, rétablir, ▴ Outils, Terminé) pour que le cadre reste visible et dessinable, sans quitter l'édition. Dans le fichier : `data-draw="320,200[,t|rrggbb]|1e293b.3:12,30,2,1,…[~5559…]"` (taille et fond facultatif — `t` : transparent —, puis un élément par « | » : un trait = couleur, épaisseur, points en écarts, et pour un trait au stylet « ~ » suivi d'un niveau de pression de 1 à 9 par point ; un remplissage = `rrggbb@` suivi des contours en écarts).
- **Réglages de lecture par bloc** : chaque bloc, portée ou accords, a ses propres **tempo, swing et instrument** (Ut / Si♭ / Mi♭ ; **Si♭ par défaut** pour un carnet neuf), indépendants de ceux des autres blocs et réglés dans la fenêtre d'édition du bloc. Un nouveau bloc reprend ceux du dernier bloc créé. Il n'y a plus de réglage global dans l'en-tête. Dans le fichier : `data-staff="…,bpm90,sw67,inBb;…"` et `data-chords="b,bpm90,sw67,inBb|…"`.
- **Lecture** : petit ▶ noir au survol, **à droite du bloc, en dehors de celui-ci** (comme le crayon d'édition, qui ne mord jamais dans l'espace interne du bloc ; une marge de 36 px est réservée à droite de la page pour eux) ; pendant la lecture d'une portée, la tête de la note qui sonne devient bleue, et le domino d'un accord est coloré. Un simple clic sur une note (hors édition de la portée) la joue seule.
- **Annuler / rétablir** : boutons ↶ ↷ et ⌘Z / ⌘⇧Z (Ctrl sous Windows), sur tout le carnet (texte, portées, pages, titre, réglages).
- **Sauvegarde** : bouton disquette (carnets enregistrés dans le navigateur, menu « Ouvrir »), brouillon enregistré automatiquement et restauré au rechargement, « Nouveau » avec confirmation si des changements ne sont pas enregistrés.
- **Export / import** : fichier `.json` (`format: "carnet-de-notes"`). L'import accepte aussi une grille exportée par Chord Scales : ses annotations deviennent des pages (« Grille », « Mesure 5 »…).
- **Synchro entre appareils** : pas de bouton à part, c'est la **disquette** (ou ⌘S) qui sauvegarde en local puis synchronise aussitôt. Réglages (dépôt et jeton) : menu « Ouvrir » → « ⚙ Synchronisation entre appareils… ». Les carnets **sauvegardés** (menu « Ouvrir ») sont copiés dans un dépôt GitHub **privé** (un fichier par carnet dans `carnets/`), via l'API GitHub et un jeton « fine-grained » limité à ce dépôt (permission *Contents : Read and write*). Dépôt et jeton se saisissent une fois sur chaque appareil et restent dans son navigateur. La synchro se lance à chaque clic sur la disquette, à l'ouverture, au retour sur l'appli, quand le réseau revient, après chaque suppression ; une pastille sur la disquette n'apparaît que si quelque chose demande l'attention (bleue : en cours, orange : hors connexion, rouge : erreur) ; l'infobulle donne l'état détaillé. Le brouillon d'un carnet jamais sauvegardé n'est pas envoyé. Si un carnet a changé des deux côtés, rien n'est perdu : la version de l'autre appareil est gardée à côté sous « Nom (conflit JJ/MM HH:mm) ». Un carnet ouvert qui n'a pas de modification non sauvegardée est mis à jour tout seul (↶ pour revenir) ; s'il en a, il n'est pas touché. Une suppression voulue (× du menu « Ouvrir ») est répercutée sur les autres appareils.
- **Plein écran** : bouton icône (quatre coins) à droite de l'en-tête de la page, au bout de la rangée du zoom. C'est un faux plein écran, qui marche aussi sur iPhone : l'en-tête du carnet (titre, sauvegarde, réglages) est masqué pour que la page occupe tout l'écran ; les onglets de pages et ce bouton (qui devient « Quitter le plein écran ») restent visibles.
- **Écran toujours allumé** : tant que l'appli est ouverte, l'écran ne se met pas en veille (`app/awake.js` : API Screen Wake Lock, avec, en repli ou en complément sur une appli installée sur iPhone / iPad, une petite vidéo muette en boucle ; sur iOS elle ne démarre qu'après le premier toucher).
- Zoom, aimantation, mise au premier plan / arrière-plan des blocs, mode lecture, affichage téléphone.

## Structure

```
index.html                  page (en-tête, onglets, scène)
sw.js, manifest.webmanifest PWA / hors ligne
app/style.css               styles (annotations reprises de Chord Scales + mise en page du carnet)
app/carnet/carnet-format.js format du document, nettoyage du HTML, import/export
app/carnet/carnet-history.js annuler / rétablir (instantanés)
app/awake.js                maintien de l'écran allumé (Wake Lock + vidéo de repli), testé par awake.test.js
app/carnet/carnet-sync.js    synchro avec un dépôt GitHub privé : comparaison à trois voies (sha + empreinte), conflits sans perte (pur, testé avec une fausse API GitHub)
app/carnet/carnet-engine.js  classe CarnetApp : pages, sauvegarde, brouillon, audio, annotations
app/theory.js               théorie des accords (repris de Chord Scales)
app/ui/                     éditeur de portée, cadres de texte, barre de mise en forme, canevas (repris de Chord Scales)
app/ui/chord-notes.js       blocs d'accords : format `data-chords`, plan de lecture (pur, testé)
app/ui/chord-block.js       vue et éditeur (popover / feuille basse) des blocs d'accords
app/ui/chord-picker.js      sélecteur d'accords (repris de Chord Scales)
app/ui/draw-notes.js        cadres de dessin : format `data-draw`, simplification des traits, gomme (pur, testé)
app/ui/draw-block.js        vue et outils (couleur, épaisseur, gomme) des cadres de dessin
app/audio/local-soundfonts.js  chargement local du piano
app/sounds/                 piano FluidR3_GM (MP3 en base64)
app/vendor/, fonts/, licenses/  VexFlow, soundfont-player, Kalam
```

## Modifier

Les fichiers de `app/ui/` sont identiques à ceux de Chord Scales (hors libellés) : une amélioration de l'éditeur de portée ou de texte peut être recopiée dans les deux sens. Tout ce qui est propre au carnet est dans `app/carnet/`.

Après avoir changé un fichier mis en cache, incrémentez `SHELL_CACHE` dans `sw.js` pour que les appareils déjà installés prennent la nouvelle version (le réseau reste prioritaire pour les fichiers de l'appli, donc c'est surtout utile pour purger les anciens caches).

## Tests

```
npm test        # ou : node --test app/carnet/*.test.js app/ui/*.test.js app/audio/*.test.js app/theory.test.js
```

Node 20 ou plus, aucune dépendance.
