'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const F = require('./carnet-format.js');

const frame = (t) => `<div class="annot-frame" data-frame="a" data-at="10,10" data-border="0">${t}</div>`;

describe('sanitizeNoteHtml', () => {
    test('retire scripts et attributs dangereux', () => {
        const out = F.sanitizeNoteHtml('<img src=x onerror="alert(1)"><script>alert(1)</script><b onclick="x()">ok</b>');
        assert.ok(!/script|onerror|onclick|<img/i.test(out), out);
        assert.match(out, /ok/);
    });
    test('garde un cadre de texte valide', () => {
        assert.match(F.sanitizeNoteHtml(frame('Bonjour')), /annot-frame/);
    });
});

describe('blocs d\'accords', () => {
    const chords = (t, extra = '') => `<div class="annot-chords" data-chords="${t}" data-at="10,20"${extra}></div>`;
    test('un bloc valide est gardé, réécrit sous sa forme canonique', () => {
        const out = F.sanitizeNoteHtml(chords(' a|0~maj7~4|7~7~2 '));
        assert.equal(out, chords('a|0~maj7~4|7~7~2'));
        // réglages propres au bloc : conservés, écrits dans la forme canonique
        assert.equal(F.sanitizeNoteHtml(chords('a,inBb,sw67,bpm90|0~maj7~4')), chords('a,bpm90,sw67,inBb|0~maj7~4'));
    });
    test('bloc invalide ou contenu étranger : écarté', () => {
        assert.equal(F.sanitizeNoteHtml(chords('b|0~zzz~4')), '');
        const out = F.sanitizeNoteHtml(`<div class="annot-chords" data-chords="b|0~maj7~4" onclick="x()"><script>alert(1)</script><b>pirate</b></div>`);
        assert.ok(!/onclick|script|pirate/.test(out), out);
        assert.match(out, /data-chords="b\|0~maj7~4"/);
    });
    test('bord caché conservé ; pas de bloc d\'accords dans un cadre de texte ; limite par page', () => {
        assert.match(F.sanitizeNoteHtml(chords('b|0~maj7~4', ' data-border="0"')), /data-border="0"/);
        assert.ok(!/annot-chords/.test(F.sanitizeNoteHtml(frame(chords('b|0~maj7~4')))));
        const many = chords('b|0~maj7~4').repeat(30);
        assert.equal((F.sanitizeNoteHtml(many).match(/annot-chords/g) || []).length, F.NOTE_MAX_CHORDS);
    });
    test('mélangé aux cadres et aux portées', () => {
        const out = F.sanitizeNoteHtml(frame('Texte') + chords('b|0~maj7~4') + '<div class="annot-staff" data-staff="t,4/4,0;q:c4"></div>');
        assert.match(out, /annot-frame/); assert.match(out, /annot-chords/); assert.match(out, /annot-staff/);
    });
});

