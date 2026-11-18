// ui/shortcuts.js — raccourcis clavier personnalisables du Carnet de notes (sans DOM : testé par ui/shortcuts.test.js).
// Chaque action a un raccourci par défaut ; l'utilisateur peut en choisir un autre (panneau « Raccourcis » de l'en-tête).
// Les choix sont gardés dans le navigateur de l'appareil (localStorage « carnet-shortcuts-v1 ») : { idAction: combinaison }, '' = aucun raccourci.
// Combinaison : « Mod+Alt+Shift+touche », Mod = ⌘ sur Mac, Ctrl ailleurs ; touche en minuscule (lettres) ou nom de touche (ArrowUp, F2, Space…).
// Quelques touches restent fixes (flèches, Suppr., Échap, ⌘Z, ⌘C / ⌘X / ⌘V, ⌘A…) : elles ne peuvent pas être prises par une autre action.

const KB_STORAGE_KEY = 'carnet-shortcuts-v2';

// scope : 'carnet' = partout dans l'appli ; 'staff' = portée en édition.
const KB_ACTIONS = [
    { id: 'save',      scope: 'carnet', group: 'Carnet', label: 'Sauvegarder le carnet', def: 'Mod+s' },
    { id: 'print',     scope: 'carnet', group: 'Carnet', label: 'Imprimer', def: 'Mod+p' },
    { id: 'input',     scope: 'staff', group: 'Portée', label: 'Saisie de notes / sélection', def: 'n' },
    { id: 'dur16',     scope: 'staff', group: 'Portée', label: 'Double-croche', def: '1' },
    { id: 'dur8',      scope: 'staff', group: 'Portée', label: 'Croche', def: '2' },
    { id: 'durq',      scope: 'staff', group: 'Portée', label: 'Noire', def: '3' },
    { id: 'durh',      scope: 'staff', group: 'Portée', label: 'Blanche', def: '4' },
    { id: 'durw',      scope: 'staff', group: 'Portée', label: 'Ronde', def: '5' },
    { id: 'dot',       scope: 'staff', group: 'Portée', label: 'Note pointée', def: '.' },
    { id: 'rest',      scope: 'staff', group: 'Portée', label: 'Silence', def: 'r' },
    { id: 'tuplet',    scope: 'staff', group: 'Portée', label: 'Triolet', def: 't' },
    { id: 'tie',       scope: 'staff', group: 'Portée', label: 'Liaison de prolongation', def: 'l' },
    { id: 'sharp',     scope: 'staff', group: 'Portée', label: 'Dièse', def: '#' },
    { id: 'flat',      scope: 'staff', group: 'Portée', label: 'Bémol', def: '-' },
    { id: 'natural',   scope: 'staff', group: 'Portée', label: 'Bécarre', def: '0' },
    { id: 'note-c',    scope: 'staff', group: 'Notes', label: 'Do', def: 'c' },
    { id: 'note-d',    scope: 'staff', group: 'Notes', label: 'Ré', def: 'd' },
    { id: 'note-e',    scope: 'staff', group: 'Notes', label: 'Mi', def: 'e' },
    { id: 'note-f',    scope: 'staff', group: 'Notes', label: 'Fa', def: 'f' },
    { id: 'note-g',    scope: 'staff', group: 'Notes', label: 'Sol', def: 'g' },
    { id: 'note-a',    scope: 'staff', group: 'Notes', label: 'La', def: 'a' },
    { id: 'note-b',    scope: 'staff', group: 'Notes', label: 'Si', def: 'b' }
];

