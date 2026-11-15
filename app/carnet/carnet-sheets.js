// carnet/carnet-sheets.js — le Carnet en « mode page » : des feuilles de papier (A4, A3, A5, Letter ; portrait ou paysage) posées l'une sous l'autre.
// Fonctions pures, sans DOM : formats, saut de page, rangement d'un bloc sur une feuille, zoom relatif à la largeur de la feuille, fond dessiné.
// Chargé par index.html via <script src="app/carnet/carnet-sheets.js"> et testé par carnet-sheets.test.js.
//
// Le canevas est mesuré en pixels « logiques » : ceux d'une feuille à 96 points par pouce (A4 portrait : 794 × 1123). Les places des blocs (data-at)
// sont celles du canevas. La feuille k occupe y ∈ [k·(h + SHEET_GAP), k·(h + SHEET_GAP) + h] ; entre deux feuilles, SHEET_GAP pixels de « table ».
// À l'écran, le canevas est agrandi d'un facteur s = (largeur de la zone / largeur de la feuille) × zoom : à 100 %, la feuille remplit la largeur de la zone.

const SHEET_PAPERS = {
    A4: { label: 'A4', mm: [210, 297] },
    A3: { label: 'A3', mm: [297, 420] },
    A5: { label: 'A5', mm: [148, 210] },
    Letter: { label: 'Letter', mm: [215.9, 279.4] }
};
const SHEET_PAPER_KEYS = ['A4', 'A3', 'A5', 'Letter'];
const SHEET_ORIENTS = ['portrait', 'landscape'];
const SHEET_PAPER_DEFAULT = 'A4';
const SHEET_ORIENT_DEFAULT = 'portrait';
const SHEET_GAP = 24;       // espace entre deux feuilles (pixels du canevas)
const SHEET_MARGIN = 38;    // marge d'impression conseillée, environ 10 mm (pixels du canevas) : les portées se mettent en page à l'intérieur
const SHEETS_MAX = 10;      // nombre maximal de feuilles d'une page du carnet
const SHEET_ZOOM_MAX = 3;
const SHEET_ZOOM_FLOOR = 0.1;
const SHEET_ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];
const SHEET_PX_PER_MM = 96 / 25.4;

// Papier et orientation valides (sinon A4 portrait).
function sheetPaper(p) { return SHEET_PAPER_KEYS.includes(p) ? p : SHEET_PAPER_DEFAULT; }
function sheetOrient(o) { return SHEET_ORIENTS.includes(o) ? o : SHEET_ORIENT_DEFAULT; }

// Taille d'une feuille, en pixels du canevas.
function sheetSize(paper, orient) {
    const [a, b] = SHEET_PAPERS[sheetPaper(paper)].mm;
    const w = Math.round(a * SHEET_PX_PER_MM), h = Math.round(b * SHEET_PX_PER_MM);
    return sheetOrient(orient) === 'landscape' ? { w: h, h: w } : { w, h };
}

const sheetPitch = (size) => size.h + SHEET_GAP;
const sheetTop = (k, size) => k * sheetPitch(size);
// Hauteur totale de n feuilles (sans espace après la dernière).
const sheetsHeight = (n, size) => Math.max(1, n) * sheetPitch(size) - SHEET_GAP;
// Bord bas du canevas : celui de la dernière feuille permise.
const sheetsBottom = (size) => sheetsHeight(SHEETS_MAX, size);

// Feuille contenant la hauteur y (l'espace qui suit une feuille compte pour elle).
function sheetOfY(y, size) {
    const k = Math.floor((Number(y) || 0) / sheetPitch(size));
    return Math.max(0, Math.min(SHEETS_MAX - 1, k));
}

// Surface du rectangle r qui tombe sur la feuille k.
function sheetOverlap(r, k, size) {
    const top = sheetTop(k, size);
    const w = Math.min(r.x + r.w, size.w) - Math.max(r.x, 0);
    const h = Math.min(r.y + r.h, top + size.h) - Math.max(r.y, top);
    return w > 0 && h > 0 ? w * h : 0;
}

