// carnet/carnet-format.js — format du Carnet de notes : nettoyage des annotations (HTML restreint) et du document (.json).
// Fonctions pures, sans DOM : tout ce qui vient de l'extérieur (fichier importé, sauvegarde du navigateur) est nettoyé ;
// ce qui n'est pas valide est écarté ou ramené à une valeur sûre, et aucun code ne peut s'y glisser.
// Le nettoyeur d'annotations (sanitizeNoteHtml et ses tables) est celui de Chord Scales (app/grid/grid-format.js), repris tel quel :
// un carnet et une annotation de Chord Scales se copient donc l'un dans l'autre sans perte.
// Chargé par index.html via <script src="app/carnet/carnet-format.js"> (après ui/staff-notes.js) et testé par carnet-format.test.js.

// Portées éditables et cadres de texte (ui/staff-notes.js) : un bloc n'est gardé que si son texte est valide.
// Sous Node on les charge ; en navigateur ce sont des globaux.
const GF_STAFF = (typeof parseStaff !== 'undefined')
    ? { parseStaff, formatStaff, parseStaffPos, formatStaffPos, parseBlockAt, formatBlockAt, parseBlockBorder, parseFrameBox, formatFrameBox }
    : require('../ui/staff-notes.js');
// Blocs d'accords jouables (ui/chord-notes.js) : même principe, le texte « data-chords » est relu et réécrit sous sa forme canonique.
const GF_CHORDS = (typeof chordsCanon !== 'undefined') ? { chordsCanon } : require('../ui/chord-notes.js');
// Cadres de dessin libre (ui/draw-notes.js) : « data-draw » est relu (traits compris) et réécrit sous sa forme canonique.
const GF_DRAW = (typeof drawCanon !== 'undefined') ? { drawCanon } : require('../ui/draw-notes.js');

// Limites d'une page : 8000 signes de texte, 8 portées, 12 blocs d'accords et 8 cadres de texte (le texte d'un cadre compte dans la limite de la page ;
// pas de cadre dans un cadre, ni de portée). Un carnet compte jusqu'à 40 pages.
const PAGE_NOTE_MAX = 8000;
const NOTE_MAX_STAVES = 8;
const NOTE_MAX_FRAMES = 8;
const NOTE_MAX_CHORDS = 12; // blocs d'accords par page (jusqu'à 16 accords chacun)
const NOTE_MAX_DRAWS = 6;   // cadres de dessin par page (leurs traits ne comptent pas dans la limite du texte)
const MEASURE_NOTE_MAX = PAGE_NOTE_MAX; // nom d'origine, valeur par défaut du nettoyeur ci-dessous



// Polices proposées par la barre de mise en forme (nom de la première famille en minuscules → valeur CSS enregistrée).
// Ce sont des polices du système, plus la police « Real Book » (Kalam) fournie avec l'appli : aucune autre n'est acceptée.
// La liste doit rester identique à ANNOT_FONT_CHOICES (ui/annot-bar.js) : un test le vérifie.
const NOTE_FONTS = {
    'system-ui': "system-ui,-apple-system,'Segoe UI',sans-serif",
    arial: 'Arial,Helvetica,sans-serif',
    verdana: 'Verdana,Geneva,sans-serif',
    'trebuchet ms': "'Trebuchet MS',sans-serif",
    'gill sans': "'Gill Sans','Gill Sans MT',Calibri,sans-serif",
    futura: "Futura,'Century Gothic','Trebuchet MS',sans-serif",
    georgia: 'Georgia,serif',
    'times new roman': "'Times New Roman',Times,serif",
    'palatino linotype': "'Palatino Linotype',Palatino,'Book Antiqua',serif",
    baskerville: "Baskerville,'Baskerville Old Face',Georgia,serif",
    'courier new': "'Courier New',Courier,monospace",
    menlo: "Menlo,Monaco,Consolas,'DejaVu Sans Mono',monospace",
    impact: "Impact,'Arial Narrow',sans-serif",
    'marker felt': "'Marker Felt','Segoe Print','Comic Sans MS',cursive",
    'bradley hand': "'Bradley Hand','Segoe Script','Comic Sans MS',cursive",
    'snell roundhand': "'Snell Roundhand','Brush Script MT','Lucida Handwriting',cursive",
    kalam: 'Kalam,cursive'
};