// Raccourcis fixes (affichés dans le panneau, non modifiables) et combinaisons qu'aucune action ne peut prendre.
const KB_FIXED = [
    ['Mod+z', 'Annuler'], ['Mod+Shift+z', 'Rétablir'], ['Mod+c', 'Copier'], ['Mod+x', 'Couper'], ['Mod+v', 'Coller'], ['Mod+a', 'Tout sélectionner'],
    ['ArrowUp', 'Note un degré plus haut (⇧ : octave)'], ['ArrowLeft', 'Note précédente / suivante (⇧ : étendre)'],
    ['Delete', 'Supprimer'], ['Escape', 'Quitter la saisie / désélectionner']
];
const KB_RESERVED = new Set(['Mod+z', 'Mod+Shift+z', 'Mod+y', 'Mod+c', 'Mod+x', 'Mod+v', 'Mod+a', 'Mod+Shift+a',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+ArrowLeft', 'Shift+ArrowRight',
    'Delete', 'Backspace', 'Escape', 'Tab', 'Shift+Tab', 'Enter', 'Shift+Enter', 'Space', 'Mod+q', 'Mod+w', 'Mod+r', 'Mod+t', 'Mod+n']);

const KB_MODIFIER_KEYS = new Set(['Shift', 'Control', 'Meta', 'Alt', 'AltGraph', 'CapsLock', 'Fn', 'OS', 'Dead', 'Unidentified', 'Process']);

let KB_OVERRIDES = {};

function kbStore() { try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; } }

function kbLoad() {
    KB_OVERRIDES = {};
    const s = kbStore();
    if (!s) return;
    try {
        // Réglages enregistrés avant la correction AZERTY : une combinaison ⌥+lettre y désignait la position QWERTY de la touche
        // (⌥A noté ⌥Q) ; on la retire, l'action revient à son raccourci par défaut.
        const OLD = KB_STORAGE_KEY.replace(/-v2$/, '-v1');
        if (OLD !== KB_STORAGE_KEY && s.getItem(OLD) !== null && s.getItem(KB_STORAGE_KEY) === null) {
            let o1 = {};
            try { o1 = JSON.parse(s.getItem(OLD) || '{}') || {}; } catch (e) { o1 = {}; }
            Object.keys(o1).forEach((k) => { if (/(^|\+)Alt\+([^+]*\+)?[a-z]$/.test(String(o1[k]))) delete o1[k]; });
            s.setItem(KB_STORAGE_KEY, JSON.stringify(o1));
            s.removeItem(OLD);
        }
        const o = JSON.parse(s.getItem(KB_STORAGE_KEY) || '{}');
        if (o && typeof o === 'object') KB_ACTIONS.forEach((a) => { if (typeof o[a.id] === 'string' && (o[a.id] === '' || !KB_RESERVED.has(o[a.id]))) KB_OVERRIDES[a.id] = o[a.id]; });
    } catch (e) { /* réglage illisible : défauts */ }
}

function kbSave() {
    const s = kbStore();
    if (!s) return;
    try { if (Object.keys(KB_OVERRIDES).length) s.setItem(KB_STORAGE_KEY, JSON.stringify(KB_OVERRIDES)); else s.removeItem(KB_STORAGE_KEY); } catch (e) { /* stockage plein ou interdit */ }
}

// Disposition du clavier : lettre produite par chaque touche physique (code « KeyQ »…). Avec ⌥ (Mac), la touche donne un caractère
// spécial (⌥A → « æ ») : on retrouve la lettre par la touche physique, mais la position physique n'est pas la même lettre selon
// le clavier (sur AZERTY, la touche « A » a le code KeyQ). On part donc d'une disposition supposée (AZERTY pour un navigateur
// en français de France ou de Belgique), corrigée par celle que donne le navigateur (Chrome) et par chaque lettre tapée.
const KB_LAYOUT = {};
const KB_AZERTY = { KeyQ: 'a', KeyA: 'q', KeyW: 'z', KeyZ: 'w', Semicolon: 'm', KeyM: '' };
function kbLayoutGuess() {
    let langs = [];
    try { langs = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language])) || []; } catch (e) { langs = []; }
    const first = String(langs[0] || '').toLowerCase();
    if (/^fr(-(fr|be|lu|mc))?$/.test(first)) Object.assign(KB_LAYOUT, KB_AZERTY);
}
function kbLearn(ev) {
    if (!ev || ev.altKey || ev.metaKey || ev.ctrlKey || typeof ev.code !== 'string' || typeof ev.key !== 'string') return;
    if ((/^Key[A-Z]$/.test(ev.code) || ev.code === 'Semicolon') && ev.key.length === 1) KB_LAYOUT[ev.code] = /^[a-z]$/i.test(ev.key) ? ev.key.toLowerCase() : '';
}
function kbLetterOf(code) {
    if (Object.prototype.hasOwnProperty.call(KB_LAYOUT, code)) return KB_LAYOUT[code] || null;
    const m = /^Key([A-Z])$/.exec(code);
    return m ? m[1].toLowerCase() : null;
}
kbLayoutGuess();
try {
    if (typeof navigator !== 'undefined' && navigator.keyboard && navigator.keyboard.getLayoutMap) {
        navigator.keyboard.getLayoutMap().then((map) => map.forEach((v, k) => { if ((/^Key[A-Z]$/.test(k) || k === 'Semicolon') && typeof v === 'string' && v.length === 1) KB_LAYOUT[k] = /^[a-z]$/i.test(v) ? v.toLowerCase() : ''; })).catch(() => {});
    }
} catch (e) { /* pas d'API de disposition */ }
if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', kbLearn, true);