// Feuille « d'un bloc » : celle qu'il recouvre le plus ; à défaut (bloc hors feuille), celle de son centre.
function sheetOfRect(r, size) {
    let best = -1, bestA = 0;
    const k0 = sheetOfY(r.y, size), k1 = sheetOfY(r.y + Math.max(0, r.h - 1), size);
    for (let k = k0; k <= k1; k++) {
        const a = sheetOverlap(r, k, size);
        if (a > bestA) { bestA = a; best = k; }
    }
    return best >= 0 ? best : sheetOfY(r.y + r.h / 2, size);
}

// Le bloc tient-il entièrement sur une feuille (ni à cheval sur deux feuilles, ni dans l'espace entre elles, ni au-delà du bord droit) ?
function sheetFits(r, size) {
    if (r.x < 0 || r.x + r.w > size.w) return false;
    const k = sheetOfY(r.y, size), top = sheetTop(k, size);
    return r.y >= top && r.y + r.h <= top + size.h;
}

// Le bloc déborde-t-il du bord droit, d'au moins la moitié de sa largeur (donc affiché « hors feuille ») ?
function sheetOffside(r, size) { return r.x + r.w / 2 > size.w; }

// Range un groupe de rectangles sur une feuille : le groupe entier est poussé (même décalage pour tous, la disposition relative est gardée) sur la
// feuille qu'il recouvre le plus, au plus près de là où il est. Un groupe plus grand qu'une feuille est rangé bloc par bloc.
// Renvoie les nouvelles places [{ x, y }] dans l'ordre des rectangles.
function sheetFitGroup(rects, size) {
    if (!rects.length) return [];
    const x0 = Math.min(...rects.map(r => r.x)), y0 = Math.min(...rects.map(r => r.y));
    const x1 = Math.max(...rects.map(r => r.x + r.w)), y1 = Math.max(...rects.map(r => r.y + r.h));
    const b = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (rects.length > 1 && (b.w > size.w || b.h > size.h)) return rects.map(r => sheetFitGroup([r], size)[0]);
    const k = sheetOfRect(b, size), top = sheetTop(k, size);
    const nx = Math.max(0, Math.min(b.x, size.w - b.w)), ny = Math.max(top, Math.min(b.y, top + size.h - b.h));
    return rects.map(r => ({ x: Math.round(r.x + nx - b.x), y: Math.round(r.y + ny - b.y) }));
}

// Nombre de feuilles à afficher : celles qui portent un bloc, plus une feuille vide pour continuer vers le bas.
function sheetCount(rects, size) {
    let last = 0;
    for (const r of rects) last = Math.max(last, sheetOfY(r.y + Math.max(0, r.h - 1), size));
    return Math.max(1, Math.min(SHEETS_MAX, last + 2));
}

// Espaces entre feuilles (0 : entre les feuilles 0 et 1…) que des blocs chevauchent : la « ligne de coupure » passe alors au rouge.
function sheetBrokenGaps(rects, size) {
    const out = [];
    for (let k = 0; k < SHEETS_MAX - 1; k++) {
        const gs = sheetTop(k, size) + size.h, ge = gs + SHEET_GAP;
        if (rects.some(r => r.y < ge && r.y + r.h > gs)) out.push(k);
    }
    return out;
}

// ----- Zoom -----

// Échelle d'affichage à 100 % : la feuille remplit la largeur de la zone.
function sheetFitScale(clientWidth, size) { return Math.max(0.01, clientWidth) / size.w; }

// Zoom minimal (relatif à la largeur) : celui qui montre la hauteur d'une feuille entière dans la zone (au plus 100 %).
function sheetMinZoom(clientWidth, clientHeight, size, pad = 24) {
    const fit = sheetFitScale(clientWidth, size);
    const u = ((Math.max(0, clientHeight) - pad) / size.h) / fit;
    return Math.floor(Math.max(SHEET_ZOOM_FLOOR, Math.min(1, u)) * 100 + 1e-9) / 100; // arrondi vers le bas : la feuille tient toujours en hauteur
}

function sheetClampZoom(z, min = SHEET_ZOOM_FLOOR) {
    const v = Number(z);
    if (!isFinite(v) || v <= 0) return 1;
    return Math.round(Math.min(SHEET_ZOOM_MAX, Math.max(min, v)) * 100) / 100;
}