// Éléments acceptés (les autres sont retirés, leur texte est gardé) et ce qu'ils deviennent.
const NOTE_TAGS = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's', span: 'span', font: 'span',
    div: 'div', p: 'div', br: 'br', ul: 'ul', ol: 'ol', li: 'li' };
// Tailles écrites en mots (produites par certains navigateurs) et tailles 1 à 7 de l'ancienne balise <font>, en pixels.
const NOTE_FONT_WORDS = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
const NOTE_FONT_SIZES = [10, 13, 16, 18, 24, 32, 48];

function decodeNoteEntities(t) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return t.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (all, dec, hex, name) => {
        if (name) return Object.prototype.hasOwnProperty.call(named, name.toLowerCase()) ? named[name.toLowerCase()] : all;
        const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
        const ok = cp === 9 || cp === 10 || (cp >= 32 && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) && !(cp >= 0x7F && cp <= 0x9F));
        return ok ? String.fromCodePoint(cp) : all;
    });
}

// Couleur CSS : #rgb, #rrggbb ou rgb()/rgba() opaque → « #rrggbb » ; sinon null.
function noteColor(v) {
    v = String(v || '').trim().toLowerCase();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
    if (m) return '#' + (m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1]);
    m = /^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(v);
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    if (alpha !== 1) return null;
    const c = [m[1], m[2], m[3]].map(Number);
    if (c.some(n => n > 255)) return null;
    return '#' + c.map(n => n.toString(16).padStart(2, '0')).join('');
}

