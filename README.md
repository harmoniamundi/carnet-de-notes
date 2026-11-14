# Carnet de notes

Appli autonome extraite du module **annotation** de Chord Scales : des pages libres où l'on pose des **cadres de texte** mis en forme et des **portées** (VexFlow) éditables, que le piano peut lire. Elle y ajoute des **blocs d'accords jouables**, construits avec le sélecteur d'accords de Chord Scales. Aucune grille d'accords, aucun autre module.

Pas de build : on ouvre `index.html` (ou n'importe quel serveur statique, par ex. `python3 -m http.server`). Hébergeable tel quel sur GitHub Pages. Fonctionne hors ligne (service worker).

## Fonctions

- **Pages** (onglets) : ajouter, renommer (double-clic), dupliquer, déplacer, supprimer. 40 pages max.
- **Édition** : double-clic sur la page = nouveau cadre de texte ; barre de mise en forme (police, taille, gras, italique, couleur, listes…) ; bouton « Portée » pour insérer une portée (durées, silences, altérations, tuplets, clé, mesure, armure, copier/coller, sélection…).
- **Blocs d'accords** : bouton « Accords » de la barre. Un bloc est une suite de **dominos** (un cadre complet par accord, largeur selon sa durée) : un simple clic sur un domino joue cet accord. Chaque accord a sa fondamentale, sa qualité (sélecteur « Construire » ou « Catalogue » de Chord Scales) et sa durée en temps. Double-clic ou crayon pour éditer ; chaque bloc se joue **plaqué** ou **arpégé** (au choix par bloc). Jusqu'à 16 accords par bloc, 12 blocs par page. Copier/coller et annulation fonctionnent comme pour les portées.
- **Cadres de dessin libre** : bouton « Dessin » de la barre. On dessine à la souris, au stylet ou au doigt (palm rejection : si un stylet est utilisé, le toucher de la paume est ignoré). La fenêtre d'outils (à côté du cadre, déplaçable par son bandeau comme celle des accords) propose crayon, surligneur translucide et gomme (n'efface que la partie touchée par le rond : un trait peut être coupé en deux), 9 couleurs + sélecteur libre, épaisseur 1 à 20 px, **lissage du tracé** de 0 (trait tel que tracé) à 10 (très lisse, réglage mémorisé), **pression du stylet** (le trait s'épaissit quand on appuie et s'affine quand on allège ; l'épaisseur réglée est celle d'une pression moyenne ; sans effet à la souris et au doigt ; désactivable), **taille de la gomme** réglable (6 à 60 px) avec un rond à la taille réelle qui suit le curseur, **fond du cadre** (blanc par défaut, 8 couleurs, couleur libre ou transparent), annuler / rétablir, « Tout effacer ». La poignée en bas à droite agrandit ou réduit le cadre **et son dessin** (proportions conservées, comme les autres cadres) ; le bouton « Le dessin suit le cadre » de la fenêtre d'outils, une fois éteint, ne change que la taille du cadre ; le cadre se déplace, se copie-colle et s'annule comme les autres blocs. Jusqu'à 6 cadres par page. Dans le fichier : `data-draw="320,200[,t|rrggbb]|1e293b.3:12,30,2,1,…[~5559…]"` (taille et fond facultatif — `t` : transparent —, puis un trait par « | » : couleur, épaisseur, points en écarts, et pour un trait au stylet « ~ » suivi d'un niveau de pression de 1 à 9 par point).
- **Réglages de lecture par bloc** : chaque bloc, portée ou accords, a son propre **tempo, swing et instrument** (Ut / Si♭ / Mi♭), indépendants des autres blocs. Un nouveau bloc reprend ceux du dernier bloc créé ; la ligne « Par défaut » de l'en-tête ne sert qu'au premier bloc d'une page vide et aux blocs écrits avant ce réglage. Dans le fichier : `data-staff="…,bpm90,sw67,inBb;…"` et `data-chords="b,bpm90,sw67,inBb|…"`.
- **Lecture** : petit ▶ noir au survol, en bas à droite de chaque bloc (en mode lecture) ; pendant la lecture d'une portée, la tête de la note qui sonne devient bleue, et le domino d'un accord est coloré. Un simple clic sur une note (hors édition de la portée) la joue seule.
- **Annuler / rétablir** : boutons ↶ ↷ et ⌘Z / ⌘⇧Z (Ctrl sous Windows), sur tout le carnet (texte, portées, pages, titre, réglages).
- **Sauvegarde** : bouton disquette (carnets enregistrés dans le navigateur, menu « Ouvrir »), brouillon enregistré automatiquement et restauré au rechargement, « Nouveau » avec confirmation si des changements ne sont pas enregistrés.
- **Export / import** : fichier `.json` (`format: "carnet-de-notes"`). L'import accepte aussi une grille exportée par Chord Scales : ses annotations deviennent des pages (« Grille », « Mesure 5 »…).
- Zoom, aimantation, mise au premier plan / arrière-plan des blocs, mode lecture, affichage téléphone.

## Structure

```
index.html                  page (en-tête, onglets, scène)
sw.js, manifest.webmanifest PWA / hors ligne
app/style.css               styles (annotations reprises de Chord Scales + mise en page du carnet)
app/carnet/carnet-format.js format du document, nettoyage du HTML, import/export
app/carnet/carnet-history.js annuler / rétablir (instantanés)
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