// Cran suivant (dir > 0) ou précédent (dir < 0) ; le plus petit cran est le zoom minimal de la zone.
function sheetZoomStep(z, dir, min = SHEET_ZOOM_FLOOR) {
    const v = sheetClampZoom(z, min), eps = 0.005;
    const steps = [min].concat(SHEET_ZOOM_STEPS.filter(s => s > min + 0.02));
    if (dir > 0) { const n = steps.find(s => s > v + eps); return n === undefined ? SHEET_ZOOM_MAX : n; }
    const prev = steps.filter(s => s < v - eps);
    return prev.length ? prev[prev.length - 1] : min;
}

// Décalage de la feuille quand elle est plus étroite que la zone (elle est centrée).
function sheetOffsetX(clientWidth, size, scale) { return Math.max(0, Math.floor((clientWidth - size.w * scale) / 2)); }

// ----- Fond de la zone : les feuilles sont dessinées en CSS (background multiple), sans élément dans la zone -----

// Renvoie { image, size, position, repeat, attachment, height, width } à poser sur la zone. s : échelle d'affichage ; ox : décalage ; n : nombre de feuilles ;
// broken : espaces à teinter en rouge ; margin : si > 0, un liseré discret marque la zone imprimable (à `margin` pixels du bord de chaque feuille).
function sheetBackground(size, s, ox, n, broken = [], margin = 0) {
    const px = (v) => `${Math.round(v * 100) / 100}px`;
    const layers = [];
    const solid = (c) => `linear-gradient(${c}, ${c})`;
    for (const k of broken) if (k >= 0 && k < n - 1) layers.push({ img: solid('rgba(239, 68, 68, .75)'), w: size.w * s, h: SHEET_GAP * s, x: ox, y: (sheetTop(k, size) + size.h) * s });
    if (margin > 0 && size.w > 2 * margin && size.h > 2 * margin) {
        const g = solid('rgba(100, 116, 139, .35)'), iw = (size.w - 2 * margin) * s, ih = (size.h - 2 * margin) * s;
        for (let k = 0; k < n; k++) {
            const x = ox + margin * s, y = (sheetTop(k, size) + margin) * s;
            layers.push({ img: g, w: iw, h: 1, x, y }, { img: g, w: iw, h: 1, x, y: y + ih - 1 }, { img: g, w: 1, h: ih, x, y }, { img: g, w: 1, h: ih, x: x + iw - 1, y });
        }
    }
    for (let k = 0; k < n; k++) layers.push({ img: solid('#fff'), w: size.w * s, h: size.h * s, x: ox, y: sheetTop(k, size) * s });
    for (let k = 0; k < n; k++) layers.push({ img: solid('#8d99ab'), w: size.w * s + 2, h: size.h * s + 2, x: ox - 1, y: sheetTop(k, size) * s - 1 });
    return {
        image: layers.map(l => l.img).join(', '),
        size: layers.map(l => `${px(l.w)} ${px(l.h)}`).join(', '),
        position: layers.map(l => `${px(l.x)} ${px(l.y)}`).join(', '),
        repeat: layers.map(() => 'no-repeat').join(', '),
        attachment: layers.map(() => 'local').join(', '),
        height: Math.ceil(sheetsHeight(n, size) * s),
        width: Math.ceil(size.w * s + ox)
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SHEET_PAPERS, SHEET_PAPER_KEYS, SHEET_ORIENTS, SHEET_PAPER_DEFAULT, SHEET_ORIENT_DEFAULT, SHEET_GAP, SHEET_MARGIN, SHEETS_MAX, SHEET_ZOOM_MAX, SHEET_ZOOM_FLOOR, SHEET_ZOOM_STEPS,
        sheetPaper, sheetOrient, sheetSize, sheetPitch, sheetTop, sheetsHeight, sheetsBottom, sheetOfY, sheetOverlap, sheetOfRect, sheetFits, sheetOffside, sheetFitGroup, sheetCount, sheetBrokenGaps,
        sheetFitScale, sheetMinZoom, sheetClampZoom, sheetZoomStep, sheetOffsetX, sheetBackground };
}