// Style CSS réduit à ce que propose la barre de mise en forme (couleur, surlignage, taille, gras, italique, souligné, barré, alignement).
function noteStyle(styleText) {
    const got = new Map();
    String(styleText || '').split(';').forEach(decl => {
        const i = decl.indexOf(':');
        if (i < 0) return;
        const prop = decl.slice(0, i).trim().toLowerCase();
        const val = decl.slice(i + 1).trim().toLowerCase();
        if (prop === 'color') { const c = noteColor(val); if (c) got.set('color', c); }
        else if (prop === 'background-color' || prop === 'background') {
            if (val === 'transparent') got.set('background-color', 'transparent');
            else { const c = noteColor(val); if (c) got.set('background-color', c); }
        } else if (prop === 'font-size') {
            let px = null;
            const m = /^(\d{1,3}(?:\.\d+)?)px$/.exec(val);
            if (m) px = Math.round(parseFloat(m[1])); else if (NOTE_FONT_WORDS[val]) px = NOTE_FONT_WORDS[val];
            if (px) got.set('font-size', Math.max(8, Math.min(96, px)) + 'px');
        } else if (prop === 'font-family') {
            const first = val.split(',')[0].trim().replace(/^["']|["']$/g, '').trim();
            if (Object.prototype.hasOwnProperty.call(NOTE_FONTS, first)) got.set('font-family', NOTE_FONTS[first]);
        } else if (prop === 'font-weight') {
            if (/^(bold|bolder|[6-9]00)$/.test(val)) got.set('font-weight', 'bold'); else if (/^(normal|lighter|[1-5]00)$/.test(val)) got.set('font-weight', 'normal');
        } else if (prop === 'font-style') {
            if (val === 'italic' || val === 'oblique') got.set('font-style', 'italic'); else if (val === 'normal') got.set('font-style', 'normal');
        } else if (prop === 'text-decoration' || prop === 'text-decoration-line') {
            const t = val.split(/\s+/);
            const parts = ['underline', 'line-through'].filter(k => t.includes(k));
            if (parts.length) got.set('text-decoration', parts.join(' ')); else if (t.includes('none')) got.set('text-decoration', 'none');
        } else if (prop === 'text-align') {
            if (/^(left|center|right|justify)$/.test(val)) got.set('text-align', val);
        }
    });
    return [...got].map(([k, v]) => `${k}:${v}`).join(';');
}

// Nettoie une annotation mise en forme : on ne garde que les éléments et styles ci-dessus, tout le texte est échappé
// (rien de ce qui vient d'un fichier importé ne peut exécuter de code). Le texte est limité à maxText signes.
// Renvoie '' si l'annotation ne contient aucun texte visible. Un texte simple (anciennes annotations) reste tel quel.
function sanitizeNoteHtml(raw, maxText = MEASURE_NOTE_MAX) {
    if (typeof raw !== 'string' || !raw) return '';
    const src = raw.replace(/\r\n?/g, '\n').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let out = '', pos = 0, left = maxText, count = 0, hasText = false, m, skip = 0, staves = 0, frames = 0, chordBlocks = 0, drawBlocks = 0;
    const stack = [];
    const addText = (chunk) => {
        if (!chunk || left <= 0) return;
        let t = decodeNoteEntities(chunk);
        if (t.length > left) t = t.slice(0, left);
        left -= t.length;
        if (/[^\s ]/.test(t)) hasText = true;
        out += t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    // Place d'un bloc : « data-at » (place sur le canevas de la zone) ou, pour une annotation écrite avant les canevas, l'ancien décalage « data-pos »
    // (relatif à la place dans le texte : le navigateur s'en sert une fois pour reconstruire la mise en page, voir index.html, _annotMigrate) ;
    // « data-border="0" » = cadre caché.
    const blockPlace = (a) => {
        const at = GF_STAFF.formatBlockAt(GF_STAFF.parseBlockAt(a['data-at'] || ''));
        const pos = at ? '' : GF_STAFF.formatStaffPos(GF_STAFF.parseStaffPos(a['data-pos'] || ''));
        const hidden = a['data-border'] !== undefined && !GF_STAFF.parseBlockBorder(a['data-border']);
        return (at ? ` data-at="${at}"` : (pos ? ` data-pos="${pos}"` : '')) + (hidden ? ' data-border="0"' : '');
    };
    const readAttrs = (raw) => {
        const attrs = {};
        raw.replace(/([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g, (all, k, a, b, c) => { attrs[k.toLowerCase()] = decodeNoteEntities(a !== undefined ? a : (b !== undefined ? b : c)); return all; });
        return attrs;
    };
    while ((m = re.exec(src))) {
        if (!skip) addText(src.slice(pos, m.index));
        pos = re.lastIndex;
        const closing = m[1] === '/';
        const name = m[2].toLowerCase();
        // Contenu d'une portée (dessin, boutons…) : jeté, la portée est reconstruite à partir de son seul texte « data-staff ».
        if (skip) { if (name === 'div') skip += closing ? -1 : 1; continue; }
        // Cadre de dessin : reconstruit à partir de son seul texte « data-draw » (taille et traits).
        if (!closing && name === 'div' && /\bdata-draw\s*=/i.test(m[3])) {
            skip = 1;
            const da = readAttrs(m[3]);
            const text = GF_DRAW.drawCanon(da['data-draw'] || '');
            if (text && drawBlocks < NOTE_MAX_DRAWS && count < 400 && !stack.some(e => e.kind === 'frame')) {
                out += `<div class="annot-draw" data-draw="${text}"${blockPlace(da)}></div>`;
                drawBlocks++; count++; hasText = true;
            }
            continue;
        }
        // Bloc d'accords : reconstruit à partir de son seul texte « data-chords » (accords, durées, lecture).
        if (!closing && name === 'div' && /\bdata-chords\s*=/i.test(m[3])) {
            skip = 1;
            const ca = readAttrs(m[3]);
            const text = GF_CHORDS.chordsCanon(ca['data-chords'] || '');
            if (text && chordBlocks < NOTE_MAX_CHORDS && count < 400 && !stack.some(e => e.kind === 'frame')) {
                out += `<div class="annot-chords" data-chords="${text}"${blockPlace(ca)}></div>`;
                chordBlocks++; count++; hasText = true;
            }
            continue;
        }
        if (!closing && name === 'div' && /\bdata-staff\s*=/i.test(m[3])) {
            skip = 1;
            const sa = readAttrs(m[3]);
            const text = GF_STAFF.parseStaff(sa['data-staff'] || '');
            if (text && staves < NOTE_MAX_STAVES && count < 400 && !stack.some(e => e.kind === 'frame')) {
                out += `<div class="annot-staff" data-staff="${GF_STAFF.formatStaff(text)}"${blockPlace(sa)}></div>`;
                staves++; count++; hasText = true;
            }
            continue;
        }
        // Cadre de texte : un <div data-frame="…"> dont le contenu (texte mis en forme) est nettoyé comme le reste. Un cadre invalide, ou placé
        // dans un autre cadre, devient un simple bloc de texte.
        if (!closing && name === 'div' && /\bdata-frame\s*=/i.test(m[3]) && frames < NOTE_MAX_FRAMES && count < 400 && stack.length < 16 && !stack.some(e => e.kind === 'frame')) {
            const fa = readAttrs(m[3]);
            const box = GF_STAFF.parseFrameBox(fa['data-frame'] || '');
            if (box) {
                out += `<div class="annot-frame" data-frame="${GF_STAFF.formatFrameBox(box)}"${blockPlace(fa)}>`;
                stack.push({ kind: 'frame', emitted: true });
                frames++; count++; hasText = true;
                continue;
            }
        }
        const kind = NOTE_TAGS[name];
        if (!kind) continue;
        if (kind === 'br') { if (!closing && count < 400) { out += '<br>'; count++; } continue; }
        if (closing) {
            let k = stack.length - 1;
            while (k >= 0 && stack[k].kind !== kind && !(kind === 'div' && stack[k].kind === 'frame')) k--; // un </div> ferme aussi un cadre
            if (k < 0) continue;
            while (stack.length > k) { const e = stack.pop(); if (e.emitted) out += `</${e.kind === 'frame' ? 'div' : e.kind}>`; }
            continue;
        }
        let style = '';
        if (kind !== 'b' && kind !== 'i' && kind !== 'u' && kind !== 's') {
            const attrs = readAttrs(m[3]);
            let css = attrs.style || '';
            if (name === 'font') {
                if (attrs.color) css += `;color:${attrs.color}`;
                if (attrs.face) css += `;font-family:${String(attrs.face).replace(/;/g, '')}`;
                const sz = parseInt(attrs.size, 10);
                if (sz >= 1 && sz <= 7) css += `;font-size:${NOTE_FONT_SIZES[sz - 1]}px`;
            }
            style = noteStyle(css);
        }
        const emit = count < 400 && stack.length < 16 && (kind !== 'span' || !!style);
        if (emit) { out += `<${kind}${style ? ` style="${style}"` : ''}>`; count++; }
        stack.push({ kind, emitted: emit });
    }
    if (!skip) addText(src.slice(pos));
    while (stack.length) { const e = stack.pop(); if (e.emitted) out += `</${e.kind === 'frame' ? 'div' : e.kind}>`; }
    if (!hasText) return '';
    // éléments vides, retours à la ligne et espaces de fin (le navigateur en laisse toujours un en fin de champ)
    let prev;
    do {
        prev = out;
        out = out.replace(/<(span|b|i|u|s|div|li)(?: style="[^"]*")?><\/\1>/g, '')
            .replace(/<div(?: style="[^"]*")?>(?:<br>|\s| )*<\/div>$/, '')
            .replace(/(?:<br>|\s| )+$/, '');
    } while (out !== prev);
    return out;
}

// ===== Le document : un carnet = un titre, des pages (chacune un canevas de blocs) et des réglages de lecture =====
const CARNET_FORMAT = 'carnet-de-notes';
const CARNET_VERSION = 1;
const CARNET_MAX_PAGES = 40;
const CARNET_TITLE_MAX = 60;
const CARNET_PAGE_NAME_MAX = 40;
const CARNET_BPM_MIN = 30, CARNET_BPM_MAX = 300, CARNET_BPM_DEFAULT = 100; // mêmes bornes que SN_BPM_MIN / SN_BPM_MAX (ui/staff-notes.js)
const CARNET_SWING_MIN = 50, CARNET_SWING_MAX = 75; // swing de lecture en % : 50 = croches droites, 67 = triolet
const CARNET_INSTRUMENTS = ['C', 'Bb', 'Eb'];        // instrument transpositeur : la hauteur écrite est transposée à la lecture
const CARNET_TRANSPOSE = { C: 0, Bb: -2, Eb: -9 };   // décalage en demi-tons appliqué à la lecture (mêmes valeurs que Chord Scales)

// Texte court sans caractère de contrôle, coupé à max signes ; '' si ce n'est pas un texte.
function carnetCleanText(v, max) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function defaultCarnetSettings() { return { bpm: CARNET_BPM_DEFAULT, swing: CARNET_SWING_MIN, instrument: 'C' }; }

// Réglages de lecture : tempo (noires par minute), swing (%), instrument. Toute valeur absente ou hors limites revient à la valeur par défaut.
function sanitizeCarnetSettings(raw) {
    const d = defaultCarnetSettings();
    if (!raw || typeof raw !== 'object') return d;
    const bpm = Math.round(Number(raw.bpm)), swing = Math.round(Number(raw.swing));
    return {
        bpm: Number.isFinite(bpm) && bpm >= CARNET_BPM_MIN && bpm <= CARNET_BPM_MAX ? bpm : d.bpm,
        swing: Number.isFinite(swing) && swing >= CARNET_SWING_MIN && swing <= CARNET_SWING_MAX ? swing : d.swing,
        instrument: CARNET_INSTRUMENTS.includes(raw.instrument) ? raw.instrument : d.instrument
    };
}

function carnetPageName(raw, index) {
    return carnetCleanText(raw, CARNET_PAGE_NAME_MAX) || `Page ${index + 1}`;
}

function sanitizeCarnetPage(raw, index) {
    const p = raw && typeof raw === 'object' ? raw : {};
    return { name: carnetPageName(p.name, index), html: sanitizeNoteHtml(typeof p.html === 'string' ? p.html : '', PAGE_NOTE_MAX) };
}

function newCarnet() {
    return { title: '', pages: [{ name: 'Page 1', html: '' }], current: 0, settings: defaultCarnetSettings() };
}

// Lit un carnet venant de l'extérieur (fichier .json importé ou sauvegarde du navigateur). Renvoie null si ce n'est pas un carnet.
// Accepte l'objet exporté ({ format, version, title, pages, settings }) comme l'entrée gardée dans le navigateur.
function sanitizeCarnet(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.format !== undefined && raw.format !== CARNET_FORMAT) return null;
    if (!Array.isArray(raw.pages) || raw.pages.length === 0) return null;
    const pages = raw.pages.slice(0, CARNET_MAX_PAGES).map(sanitizeCarnetPage);
    const cur = Math.round(Number(raw.current));
    return {
        title: carnetCleanText(raw.title, CARNET_TITLE_MAX),
        pages,
        current: Number.isFinite(cur) && cur >= 0 && cur < pages.length ? cur : 0,
        settings: sanitizeCarnetSettings(raw.settings)
    };
}

// Ce qui est écrit dans un fichier exporté ou dans la sauvegarde du navigateur (la page affichée n'en fait pas partie : un fichier s'ouvre sur sa 1re page).
function carnetToFile(carnet) {
    return {
        format: CARNET_FORMAT,
        version: CARNET_VERSION,
        title: carnet.title || '',
        settings: Object.assign({}, carnet.settings),
        pages: carnet.pages.map(p => ({ name: p.name, html: p.html }))
    };
}

// Empreinte du contenu (sans la page affichée) : sert à savoir si le carnet a changé depuis sa dernière sauvegarde.
function carnetSignature(carnet) {
    try { return JSON.stringify(carnetToFile(carnet)); } catch (e) { return ''; }
}

// Un carnet vide : une seule page, sans bloc, sans titre.
function carnetIsEmpty(carnet) {
    return !carnet.title && carnet.pages.length <= 1 && carnet.pages.every(p => !p.html);
}

// Nom pour une nouvelle page : « Page N » avec le plus petit N libre.
function nextPageName(pages) {
    const used = new Set(pages.map(p => p.name));
    for (let n = pages.length + 1; n < pages.length + 1000; n++) if (!used.has(`Page ${n}`)) return `Page ${n}`;
    return `Page ${pages.length + 1}`;
}

// Nom de fichier sûr tiré du titre (« Mon carnet » → « Mon-carnet »).
function carnetFileName(title) {
    const base = String(title || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim().replace(/\s+/g, '-').slice(0, 60);
    return (base || 'carnet') + '.json';
}

// Une grille exportée par Chord Scales (.json, format « chord-scales-jam-grid ») devient un carnet : une page « Grille » pour l'annotation générale
// (champ `notes`), puis une page par annotation de mesure (« Mesure 5 », ou « Mesures 5–8 » si elle dure plusieurs mesures). Le titre est le nom de la grille,
// le tempo est repris s'il est valide. Renvoie null si le fichier n'est pas une grille de Chord Scales ou ne porte aucune annotation.
function carnetFromChordScales(raw) {
    if (!raw || typeof raw !== 'object' || raw.format !== 'chord-scales-jam-grid' || !Array.isArray(raw.grid)) return null;
    const pages = [];
    const general = typeof raw.notes === 'string' ? sanitizeNoteHtml(raw.notes, PAGE_NOTE_MAX) : '';
    if (general) pages.push({ name: 'Grille', html: general });
    let measure = 1;
    for (const item of raw.grid.slice(0, 64)) {
        if (!item || typeof item !== 'object') continue;
        const len = Number.isInteger(item.measures) && item.measures >= 1 && item.measures <= 16 ? item.measures : 1;
        const note = typeof item.note === 'string' ? sanitizeNoteHtml(item.note, PAGE_NOTE_MAX) : '';
        if (note && pages.length < CARNET_MAX_PAGES) {
            const span = Number.isInteger(item.noteSpan) && item.noteSpan > len && item.noteSpan <= 64 ? item.noteSpan : len;
            pages.push({ name: span > 1 ? `Mesures ${measure}–${measure + span - 1}` : `Mesure ${measure}`, html: note });
        }
        measure += len;
    }
    if (!pages.length) return null;
    const settings = sanitizeCarnetSettings({ bpm: raw.bpm });
    return { title: carnetCleanText(raw.name, CARNET_TITLE_MAX), pages, current: 0, settings };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PAGE_NOTE_MAX, NOTE_MAX_STAVES, NOTE_MAX_FRAMES, NOTE_MAX_CHORDS, NOTE_MAX_DRAWS, NOTE_FONTS, sanitizeNoteHtml,
        CARNET_FORMAT, CARNET_VERSION, CARNET_MAX_PAGES, CARNET_TITLE_MAX, CARNET_PAGE_NAME_MAX, CARNET_BPM_MIN, CARNET_BPM_MAX, CARNET_BPM_DEFAULT,
        CARNET_SWING_MIN, CARNET_SWING_MAX, CARNET_INSTRUMENTS, CARNET_TRANSPOSE,
        carnetCleanText, defaultCarnetSettings, sanitizeCarnetSettings, sanitizeCarnetPage, newCarnet, sanitizeCarnet, carnetToFile,
        carnetSignature, carnetIsEmpty, nextPageName, carnetFileName, carnetFromChordScales };
}
