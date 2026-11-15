// Tests de carnet/carnet-sheets.js : formats, saut de page, rangement sur une feuille, zoom, fond.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./carnet-sheets.js');
const F = require('./carnet-format.js');

const A4 = S.sheetSize('A4', 'portrait');

test('formats : A4 = 794 × 1123 px, paysage = inversé, valeur inconnue = A4 portrait', () => {
    assert.deepEqual(A4, { w: 794, h: 1123 });
    assert.deepEqual(S.sheetSize('A4', 'landscape'), { w: 1123, h: 794 });
    assert.deepEqual(S.sheetSize('A3', 'portrait'), { w: 1123, h: 1587 });
    assert.deepEqual(S.sheetSize('A5', 'portrait'), { w: 559, h: 794 });
    assert.deepEqual(S.sheetSize('Letter', 'portrait'), { w: 816, h: 1056 });
    assert.deepEqual(S.sheetSize('B7', 'oblique'), A4);
    assert.deepEqual(S.sheetSize(undefined, undefined), A4);
});

test('les formats du module sont ceux que le format de fichier accepte', () => {
    assert.deepEqual(F.CARNET_PAPERS, S.SHEET_PAPER_KEYS);
    assert.deepEqual(F.CARNET_ORIENTS, S.SHEET_ORIENTS);
});

test('feuilles : position, hauteur totale, feuille d\'une hauteur', () => {
    assert.equal(S.sheetTop(0, A4), 0);
    assert.equal(S.sheetTop(1, A4), 1123 + S.SHEET_GAP);
    assert.equal(S.sheetsHeight(2, A4), 2 * (1123 + S.SHEET_GAP) - S.SHEET_GAP);
    assert.equal(S.sheetOfY(0, A4), 0);
    assert.equal(S.sheetOfY(1122, A4), 0);
    assert.equal(S.sheetOfY(1123 + 10, A4), 0); // l'espace compte pour la feuille qui précède
    assert.equal(S.sheetOfY(S.sheetTop(1, A4), A4), 1);
    assert.equal(S.sheetOfY(1e9, A4), S.SHEETS_MAX - 1);
    assert.equal(S.sheetOfY(-50, A4), 0);
});

test('sheetFits : entièrement sur une feuille, ni à cheval, ni dans l\'espace, ni au-delà du bord droit', () => {
    assert.equal(S.sheetFits({ x: 10, y: 10, w: 200, h: 100 }, A4), true);
    assert.equal(S.sheetFits({ x: 0, y: 0, w: 794, h: 1123 }, A4), true);
    assert.equal(S.sheetFits({ x: 700, y: 10, w: 200, h: 100 }, A4), false);       // dépasse à droite
    assert.equal(S.sheetFits({ x: 10, y: 1100, w: 100, h: 50 }, A4), false);       // à cheval
    assert.equal(S.sheetFits({ x: 10, y: 1130, w: 100, h: 5 }, A4), false);        // dans l'espace
    assert.equal(S.sheetFits({ x: 10, y: S.sheetTop(1, A4) + 5, w: 100, h: 50 }, A4), true);
});

test('sheetOfRect : la feuille la plus recouverte', () => {
    assert.equal(S.sheetOfRect({ x: 0, y: 1100, w: 100, h: 50 }, A4), 0);          // 23 px sur la 0, 26 px dans l'espace → la 0
    assert.equal(S.sheetOfRect({ x: 0, y: 1100, w: 100, h: 100 }, A4), 1);         // 23 px sur la 0, 53 sur la 1
    assert.equal(S.sheetOfRect({ x: 0, y: 1130, w: 100, h: 10 }, A4), 0);          // dans l'espace : la plus proche par le centre
});

test('sheetFitGroup : pousse sur la feuille la plus recouverte, garde la disposition du groupe', () => {
    const t1 = S.sheetTop(1, A4);
    // bloc à cheval, surtout sur la 2e feuille → poussé vers le bas, en haut de la feuille 2
    assert.deepEqual(S.sheetFitGroup([{ x: 10, y: 1100, w: 100, h: 100 }], A4), [{ x: 10, y: t1 }]);
    // bloc à cheval, surtout sur la 1re → remonté
    assert.deepEqual(S.sheetFitGroup([{ x: 10, y: 1050, w: 100, h: 100 }], A4), [{ x: 10, y: 1023 }]);
    // dépasse à droite → ramené
    assert.deepEqual(S.sheetFitGroup([{ x: 750, y: 10, w: 100, h: 50 }], A4), [{ x: 694, y: 10 }]);
    // rien à faire
    assert.deepEqual(S.sheetFitGroup([{ x: 10, y: 10, w: 100, h: 50 }], A4), [{ x: 10, y: 10 }]);
    // groupe : même décalage pour tous
    const g = S.sheetFitGroup([{ x: 700, y: 10, w: 100, h: 50 }, { x: 600, y: 100, w: 50, h: 50 }], A4);
    assert.deepEqual(g, [{ x: 694, y: 10 }, { x: 594, y: 100 }]);
    // groupe plus grand qu'une feuille : bloc par bloc
    const big = S.sheetFitGroup([{ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 1500, w: 100, h: 50 }], A4);
    assert.deepEqual(big, [{ x: 0, y: 0 }, { x: 0, y: 1500 }]);
    assert.deepEqual(S.sheetFitGroup([], A4), []);
});

test('sheetFitGroup : un bloc plus grand que la feuille est calé en haut à gauche de sa feuille', () => {
    assert.deepEqual(S.sheetFitGroup([{ x: 30, y: 30, w: 900, h: 100 }], A4), [{ x: 0, y: 30 }]);
});