// Combinaison d'un événement clavier ({ key, code, shiftKey|shift, metaKey|meta, ctrlKey|ctrl, altKey|alt }) ; null pour une touche de modification seule.
function kbCombo(ev) {
    if (!ev || typeof ev.key !== 'string' || KB_MODIFIER_KEYS.has(ev.key)) return null;
    const shift = !!(ev.shiftKey || ev.shift), meta = !!(ev.metaKey || ev.meta), ctrl = !!(ev.ctrlKey || ev.ctrl), alt = !!(ev.altKey || ev.alt);
    let key = ev.key;
    // Avec ⌥ (Mac), la touche donne un caractère spécial (⌥N → « ˜ ») : on garde la touche physique, plus lisible.
    if (alt && typeof ev.code === 'string') {
        let m;
        const letter = kbLetterOf(ev.code);
        if (/^[a-z]$/i.test(key)) key = key.toLowerCase(); // Windows / Linux : Alt laisse la lettre telle quelle (selon la disposition)
        else if (letter) key = letter;                    // Mac : ⌥ donne un caractère spécial ; lettre de la touche selon la disposition
        else if ((m = /^Digit(\d)$/.exec(ev.code))) key = m[1];
    }
    if (key === ' ') key = 'Space';
    const printable = key.length === 1;
    const letter = printable && /^[a-z]$/i.test(key);
    if (printable) key = key.toLowerCase();
    const parts = [];
    if (meta || ctrl) parts.push('Mod');
    if (alt) parts.push('Alt');
    if (shift && (!printable || letter)) parts.push('Shift'); // « # », « . »… s'obtiennent souvent avec Maj : Maj ne compte pas pour eux
    parts.push(key);
    return parts.join('+');
}

function kbBinding(id) {
    if (Object.prototype.hasOwnProperty.call(KB_OVERRIDES, id)) return KB_OVERRIDES[id];
    const a = KB_ACTIONS.find(x => x.id === id);
    return a ? a.def : '';
}

function kbBindings() { const o = {}; KB_ACTIONS.forEach((a) => { o[a.id] = kbBinding(a.id); }); return o; }

// Action liée à une combinaison (dans la portée `scope` si donnée) ; une lettre avec Maj retombe sur la lettre seule si Maj+lettre n'est pas pris.
function kbActionFor(combo, scope) {
    if (!combo) return null;
    const find = (c) => { const a = KB_ACTIONS.find(x => (!scope || x.scope === scope) && kbBinding(x.id) === c); return a ? a.id : null; };
    let id = find(combo);
    if (!id && /(^|\+)Shift\+[a-z]$/.test(combo)) {
        const plain = combo.replace('Shift+', '');
        if (!KB_ACTIONS.some(x => kbBinding(x.id) === combo)) id = find(plain);
    }
    return id;
}