describe('document carnet', () => {
    test('newCarnet : une page, réglages par défaut', () => {
        const c = F.newCarnet();
        assert.equal(c.pages.length, 1);
        assert.equal(c.current, 0);
        assert.equal(c.settings.bpm, F.CARNET_BPM_DEFAULT);
    });
    test('aller-retour fichier : carnetToFile → sanitizeCarnet', () => {
        const c = F.newCarnet();
        c.title = 'Ma leçon';
        c.pages[0].html = frame('Do ré mi');
        c.pages.push({ name: 'Gammes', html: '' });
        const back = F.sanitizeCarnet(JSON.parse(JSON.stringify(F.carnetToFile(c))));
        assert.equal(back.title, 'Ma leçon');
        assert.deepEqual(back.pages.map(p => p.name), ['Page 1', 'Gammes']);
        assert.match(back.pages[0].html, /Do ré mi/);
    });
    test('sanitizeCarnet refuse ce qui n\'est pas un carnet', () => {
        assert.equal(F.sanitizeCarnet(null), null);
        assert.equal(F.sanitizeCarnet({ foo: 1 }), null);
    });
    test('limites : titre, nombre de pages, tempo', () => {
        const raw = F.carnetToFile(F.newCarnet());
        raw.title = 'x'.repeat(500);
        raw.pages = Array.from({ length: 100 }, (_, i) => ({ name: 'P' + i, html: '' }));
        raw.settings = { bpm: 9999, swing: 50, instrument: 'Zz' };
        const c = F.sanitizeCarnet(raw);
        assert.ok(c.title.length <= F.CARNET_TITLE_MAX);
        assert.ok(c.pages.length <= F.CARNET_MAX_PAGES);
        assert.ok(c.settings.bpm <= F.CARNET_BPM_MAX);
        assert.ok(F.CARNET_INSTRUMENTS.includes(c.settings.instrument));
    });
    test('carnetIsEmpty / carnetSignature', () => {
        const c = F.newCarnet();
        assert.equal(F.carnetIsEmpty(c), true);
        const s1 = F.carnetSignature(c);
        c.pages[0].html = frame('x');
        assert.equal(F.carnetIsEmpty(c), false);
        assert.notEqual(F.carnetSignature(c), s1);
    });
    test('nextPageName évite les doublons ; carnetFileName est sûr', () => {
        const n = F.nextPageName([{ name: 'Page 1' }, { name: 'Page 2' }]);
        assert.ok(!['Page 1', 'Page 2'].includes(n));
        assert.equal(F.carnetFileName('Mon carnet'), 'Mon-carnet.json');
        assert.ok(!/[\\/:*?"<>|]/.test(F.carnetFileName('a/b:c')));
        assert.equal(F.carnetFileName(''), 'carnet.json');
    });
});

describe('import depuis Chord Scales', () => {
    const grid = { format: 'chord-scales-jam-grid', name: 'Blues', bpm: 120, notes: frame('Général'),
        grid: [{ measures: 1, note: frame('M1') }, { measures: 2 }, { measures: 1, note: frame('M4') }] };
    test('une page par annotation, mesures numérotées', () => {
        const c = F.carnetFromChordScales(grid);
        assert.deepEqual(c.pages.map(p => p.name), ['Grille', 'Mesure 1', 'Mesure 4']);
        assert.equal(c.title, 'Blues');
        assert.equal(c.settings.bpm, 120);
    });
    test('null si ce n\'est pas une grille ou sans annotation', () => {
        assert.equal(F.carnetFromChordScales({ format: 'autre' }), null);
        assert.equal(F.carnetFromChordScales({ format: 'chord-scales-jam-grid', grid: [{ measures: 1 }] }), null);
    });
});

describe('cadres de dessin', () => {
    const draw = (t, extra = '') => `<div class="annot-draw" data-draw="${t}" data-at="10,20"${extra}></div>`;
    test('un cadre valide est gardé, réécrit sous sa forme canonique (traits compris)', () => {
        assert.equal(F.sanitizeNoteHtml(draw(' 320,200|1E293B.3:12,30,2,1 ')), draw('320,200|1e293b.3:12,30,2,1'));
        assert.equal(F.sanitizeNoteHtml(draw('320,200')), draw('320,200'));
    });
    test('en-tête invalide : cadre écarté ; trait invalide : ignoré ; contenu étranger : jeté', () => {
        assert.equal(F.sanitizeNoteHtml(draw('abc')), '');
        assert.equal(F.sanitizeNoteHtml(draw('320,200|zz.3:1,1|0f172a.3:5,5')), draw('320,200|0f172a.3:5,5'));
        const out = F.sanitizeNoteHtml(`<div class="annot-draw" data-draw="320,200" onclick="x()"><script>alert(1)</script><svg onload="y()"></svg></div>`);
        assert.ok(!/onclick|script|onload|svg/.test(out), out);
    });
    test('bord caché conservé ; pas de dessin dans un cadre de texte ; limite par page', () => {
        assert.match(F.sanitizeNoteHtml(draw('320,200', ' data-border="0"')), /data-border="0"/);
        assert.ok(!/annot-draw/.test(F.sanitizeNoteHtml(frame(draw('320,200')))));
        assert.equal((F.sanitizeNoteHtml(draw('320,200').repeat(20)).match(/annot-draw/g) || []).length, F.NOTE_MAX_DRAWS);
    });
    test('les traits ne comptent pas dans la limite du texte de la page', () => {
        const big = '320,200|' + Array.from({ length: 40 }, () => '0f172a.3:10,10,' + Array.from({ length: 100 }, () => '1,1').join(',')).join('|');
        assert.match(F.sanitizeNoteHtml(draw(big)), /annot-draw/);
    });
});

describe('cadre de dessin : fond', () => {
    test('le fond (transparent ou couleur) survit à l\'assainissement', () => {
        const mk = (d) => `<div class="annot-draw" data-draw="${d}" data-at="10,10"></div>`;
        const t = F.sanitizeNoteHtml(mk('320,200,t|0f172a.3:1,1,4,4'));
        assert.match(t, /data-draw="320,200,t\|0f172a\.3:1,1,4,4"/);
        assert.match(F.sanitizeNoteHtml(mk('320,200,FEF3C7')), /data-draw="320,200,fef3c7"/);
        assert.match(F.sanitizeNoteHtml(mk('320,200,zzzzzz')), /data-draw="320,200"|^$/);
    });
});