test('sheetOffside : au moins la moitié du bloc est au-delà du bord droit', () => {
    assert.equal(S.sheetOffside({ x: 600, y: 0, w: 200, h: 10 }, A4), false);
    assert.equal(S.sheetOffside({ x: 700, y: 0, w: 200, h: 10 }, A4), true);
    assert.equal(S.sheetOffside({ x: 790, y: 0, w: 200, h: 10 }, A4), true);
});

test('sheetCount : feuilles occupées + une feuille vide, de 1 à SHEETS_MAX', () => {
    assert.equal(S.sheetCount([], A4), 2);
    assert.equal(S.sheetCount([{ x: 0, y: 0, w: 10, h: 10 }], A4), 2);
    assert.equal(S.sheetCount([{ x: 0, y: S.sheetTop(1, A4), w: 10, h: 10 }], A4), 3);
    assert.equal(S.sheetCount([{ x: 0, y: S.sheetTop(S.SHEETS_MAX - 1, A4), w: 10, h: 10 }], A4), S.SHEETS_MAX);
});

test('sheetBrokenGaps : les espaces que des blocs chevauchent', () => {
    assert.deepEqual(S.sheetBrokenGaps([{ x: 0, y: 0, w: 10, h: 10 }], A4), []);
    assert.deepEqual(S.sheetBrokenGaps([{ x: 0, y: 1100, w: 10, h: 40 }], A4), [0]);
    assert.deepEqual(S.sheetBrokenGaps([{ x: 0, y: 1130, w: 10, h: 5 }], A4), [0]);
    assert.deepEqual(S.sheetBrokenGaps([{ x: 0, y: S.sheetTop(1, A4) + 1090, w: 10, h: 50 }], A4), [1]);
});

test('zoom : échelle d\'ajustement, zoom minimal (hauteur d\'une feuille), crans', () => {
    assert.ok(Math.abs(S.sheetFitScale(1000, A4) - 1000 / 794) < 1e-9);
    // zone 1000 × 700 : la feuille entière (1123 de haut) doit tenir en hauteur
    const u = S.sheetMinZoom(1000, 700, A4);
    const s = S.sheetFitScale(1000, A4) * u;
    assert.ok(s * A4.h <= 700 - 24 && s * A4.h > 700 - 24 - 12, `s·h = ${s * A4.h}`);
    assert.equal(S.sheetMinZoom(300, 5000, A4), 1);   // zone haute et étroite : jamais plus de 100 %
    assert.ok(S.sheetMinZoom(1000, 10, A4) >= S.SHEET_ZOOM_FLOOR);
    assert.equal(S.sheetClampZoom(0.01, 0.4), 0.4);
    assert.equal(S.sheetClampZoom(99), 3);
    assert.equal(S.sheetClampZoom('x'), 1);
    assert.equal(S.sheetZoomStep(1, 1, 0.4), 1.25);
    assert.equal(S.sheetZoomStep(1, -1, 0.4), 0.8);
    assert.equal(S.sheetZoomStep(0.5, -1, 0.4), 0.4);   // le dernier cran est le zoom minimal
    assert.equal(S.sheetZoomStep(0.4, -1, 0.4), 0.4);
    assert.equal(S.sheetZoomStep(0.4, 1, 0.4), 0.5);
    assert.equal(S.sheetZoomStep(3, 1, 0.4), 3);
    assert.equal(S.sheetZoomStep(0.35, 1, 0.35), 0.5);
});

test('sheetOffsetX : la feuille est centrée quand elle est plus étroite que la zone', () => {
    assert.equal(S.sheetOffsetX(1000, A4, 1000 / 794), 0);
    assert.equal(S.sheetOffsetX(1000, A4, 0.5), Math.floor((1000 - 397) / 2));
    assert.equal(S.sheetOffsetX(500, A4, 1), 0);
});

test('sheetBackground : une couche par feuille (+ contour), les espaces cassés en rouge, dimensions du défilement', () => {
    const b = S.sheetBackground(A4, 0.5, 100, 3, []);
    assert.equal(b.image.split('linear-gradient').length - 1, 6);
    assert.equal(b.size.split(',').length, 6);
    assert.equal(b.position.split(',').length, 6);
    assert.equal(b.height, Math.ceil(S.sheetsHeight(3, A4) * 0.5));
    assert.equal(b.width, Math.ceil(794 * 0.5 + 100));
    const r = S.sheetBackground(A4, 0.5, 0, 3, [0, 7]);
    assert.equal(r.image.split('linear-gradient').length - 1, 7);   // l'espace 7 n'existe pas : ignoré
    assert.ok(r.image.startsWith('linear-gradient(rgba(239'));
});

test('sheetBackground : avec une marge, 4 liserés par feuille marquent la zone imprimable (au-dessus du papier)', () => {
    const b = S.sheetBackground(A4, 1, 0, 2, [], S.SHEET_MARGIN);
    assert.equal(b.image.split('linear-gradient').length - 1, 2 * 4 + 2 + 2);
    assert.ok(b.position.startsWith(`${S.SHEET_MARGIN}px ${S.SHEET_MARGIN}px`));
    assert.equal(S.sheetBackground(A4, 1, 0, 2, [], 0).image.split('linear-gradient').length - 1, 4);
    assert.equal(S.sheetBackground(A4, 1, 0, 1, [], 600).image.split('linear-gradient').length - 1, 2); // marge absurde : ignorée
});
