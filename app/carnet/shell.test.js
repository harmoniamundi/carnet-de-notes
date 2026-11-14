'use strict';
// Vérifie que la page, le service worker et le manifeste parlent des mêmes fichiers (sinon l'appli ne marcherait pas hors ligne).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const swFiles = [...read('sw.js').match(/const SHELL_FILES = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);

test('chaque fichier du service worker existe', () => {
    swFiles.filter(f => f !== './').forEach(f => assert.ok(fs.existsSync(path.join(ROOT, f)), `manquant : ${f}`));
});
test('chaque script, feuille de style et icône de index.html est mis en cache hors ligne', () => {
    const html = read('index.html');
    const used = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map(m => m[1]).filter(u => !/^https?:/.test(u));
    const missing = used.filter(u => !swFiles.includes(u));
    assert.deepEqual(missing, [], `absents de SHELL_FILES : ${missing.join(', ')}`);
    used.forEach(u => assert.ok(fs.existsSync(path.join(ROOT, u)), `manquant : ${u}`));
});
test('icônes du manifeste présentes', () => {
    JSON.parse(read('manifest.webmanifest')).icons.forEach(i => assert.ok(fs.existsSync(path.join(ROOT, i.src)), i.src));
});
test('le piano est disponible hors ligne (dossier sounds)', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'app/sounds/FluidR3_GM/acoustic_grand_piano-mp3.js')));
});