// Action d'un événement clavier : la combinaison telle quelle, puis, pour une touche de la rangée des chiffres sans Maj qui donne
// un autre signe (AZERTY : « & é " ' ( »…), le chiffre de la touche — sauf si ce signe a lui-même un raccourci (« - » = bémol).
function kbActionForEvent(ev, scope) {
    const c = kbCombo(ev);
    if (!c) return null;
    const id = kbActionFor(c, scope);
    if (id) return id;
    const m = typeof ev.code === 'string' && /^Digit(\d)$/.exec(ev.code);
    if (m && ev.key !== m[1] && !(ev.altKey || ev.alt)) {
        const parts = c.split('+'); parts[parts.length - 1] = m[1];
        return kbActionFor(parts.filter(x => x !== 'Shift').join('+'), scope);
    }
    return null;
}

function kbMatch(ev, id) { return kbActionForEvent(ev) === id; }

// Change le raccourci d'une action. Renvoie { ok, error?, replaced? } ; une action qui avait déjà cette combinaison la perd (replaced = son id).
function kbSet(id, combo) {
    const a = KB_ACTIONS.find(x => x.id === id);
    if (!a) return { ok: false, error: 'Action inconnue.' };
    if (combo && KB_RESERVED.has(combo)) return { ok: false, error: `${kbLabel(combo)} est réservé (raccourci fixe ou du navigateur).` };
    let replaced = null;
    if (combo) KB_ACTIONS.forEach((x) => { if (x.id !== id && kbBinding(x.id) === combo) { replaced = x.id; KB_OVERRIDES[x.id] = ''; } });
    if (combo === a.def) delete KB_OVERRIDES[id]; else KB_OVERRIDES[id] = combo || '';
    kbTidy();
    kbSave();
    return { ok: true, replaced };
}

function kbReset(id) {
    if (id) {
        const a = KB_ACTIONS.find(x => x.id === id);
        if (!a) return { ok: false };
        return kbSet(id, a.def);
    }
    KB_OVERRIDES = {};
    kbSave();
    return { ok: true };
}

// Les surcharges égales au défaut ne sont pas gardées.
function kbTidy() { Object.keys(KB_OVERRIDES).forEach((k) => { const a = KB_ACTIONS.find(x => x.id === k); if (a && KB_OVERRIDES[k] === a.def) delete KB_OVERRIDES[k]; }); }

function kbIsMac() {
    try { return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || ''); } catch (e) { return true; }
}

const KB_KEY_NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Espace', Enter: 'Entrée', Escape: 'Échap', Delete: 'Suppr.', Backspace: '⌫', Tab: 'Tab',
    PageUp: 'Page ↑', PageDown: 'Page ↓', Home: 'Début', End: 'Fin', Insert: 'Inser' };

// Texte lisible d'une combinaison : « ⌘S », « ⇧N », « Ctrl+S » hors Mac ; '—' sans raccourci.
function kbLabel(combo, mac) {
    if (!combo) return '—';
    if (mac === undefined) mac = kbIsMac();
    const parts = combo.split('+');
    let key = parts.pop();
    if (key === '') key = '+'; // touche « + » : « Mod++ »
    key = KB_KEY_NAMES[key] || (key.length === 1 ? key.toUpperCase() : key);
    const mods = parts.filter(Boolean);
    if (mac) return mods.map(m => ({ Mod: '⌘', Alt: '⌥', Shift: '⇧' })[m] || m).join('') + key;
    return mods.map(m => ({ Mod: 'Ctrl', Alt: 'Alt', Shift: 'Maj' })[m] || m).concat([key]).join('+');
}

// « (clavier : N) » pour les infobulles, ou '' si l'action n'a pas de raccourci.
function kbHint(id) { const c = kbBinding(id); return c ? ` (clavier : ${kbLabel(c)})` : ''; }

kbLoad();

const Shortcuts = { KB_ACTIONS, KB_FIXED, KB_RESERVED, KB_STORAGE_KEY, kbLoad, kbCombo, kbBinding, kbBindings, kbActionFor, kbActionForEvent, kbMatch, KB_LAYOUT, kbSet, kbReset, kbLabel, kbHint, kbIsMac };

if (typeof module !== 'undefined' && module.exports) module.exports = Shortcuts;
