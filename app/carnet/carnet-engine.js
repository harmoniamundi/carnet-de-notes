// carnet/carnet-engine.js — le moteur de l'appli « Carnet de notes » : la colle entre l'écran (index.html) et les modules.
// Un carnet = un titre, des pages (chacune un canevas où l'on pose des cadres de texte et des portées) et des réglages de lecture
// (tempo, swing, instrument transpositeur). Ce fichier réunit :
//   - le document : pages (ajout, nom, copie, ordre, suppression), titre, réglages, annulation / rétablissement (carnet-history.js) ;
//   - la sauvegarde : carnets nommés gardés dans le navigateur, brouillon automatique, export / import d'un fichier .json ;
//   - la synchro entre appareils (carnet-sync.js) : les carnets sauvegardés sont copiés dans un dépôt GitHub privé ;
//   - le son : le piano lit les portées ;
//   - le module d'annotation de Chord Scales (zone-canevas, barre de mise en forme, cadres, portées, presse-papiers, zoom, mode édition),
//     repris de son moteur (index.html, JamEngine « Onglet Annotations ») et branché sur une seule zone : la page affichée.
// La logique qui se calcule sans écran est dans des modules testés : carnet-format.js (nettoyage, document), carnet-history.js, ui/*.js.
// Chargé par index.html en dernier (après ui/annot-bar.js) ; l'instance globale s'appelle `app`.

const CN_KEYS = { saved: 'carnetSaved', draft: 'carnetDraft', zoom: 'carnetZoom', magnet: 'carnetMagnet' };
const CN_HISTORY_LIMIT = 200;

function cnStore(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function cnStoreSet(key, value) { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } }
function cnEsc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

class CarnetApp {
    constructor() {
        this.doc = newCarnet();
        this.name = null;                       // nom de la sauvegarde que ce carnet est en train de modifier (null : pas encore sauvegardé)
        this.history = new CarnetHistory(CN_HISTORY_LIMIT);
        this.zone = null;                       // la zone d'annotation (canevas de la page affichée)
        this._zonePage = 0;                     // indice de la page que la zone affiche : c'est elle que _annotCommit enregistre
        this.annotEdit = { page: false };       // mode édition (crayon à côté du titre de la page) ; hors édition, les blocs sont figés et la page se lit
        this.annotMagnet = cnStore(CN_KEYS.magnet) === '1'; // aimant entre blocs
        this.annotZoom = { page: 1 };           // zoom de lecture, gardé d'une visite à l'autre
        try {
            const z = JSON.parse(cnStore(CN_KEYS.zoom) || '{}');
            if (z && Number.isFinite(z.page)) this.annotZoom.page = acClampZoom(z.page);
        } catch (e) {}
        this._saved = null;                     // cache des carnets sauvegardés (voir getSaved)
        this.sync = new CarnetSync({            // synchro entre appareils (dépôt GitHub privé) : voir « Synchro » plus bas
            fetch: (url, init) => fetch(url, init),
            storage: { getItem: cnStore, setItem: (k, v) => { if (!cnStoreSet(k, v)) throw new Error('stockage'); }, removeItem: (k) => { try { localStorage.removeItem(k); } catch (e) {} } },
            getSaved: () => this.getSaved(),
            setSaved: (obj) => this._storeSaved(obj)
        });
        this._syncBusy = false; this._syncAgain = false; this._syncT = null; this._syncModal = null;
        this.audioCtx = null;
        this.pianoInstrument = null;
        this.reverbInput = null;
        this._pianoPromise = null;
    }

    // ===== Démarrage =====
    init() {
        this._buildStage();
        this._bindChrome();
        const restored = this._restoreDraft();
        if (!restored) this.annotEdit.page = true; // carnet neuf : on peut écrire tout de suite
        this.renderAll();
        this.refreshSyncButton();
        this._syncSoon(300);
        const wake = () => { if (!this.pianoInstrument) this.loadPiano(); window.removeEventListener('click', wake); window.removeEventListener('keydown', wake); };
        window.addEventListener('click', wake);
        window.addEventListener('keydown', wake);
    }

    // La barre de mise en forme (cachée tant qu'on n'édite pas) et la zone de la page.
    _buildStage() {
        const stage = document.getElementById('cn-stage');
        const handlers = `tabindex="0" onkeydown="app.annotKeydown(event)" onfocus="app.annotFocus(this)"
                    onblur="app.annotBlur(this, event)" oninput="app.annotInput(this)" onpaste="app.annotPaste(event)"
                    oncopy="app.annotCopy(event)" oncut="app.annotCopy(event, true)" ondrop="event.preventDefault()"`;
        stage.innerHTML = `${annotBarHtml()}
            <div class="jam-annot-zone">
                <div class="jam-annot-head"><span class="jam-annot-title" id="cn-page-title"></span>${annotModeHtml('page')}${annotZoomHtml('page')}${annotToolsHtml()}</div>
                <div id="cn-page" class="jam-annot-text" data-editable="false" data-can-edit="true" role="group" spellcheck="false"
                    aria-label="Page du carnet" data-placeholder="" ${handlers}></div>
            </div>`;
        this.zone = stage.querySelector('#cn-page');
        this._annotBindBar(stage.querySelector('#jam-annot-bar'));
        stage.classList.add('jam-annot-barless'); // la barre n'apparaît que pendant l'édition
    }

    // Titre, réglages de lecture, onglets, raccourcis clavier.
    _bindChrome() {
        const $ = (id) => document.getElementById(id);
        const title = $('cn-title');
        title.addEventListener('keydown', (ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter') title.blur();
            else if (ev.key === 'Escape') { title.value = this.doc.title; title.blur(); }
        });
        title.addEventListener('input', () => this.refreshSaveButton());
        title.addEventListener('blur', () => { this.commitTitle(title.value); this.refreshSaveButton(); });
        $('cn-bpm').addEventListener('change', (ev) => this.setSetting('bpm', ev.target.value));
        $('cn-swing').addEventListener('change', (ev) => this.setSetting('swing', ev.target.value));
        $('cn-instr').addEventListener('change', (ev) => this.setSetting('instrument', ev.target.value));
        $('cn-import-file').addEventListener('change', (ev) => this.importFile(ev.target));
        const tabs = $('cn-tabs');
        tabs.addEventListener('click', (ev) => {
            const b = ev.target.closest('[data-act]');
            if (!b || !tabs.contains(b)) return;
            const i = parseInt(b.dataset.i, 10);
            if (b.dataset.act === 'go') this.switchPage(i);
            else if (b.dataset.act === 'add') this.addPage();
            else if (b.dataset.act === 'menu') this._openPageMenu(b, i);
        });
        tabs.addEventListener('dblclick', (ev) => {
            const b = ev.target.closest('.cn-tab-btn');
            if (b) this.startRenamePage(parseInt(b.dataset.i, 10));
        });
        document.addEventListener('keydown', (ev) => { // ⌘S enregistre, même quand on écrit dans un cadre (sinon le navigateur proposerait d'enregistrer la page)
            if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && String(ev.key).toLowerCase() === 's') { ev.preventDefault(); this.saveCurrent(); }
        }, true);
        document.addEventListener('keydown', (ev) => { // ⌘Z / ⌘⇧Z / ⌘Y hors saisie
            const mod = (ev.metaKey || ev.ctrlKey) && !ev.altKey, key = String(ev.key).toLowerCase();
            if (!mod || (key !== 'z' && key !== 'y')) return;
            if (ev.target && ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable="true"]')) return;
            ev.preventDefault();
            if (key === 'y' || ev.shiftKey) this.redo(); else this.undo();
        });
        document.addEventListener('pointerdown', (ev) => {
            const m = this._menu;
            if (m && !m.el.contains(ev.target) && !(m.anchor && m.anchor.contains(ev.target))) this._closeMenu();
        }, true);
        document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && this._menu) this._closeMenu(); });
        window.addEventListener('pagehide', () => { try { this._flush(); } catch (e) {} this._writeDraft(); });
        // Sur tablette et téléphone, passer à une autre appli ne déclenche pas toujours « pagehide » : on valide le texte en cours et on garde le brouillon.
        // Au retour (ou dès que le réseau revient), la synchro cherche ce qui a changé sur les autres appareils.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) { try { this._commitLive(); } catch (e) {} this._writeDraft(); } else this._syncSoon(500);
        });
        window.addEventListener('online', () => this._syncSoon(500));
    }

    // ===== État du document, annulation =====
    _snap() {
        const d = this.doc;
        return JSON.stringify({ t: d.title, p: d.pages.map(x => [x.name, x.html]), c: d.current, s: d.settings, n: this.name });
    }

    _restore(str) {
        const o = JSON.parse(str);
        this.doc = { title: o.t, pages: o.p.map(([name, html]) => ({ name, html })), current: o.c, settings: o.s };
        this.name = o.n;
    }

    // Toute modification du carnet passe par ici : l'état d'avant est gardé pour ↶, le bouton de sauvegarde s'allume, le brouillon suit.
    withUndo(fn) {
        const before = this._snap();
        fn();
        if (this._snap() !== before) this.history.push(before);
        this._changed();
    }

    _changed() {
        this.updateUndoButtons();
        this.refreshSaveButton();
        this._scheduleDraft();
    }

    undo() { this._step(false); }
    redo() { this._step(true); }

    _step(redo) {
        this._closeMenu();
        this._flush(); // le texte en cours de saisie est validé d'abord (il peut former sa propre étape)
        const target = redo ? this.history.redo(this._snap()) : this.history.undo(this._snap());
        if (target === null) { this.updateUndoButtons(); return; }
        this._restore(target);
        this._annotMoveUndo = false; this._annotMoveRedo = false;
        this.renderAll();
        this._scheduleDraft();
    }

    updateUndoButtons() {
        const set = (id, enabled) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.disabled = !enabled;
        };
        set('cn-undo', this.history.canUndo);
        set('cn-redo', this.history.canRedo);
    }

    // Valide ce qui est en cours de saisie dans la page affichée et range la barre.
    _flush() {
        this.annotDeactivate();
        if (this._annotStaffTimer && this.zone) this._annotCommit(this.zone);
    }

    // Texte de la page affichée, validé (nettoyé) : une entrée d'annulation par saisie.
    commitPageNote(html) {
        const page = this.doc.pages[this._zonePage];
        if (!page) return;
        const v = sanitizeNoteHtml(html, PAGE_NOTE_MAX);
        if (v === sanitizeNoteHtml(page.html || '', PAGE_NOTE_MAX)) return;
        this.withUndo(() => { page.html = v; });
    }

    // ===== Affichage =====
    renderAll() {
        this.renderHeader();
        this.renderTabs();
        this._renderPage();
        this.updateUndoButtons();
        this.refreshSaveButton();
    }

    renderHeader() {
        const $ = (id) => document.getElementById(id);
        const t = $('cn-title');
        if (document.activeElement !== t) t.value = this.doc.title;
        const s = this.doc.settings;
        if (document.activeElement !== $('cn-bpm')) $('cn-bpm').value = String(s.bpm);
        $('cn-swing').value = String(this._swingOption(s.swing));
        $('cn-instr').value = s.instrument;
        document.title = this.doc.title ? `${this.doc.title} — Carnet de notes` : 'Carnet de notes';
    }

    // Le menu Swing propose 50 / 58 / 67 / 75 % ; une valeur venue d'un fichier (62 %…) est ajoutée à la liste.
    _swingOption(v) {
        const sel = document.getElementById('cn-swing');
        if (sel && !Array.from(sel.options).some(o => o.value === String(v))) {
            const o = document.createElement('option');
            o.value = String(v); o.textContent = `${v} %`;
            sel.appendChild(o);
        }
        return v;
    }

    setSetting(key, raw) {
        const next = sanitizeCarnetSettings(Object.assign({}, this.doc.settings, { [key]: key === 'instrument' ? raw : Number(raw) }));
        if (JSON.stringify(next) !== JSON.stringify(this.doc.settings)) this.withUndo(() => { this.doc.settings = next; });
        this.renderHeader(); // une valeur refusée (tempo hors limites) revient à la valeur en vigueur
        const bpm = document.getElementById('cn-bpm'); if (bpm) bpm.value = String(this.doc.settings.bpm);
    }

    // Titre du carnet. Si le carnet est une sauvegarde, la sauvegarde est renommée avec lui.
    commitTitle(raw) {
        const title = carnetCleanText(raw, CARNET_TITLE_MAX);
        const old = this.doc.title;
        const inp = document.getElementById('cn-title');
        const revert = () => { if (inp) inp.value = this.doc.title; };
        if (title === old) { revert(); return; }
        const saved = this.getSaved();
        const isSaved = !!(this.name && saved[this.name]);
        if (isSaved) {
            if (!title) { revert(); return; } // un carnet sauvegardé garde un titre
            if (saved[title] && title !== this.name && !confirm(`Un carnet « ${title} » existe déjà dans les sauvegardes : le remplacer ?`)) { revert(); return; }
            const out = {};
            Object.keys(saved).forEach(k => { if (k === this.name) out[title] = saved[k]; else if (k !== title) out[k] = saved[k]; });
            if (!this._storeSaved(out)) { alert('Impossible de renommer la sauvegarde.'); revert(); return; }
        }
        this.withUndo(() => { this.doc.title = title; if (isSaved) this.name = title; });
        this.renderHeader();
    }

    // ===== Pages =====
    renderTabs() {
        const el = document.getElementById('cn-tabs');
        if (!el) return;
        const d = this.doc;
        el.innerHTML = d.pages.map((p, i) => {
            const on = i === d.current;
            return `<div class="cn-tab${on ? ' is-active' : ''}" role="tab" aria-selected="${on}" data-i="${i}">`
                + `<button type="button" class="cn-tab-btn" data-act="go" data-i="${i}" title="${cnEsc(p.name)}${on ? ' (double-clic pour renommer)' : ''}">${cnEsc(p.name)}</button>`
                + (on ? `<button type="button" class="cn-tab-more" data-act="menu" data-i="${i}" aria-haspopup="true" title="Actions de la page" aria-label="Actions de la page">⋯</button>` : '')
                + '</div>';
        }).join('') + (d.pages.length < CARNET_MAX_PAGES
            ? '<button type="button" class="cn-tab-add" data-act="add" title="Ajouter une page" aria-label="Ajouter une page">＋</button>' : '');
        const active = el.querySelector('.cn-tab.is-active');
        if (active && active.scrollIntoView) { try { active.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
    }

    // La zone affiche la page courante : ses blocs sont reconstruits à partir de son texte enregistré.
    _renderPage() {
        const ed = this.zone;
        if (!ed) return;
        ed.querySelectorAll('.annot-staff, .annot-frame, .annot-chords, .annot-draw').forEach((el) => { const v = el.__noteStaff || el.__noteFrame || el.__chordBlock || el.__drawBlock; if (v && v.destroy) { try { v.destroy(); } catch (e) {} } });
        if (ed.__canvas && ed.__canvas.clearSelection) ed.__canvas.clearSelection(true);
        this._zonePage = Math.max(0, Math.min(this.doc.current, this.doc.pages.length - 1));
        const page = this.doc.pages[this._zonePage];
        const html = sanitizeNoteHtml(page.html || '', PAGE_NOTE_MAX);
        ed.innerHTML = html;
        ed.__html = html;
        ed.scrollTop = 0; ed.scrollLeft = 0;
        const t = document.getElementById('cn-page-title');
        if (t) t.textContent = page.name;
        this._annotHydrate(ed);
        this._annotSyncMode();
        this._annotApplyZoom(ed);
    }

    switchPage(i) {
        if (i === this.doc.current || i < 0 || i >= this.doc.pages.length) return;
        this._closeMenu();
        this._flush();
        this.doc.current = i;
        this.renderTabs();
        this._renderPage();
        this._scheduleDraft();
    }

    addPage() {
        if (this.doc.pages.length >= CARNET_MAX_PAGES) return;
        this._closeMenu();
        this._flush();
        this.withUndo(() => {
            this.doc.pages.push({ name: nextPageName(this.doc.pages), html: '' });
            this.doc.current = this.doc.pages.length - 1;
        });
        this.annotEdit.page = true; // page vide : on peut écrire tout de suite
        this.renderTabs();
        this._renderPage();
    }

    startRenamePage(i) {
        const tab = document.querySelector(`#cn-tabs .cn-tab[data-i="${i}"]`);
        const btn = tab && tab.querySelector('.cn-tab-btn');
        if (!btn) return;
        this._closeMenu();
        const inp = document.createElement('input');
        inp.type = 'text'; inp.className = 'cn-tab-input'; inp.maxLength = CARNET_PAGE_NAME_MAX; inp.value = this.doc.pages[i].name;
        inp.setAttribute('aria-label', 'Nom de la page');
        btn.replaceWith(inp);
        inp.focus(); inp.select();
        let done = false;
        const finish = (ok) => { if (done) return; done = true; if (ok) this.renamePage(i, inp.value); else this.renderTabs(); };
        inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); } });
        inp.addEventListener('blur', () => finish(true));
    }

    renamePage(i, raw) {
        const page = this.doc.pages[i];
        if (!page) return;
        const name = carnetPageName(raw, i);
        if (name !== page.name) this.withUndo(() => { page.name = name; });
        this.renderTabs();
        const t = document.getElementById('cn-page-title');
        if (t && i === this._zonePage) t.textContent = this.doc.pages[i].name;
    }

    duplicatePage(i) {
        const src = this.doc.pages[i];
        if (!src || this.doc.pages.length >= CARNET_MAX_PAGES) return;
        this._flush();
        this.withUndo(() => {
            this.doc.pages.splice(i + 1, 0, { name: carnetCleanText(`${src.name} (copie)`, CARNET_PAGE_NAME_MAX), html: src.html });
            this.doc.current = i + 1;
        });
        this.renderTabs();
        this._renderPage();
    }

    movePage(i, dir) {
        const j = i + dir;
        if (i < 0 || j < 0 || j >= this.doc.pages.length) return;
        this._flush();
        this.withUndo(() => {
            const [p] = this.doc.pages.splice(i, 1);
            this.doc.pages.splice(j, 0, p);
            this.doc.current = j;
        });
        this.renderTabs();
        this._renderPage();
    }

    deletePage(i) {
        const page = this.doc.pages[i];
        if (!page) return;
        this._flush();
        const only = this.doc.pages.length === 1;
        const hasContent = !!sanitizeNoteHtml(page.html || '', PAGE_NOTE_MAX);
        if (hasContent && !confirm(only ? `Vider la page « ${page.name} » ?` : `Supprimer la page « ${page.name} » et son contenu ? (↶ la rétablit)`)) return;
        this.withUndo(() => {
            if (only) { page.html = ''; return; }
            this.doc.pages.splice(i, 1);
            this.doc.current = Math.min(i, this.doc.pages.length - 1);
        });
        this.renderTabs();
        this._renderPage();
    }

    // Menu de la page affichée (⋯ à côté de son onglet).
    _openPageMenu(anchor, i) {
        const n = this.doc.pages.length;
        const item = (act, label, disabled) => `<button type="button" class="cn-menu-item" data-act="${act}"${disabled ? ' disabled' : ''}>${label}</button>`;
        this._openMenu(anchor, 'cn-menu-page',
            item('rename', 'Renommer') + item('dup', 'Dupliquer', n >= CARNET_MAX_PAGES)
            + item('left', '← Déplacer vers la gauche', i === 0) + item('right', '→ Déplacer vers la droite', i === n - 1)
            + item('del', n === 1 ? 'Vider la page' : 'Supprimer la page'),
            (act) => {
                if (act === 'rename') this.startRenamePage(i);
                else if (act === 'dup') this.duplicatePage(i);
                else if (act === 'left') this.movePage(i, -1);
                else if (act === 'right') this.movePage(i, 1);
                else if (act === 'del') this.deletePage(i);
            });
    }

    // ===== Menus flottants (pages, carnets sauvegardés) =====
    _openMenu(anchor, cls, html, onAct) {
        if (this._menu && this._menu.anchor === anchor) { this._closeMenu(); return; }
        this._closeMenu();
        const el = document.createElement('div');
        el.className = `cn-menu ${cls}`;
        el.setAttribute('role', 'menu');
        el.innerHTML = html;
        el.addEventListener('mousedown', (ev) => { ev.preventDefault(); });
        el.addEventListener('click', (ev) => {
            const b = ev.target.closest('[data-act]');
            if (!b || b.disabled) return;
            const arg = b.dataset.name !== undefined ? b.dataset.name : undefined;
            this._closeMenu();
            onAct(b.dataset.act, arg);
        });
        document.body.appendChild(el);
        const r = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
        const w = el.offsetWidth, h = el.offsetHeight;
        el.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
        el.style.top = `${(r.bottom + 6 + h > vh - 8 && r.top - 6 - h > 8) ? r.top - 6 - h : r.bottom + 6}px`;
        anchor.classList.add('is-open');
        this._menu = { el, anchor };
    }

    _closeMenu() {
        const m = this._menu;
        if (!m) return;
        this._menu = null;
        if (m.anchor) m.anchor.classList.remove('is-open');
        m.el.remove();
    }

    // ===== Sauvegarde : carnets nommés gardés dans le navigateur, brouillon, fichier .json =====
    getSaved() {
        if (this._saved) return this._saved;
        let o = {};
        try { o = JSON.parse(cnStore(CN_KEYS.saved) || '{}'); } catch (e) {}
        this._saved = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
        return this._saved;
    }

    _storeSaved(obj) {
        if (!cnStoreSet(CN_KEYS.saved, JSON.stringify(obj))) return false;
        this._saved = obj;
        return true;
    }

    // Le carnet affiché est-il identique à sa sauvegarde ?
    _isClean() {
        if (!this.name) return false;
        const e = this.getSaved()[this.name];
        const c = e && sanitizeCarnet(e);
        return !!c && carnetSignature(c) === carnetSignature(this.doc);
    }

    _hasUnsavedWork() { return !this._isClean() && !carnetIsEmpty(this.doc); }

    // Disquette à côté du titre : bleue = modifications non sauvegardées.
    refreshSaveButton() {
        const btn = document.getElementById('cn-save');
        if (!btn) return;
        const inp = document.getElementById('cn-title');
        const typing = !!(inp && document.activeElement === inp);
        const titleChanged = typing && inp.value.trim() !== (this.doc.title || '');
        const dirty = titleChanged || this._hasUnsavedWork();
        btn.classList.toggle('is-dirty', dirty);
        const tip = (dirty ? 'Sauvegarder le carnet (⌘S) — modifications non enregistrées' : (this.name ? `Carnet « ${this.name} » sauvegardé` : 'Sauvegarder le carnet (⌘S)')) + this._syncTip();
        if (btn.title !== tip) { btn.title = tip; btn.setAttribute('aria-label', tip); }
    }

    saveCurrent() {
        const inp = document.getElementById('cn-title');
        if (inp && document.activeElement === inp && inp.value.trim() !== (this.doc.title || '')) this.commitTitle(inp.value);
        this._flush();
        let title = this.doc.title;
        if (!title) {
            const n = carnetCleanText(prompt('Nom du carnet à sauvegarder :', '') || '', CARNET_TITLE_MAX);
            if (!n) return;
            this.withUndo(() => { this.doc.title = n; });
            title = n;
            this.renderHeader();
        }
        const saved = Object.assign({}, this.getSaved());
        if (saved[title] && this.name !== title && !confirm(`Un carnet « ${title} » existe déjà dans les sauvegardes : le remplacer ?`)) return;
        saved[title] = carnetToFile(this.doc);
        if (!this._storeSaved(saved)) { alert("Impossible d'enregistrer le carnet (espace du navigateur plein ?). Exportez-le en fichier .json."); return; }
        this.name = title;
        this.refreshSaveButton();
        this.runSync(false);                      // la sauvegarde locale est faite : la synchro part dans la foulée (si elle est configurée)
        const btn = document.getElementById('cn-save');
        if (btn) {
            btn.classList.add('just-saved'); // coche verte un court instant
            clearTimeout(this._saveFlashT);
            this._saveFlashT = setTimeout(() => btn.classList.remove('just-saved'), 1300);
        }
    }

    // Remplace le carnet affiché (nouveau, sauvegardé ou importé) ; ↶ ramène l'ancien.
    _replaceDoc(doc, name) {
        this._flush();
        this.withUndo(() => { this.doc = doc; this.doc.current = 0; this.name = name; });
        this._annotMoveUndo = false; this._annotMoveRedo = false;
        this.annotEdit.page = carnetIsEmpty(doc);
        this.renderAll();
    }

    _confirmDiscard() {
        this._flush();
        return !this._hasUnsavedWork() || confirm('Le carnet affiché a des modifications non sauvegardées. Continuer ? (↶ permet de les retrouver)');
    }

    newDocument() {
        this._closeMenu();
        if (!this._confirmDiscard()) return;
        this._replaceDoc(newCarnet(), null);
    }

    openSaved(name) {
        const c = sanitizeCarnet(this.getSaved()[name]);
        if (!c) { alert('Ce carnet est illisible.'); return; }
        if (!this._confirmDiscard()) return;
        c.title = name;
        this._replaceDoc(c, name);
    }

    deleteSaved(name) {
        if (!confirm(`Supprimer le carnet sauvegardé « ${name} » ?`)) return;
        const saved = Object.assign({}, this.getSaved());
        delete saved[name];
        if (!this._storeSaved(saved)) { alert('Impossible de supprimer la sauvegarde.'); return; }
        if (this.name === name) this.name = null; // le carnet affiché reste à l'écran, simplement non sauvegardé
        this.refreshSaveButton();
        this.sync.noteDeleted(name);              // suppression voulue : la synchro la répercutera dans le dépôt
        this.runSync(false);
    }

    // Bouton « Ouvrir » : la liste des carnets sauvegardés.
    openSavedMenu(anchor) {
        const saved = this.getSaved();
        const names = Object.keys(saved).sort((a, b) => a.localeCompare(b, 'fr'));
        const rows = names.map(n => `<div class="cn-menu-row"><button type="button" class="cn-menu-item cn-menu-name${n === this.name ? ' is-on' : ''}" data-act="open" data-name="${cnEsc(n)}">${cnEsc(n)}</button>`
            + `<button type="button" class="cn-menu-del" data-act="del" data-name="${cnEsc(n)}" title="Supprimer « ${cnEsc(n)} »" aria-label="Supprimer « ${cnEsc(n)} »">×</button></div>`).join('');
        const syncRow = '<div class="cn-menu-sep"></div><button type="button" class="cn-menu-item" data-act="sync">⚙ Synchronisation entre appareils…</button>';
        this._openMenu(anchor, 'cn-menu-saved', (names.length ? rows : '<div class="cn-menu-empty">Aucun carnet sauvegardé.<br>Donnez un titre au carnet puis cliquez sur la disquette.</div>') + syncRow,
            (act, name) => { if (act === 'open') this.openSaved(name); else if (act === 'sync') this.openSyncPanel(); else if (act === 'del') { this.deleteSaved(name); this.openSavedMenu(anchor); } });
    }

    exportFile() {
        this._flush();
        const blob = new Blob([JSON.stringify(carnetToFile(this.doc), null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = carnetFileName(this.doc.title);
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    importFile(input) {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) { alert('Ce fichier est trop gros pour être un carnet.'); return; }
        const reader = new FileReader();
        reader.onload = () => {
            let raw = null;
            try { raw = JSON.parse(String(reader.result)); } catch (e) {}
            const c = sanitizeCarnet(raw) || carnetFromChordScales(raw);
            if (!c) { alert("Ce fichier n'est pas un carnet valide (.json exporté par Carnet de notes ou par Chord Scales)."); return; }
            if (!this._confirmDiscard()) return;
            if (!c.title) c.title = carnetCleanText(file.name.replace(/\.json$/i, ''), CARNET_TITLE_MAX);
            this._replaceDoc(c, null);
        };
        reader.onerror = () => alert('Impossible de lire ce fichier.');
        reader.readAsText(file);
    }

    // ===== Synchro entre appareils (dépôt GitHub privé, voir carnet-sync.js) =====
    // Ce qui est synchronisé : les carnets sauvegardés (menu « Ouvrir »). Le brouillon du carnet affiché reste sur l'appareil tant qu'il n'est pas sauvegardé.
    // Se déclenche à l'ouverture, au retour sur l'appli, quand le réseau revient, après chaque sauvegarde ou suppression, et à la demande.

    // Le texte tapé mais pas encore validé dans la page affichée est enregistré dans le carnet (sans quitter le champ).
    _commitLive() {
        const ed = (this._annotActive && this._annotActive.isConnected) ? this._annotActive : (this._annotStaffTimer ? this.zone : null);
        if (ed) this._annotCommit(ed);
    }

    _syncSoon(ms) {
        if (!this.sync.isConfigured()) return;
        clearTimeout(this._syncT);
        this._syncT = setTimeout(() => this.runSync(false), ms === undefined ? 600 : ms);
    }

    // manual : lancée depuis le panneau (on affiche toujours le résultat) ; sinon seuls les conflits et les vraies erreurs sont signalés.
    async runSync(manual) {
        if (!this.sync.isConfigured()) { if (manual) this.openSyncPanel(); return null; }
        if (this._syncBusy) { this._syncAgain = true; return null; }
        this._syncBusy = true;
        this.refreshSyncButton();
        let res = null;
        try {
            for (let attempt = 0; attempt < 2; attempt++) { // un 2e passage si GitHub a refusé une écriture parce que le dépôt venait de changer
                this._commitLive();
                const openName = this.name, wasClean = !!openName && this._isClean(), snap0 = this._snap();
                res = await this.sync.sync({ busyName: openName && !wasClean ? openName : null });
                this._afterSync(res, openName, wasClean, snap0);
                if (!(res.ok && res.retry)) break;
            }
        } finally {
            this._syncBusy = false;
        }
        this.refreshSyncButton();
        this._syncReport(res, !!manual);
        if (this._syncAgain) { this._syncAgain = false; this._syncSoon(300); }
        return res;
    }

    // Le carnet affiché a-t-il été touché par la synchro ? Mis à jour s'il n'avait pas de modification non sauvegardée (↶ ramène l'ancienne version).
    _afterSync(res, openName, wasClean, snap0) {
        if (!res || !res.ok || !openName || this.name !== openName) return;
        this._commitLive();
        if (this._snap() !== snap0) return; // l'utilisateur a travaillé pendant la synchro : on ne touche à rien
        if (res.deleted.includes(openName)) { this.name = null; this.refreshSaveButton(); this._syncNote(`« ${openName} » a été supprimé depuis un autre appareil : il reste affiché ici, non sauvegardé.`); return; }
        if (!wasClean || !res.pulled.includes(openName)) return;
        const c = sanitizeCarnet(this.getSaved()[openName]);
        if (!c) return;
        c.title = openName;
        this._flush();
        this.withUndo(() => { const cur = this.doc.current; this.doc = c; this.doc.current = Math.max(0, Math.min(cur, c.pages.length - 1)); });
        this.renderAll();
        this._syncNote(`« ${openName} » mis à jour depuis un autre appareil (↶ pour revenir à la version d'avant).`);
    }

    _syncReport(res, manual) {
        if (!res) return;
        if (this._syncModal) this._renderSyncStatus();
        if (!res.ok) { if (manual || res.error.code !== 'network') this._syncNote(res.error.message, true); return; }
        if (res.conflicts.length) { const c = res.conflicts[0]; this._syncNote(`Conflit sur « ${c.name} » : la version de l'autre appareil est gardée à côté, sous « ${c.copy} ».`); }
        else if (manual) this._syncNote(csyDescribe(res));
    }

    // Petit message en bas de l'écran, qui s'efface seul.
    _syncNote(text, isError) {
        let t = document.getElementById('cn-sync-toast');
        if (!t) {
            t = document.createElement('div');
            t.id = 'cn-sync-toast';
            t.setAttribute('role', 'status');
            t.setAttribute('aria-live', 'polite');
            document.body.appendChild(t);
        }
        t.textContent = text;
        t.classList.toggle('is-error', !!isError);
        t.hidden = false;
        clearTimeout(this._syncToastT);
        this._syncToastT = setTimeout(() => { t.hidden = true; }, isError ? 9000 : 6000);
    }

    _syncWhen(iso) {
        const d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    // État de la synchro, porté par la disquette : pastille bleue = en cours, orange = hors connexion, rouge = erreur ; rien si tout va bien ou si la synchro n'est pas configurée.
    refreshSyncButton() {
        const btn = document.getElementById('cn-save');
        if (!btn) return;
        let state = 'off';
        if (this.sync.isConfigured()) {
            const last = this.sync.lastSync();
            if (this._syncBusy) state = 'busy';
            else if (!last) state = 'idle';
            else if (last.ok) state = 'ok';
            else state = last.code === 'network' ? 'offline' : 'err';
        }
        btn.dataset.sync = state;
        this.refreshSaveButton();
    }

    // Fin de l'infobulle de la disquette : où en est la synchro.
    _syncTip() {
        if (!this.sync.isConfigured()) return '';
        const last = this.sync.lastSync();
        if (this._syncBusy) return ' — synchronisation en cours…';
        if (!last) return ' — synchro configurée, pas encore faite';
        if (last.ok) return ` — synchronisé le ${this._syncWhen(last.at)} (${last.message})`;
        if (last.code === 'network') return ` — hors connexion, dernière tentative le ${this._syncWhen(last.at)}`;
        return ` — erreur de synchro : ${last.message}`;
    }

    _renderSyncStatus() {
        const el = document.getElementById('cn-sync-status');
        if (!el) return;
        const last = this.sync.lastSync();
        el.classList.toggle('is-error', !!(last && !last.ok));
        if (!this.sync.isConfigured()) el.textContent = 'Pas encore configurée sur cet appareil.';
        else if (this._syncBusy) el.textContent = 'Synchronisation en cours…';
        else if (!last) el.textContent = 'Configurée. Pas encore synchronisé.';
        else el.textContent = (last.ok ? 'Dernière synchro réussie : ' : 'Dernière tentative échouée : ') + this._syncWhen(last.at) + ' — ' + last.message;
        const cfg = this.sync.isConfigured();
        const now = document.getElementById('cn-sync-now'), stop = document.getElementById('cn-sync-stop');
        if (now) { now.hidden = !cfg; now.disabled = this._syncBusy; }
        if (stop) stop.hidden = !cfg;
    }

    closeSyncPanel() {
        const m = this._syncModal;
        if (!m) return;
        this._syncModal = null;
        m.remove();
    }

    openSyncPanel() {
        this._closeMenu();
        if (this._syncModal) return;
        const cfg = this.sync.getConfig();
        const el = document.createElement('div');
        el.className = 'cn-modal';
        el.id = 'cn-sync-modal';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-labelledby', 'cn-sync-h');
        el.innerHTML = `<div class="cn-modal-card">
            <h2 id="cn-sync-h">Synchronisation entre appareils</h2>
            <p class="cn-modal-p">Les carnets <b>sauvegardés</b> (disquette, menu « Ouvrir ») sont copiés dans un dépôt GitHub <b>privé</b> et retrouvés sur vos autres appareils. Le brouillon d'un carnet pas encore sauvegardé reste sur l'appareil. En cas de modification des deux côtés, rien n'est perdu : la version de l'autre appareil est gardée à côté.</p>
            <label class="cn-modal-field"><span>Dépôt GitHub</span>
                <input id="cn-sync-repo" type="text" inputmode="url" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="votre-identifiant/carnet-data" value="${cfg ? cnEsc(cfg.repoText) : ''}"></label>
            <label class="cn-modal-field"><span>Jeton d'accès</span>
                <input id="cn-sync-token" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${cfg ? 'jeton enregistré — laisser vide pour le garder' : 'github_pat_…'}"></label>
            <details class="cn-modal-help"><summary>Comment obtenir le dépôt et le jeton ?</summary>
                <ol>
                    <li>Sur github.com, créez un dépôt <b>privé</b> (par exemple <code>carnet-data</code>) en cochant « Add a README file ».</li>
                    <li>Ouvrez <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a> : choisissez une durée, « Only select repositories » → ce dépôt, puis « Repository permissions » → <b>Contents : Read and write</b>. Copiez le jeton affiché.</li>
                    <li>Collez le dépôt et le jeton ici, <b>sur chaque appareil</b> (le jeton reste dans le navigateur de l'appareil).</li>
                </ol>
            </details>
            <div id="cn-sync-status" class="cn-modal-status" role="status" aria-live="polite"></div>
            <div class="cn-modal-actions">
                <button type="button" class="cn-btn cn-btn-primary" id="cn-sync-save">Enregistrer et synchroniser</button>
                <button type="button" class="cn-btn" id="cn-sync-now" hidden>Synchroniser maintenant</button>
                <button type="button" class="cn-btn cn-btn-danger" id="cn-sync-stop" hidden>Arrêter sur cet appareil</button>
                <button type="button" class="cn-btn" id="cn-sync-close">Fermer</button>
            </div>
        </div>`;
        document.body.appendChild(el);
        this._syncModal = el;
        const $ = (id) => document.getElementById(id);
        el.addEventListener('pointerdown', (ev) => { if (ev.target === el) this.closeSyncPanel(); });
        el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); this.closeSyncPanel(); } });
        $('cn-sync-close').addEventListener('click', () => this.closeSyncPanel());
        $('cn-sync-save').addEventListener('click', () => {
            const cur = this.sync.getConfig();
            const err = this.sync.setConfig($('cn-sync-repo').value, $('cn-sync-token').value.trim() || (cur ? cur.token : ''));
            if (err) { const st = $('cn-sync-status'); st.textContent = err; st.classList.add('is-error'); return; }
            $('cn-sync-token').value = '';
            $('cn-sync-token').placeholder = 'jeton enregistré — laisser vide pour le garder';
            this.refreshSyncButton();
            this._renderSyncStatus();
            this.runSync(true);
        });
        $('cn-sync-now').addEventListener('click', () => this.runSync(true));
        $('cn-sync-stop').addEventListener('click', () => {
            if (!confirm("Arrêter la synchro sur cet appareil ?\n\nLe jeton est oublié ici ; les carnets restent sur cet appareil et dans le dépôt GitHub.")) return;
            clearTimeout(this._syncT);
            this.sync.clearConfig();
            $('cn-sync-token').placeholder = 'github_pat_…';
            this.refreshSyncButton();
            this._renderSyncStatus();
        });
        this._renderSyncStatus();
        (cfg ? $('cn-sync-now') : $('cn-sync-repo')).focus({ preventScroll: true });
    }

    // Brouillon : le carnet affiché est gardé tout seul, il revient tel quel à la réouverture (même sans l'avoir sauvegardé).
    _scheduleDraft() {
        clearTimeout(this._draftT);
        this._draftT = setTimeout(() => this._writeDraft(), 400);
    }

    _writeDraft() {
        clearTimeout(this._draftT);
        cnStoreSet(CN_KEYS.draft, JSON.stringify({ doc: Object.assign(carnetToFile(this.doc), { current: this.doc.current }), name: this.name }));
    }

    _restoreDraft() {
        try {
            const o = JSON.parse(cnStore(CN_KEYS.draft) || 'null');
            const d = o && o.doc ? sanitizeCarnet(o.doc) : null;
            if (!d || carnetIsEmpty(d)) return false;
            this.doc = d;
            this.name = typeof o.name === 'string' && this.getSaved()[o.name] ? o.name : null;
            return true;
        } catch (e) { return false; }
    }

    // ===== Son : le piano lit les portées =====

    setupReverb(audioCtx) {
        const convolver = audioCtx.createConvolver();
        const rate = audioCtx.sampleRate;
        const length = rate * 2.2;
        const impulse = audioCtx.createBuffer(2, length, rate);
        const left = impulse.getChannelData(0);
        const right = impulse.getChannelData(1);
        for (let i = 0; i < length; i++) {
            const decay = Math.exp(-i / (rate * 0.6));
            left[i] = (Math.random() * 2 - 1) * decay;
            right[i] = (Math.random() * 2 - 1) * decay;
        }
        convolver.buffer = impulse;

        const wetGain = audioCtx.createGain();
        wetGain.gain.value = 0.3;
        const dryGain = audioCtx.createGain();
        dryGain.gain.value = 0.85;
        const masterGain = audioCtx.createGain();
        masterGain.gain.value = 1.1;

        const inputNode = audioCtx.createGain();
        inputNode.connect(dryGain);
        inputNode.connect(convolver);
        convolver.connect(wetGain);
        dryGain.connect(masterGain);
        wetGain.connect(masterGain);

        const mediaStreamDest = audioCtx.createMediaStreamDestination();
        // Le relais <audio> ne sert qu'à contourner le mode silencieux d'iOS ; ailleurs il doublait la sortie
        // (même signal joué deux fois, légèrement décalé → phasing / artefacts).
        const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        masterGain.connect(audioCtx.destination);
        if (!isIOS) return inputNode;
        masterGain.connect(mediaStreamDest);

        const relayElement = document.createElement('audio');
        relayElement.srcObject = mediaStreamDest.stream;
        relayElement.autoplay = true;
        relayElement.playsInline = true;
        relayElement.muted = false;
        relayElement.style.display = 'none';
        document.body.appendChild(relayElement);

        const unlockRelay = () => {
            relayElement.play().catch(() => {});
            window.removeEventListener('click', unlockRelay);
            window.removeEventListener('touchstart', unlockRelay);
            window.removeEventListener('keydown', unlockRelay);
        };
        window.addEventListener('click', unlockRelay);
        window.addEventListener('touchstart', unlockRelay);
        window.addEventListener('keydown', unlockRelay);

        return inputNode;
    }

    loadPiano() {
        if (this.pianoInstrument || this._pianoPromise) return;   // déjà chargé, ou chargement en cours (évite un second décodage)
        
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!this.audioCtx) {
            this.audioCtx = new AudioContext({ latencyHint: 'playback' });
        }

        this.reverbInput = this.setupReverb(this.audioCtx);

        this._pianoPromise = Soundfont.instrument(this.audioCtx, 'acoustic_grand_piano', { soundfont: 'FluidR3_GM' }).then(instr => {
            this.pianoInstrument = instr;
            return instr;
        }).catch(err => { this._pianoPromise = null; return null; });
    }

    // ===== Module d'annotation de Chord Scales (repris de index.html, JamEngine « Onglet Annotations ») =====

    // Le crayon d'une zone : entre dans l'édition (la zone devient active, la barre de mise en forme vient) ou en sort.
    annotToggleMode(which) {
        const ed = this._annotZoneEl(which);
        if (!ed || ed.getAttribute('data-can-edit') !== 'true') return;
        this.annotEdit[which] = !this.annotEdit[which];
        this._annotSyncMode();
        if (this.annotEdit[which]) {
            try { ed.focus({ preventScroll: true }); } catch (e) {}
            this._annotQuiet = false;
            this.annotActivate(ed);
            this._annotRefreshState();
        }
    }

    // Zoom d'une zone : chaque bloc est agrandi autour du coin haut gauche de la zone (transformation CSS lue dans style.css : --z, et --bx / --by
    // posés par le bloc). Les places enregistrées (data-at) restent celles du canevas à 100 %, et le canevas convertit les positions de l'écran :
    // on édite donc aussi bien zoomé.
    _annotApplyZoom(ed) {
        if (!ed) return;
        const z = this.annotZoom[this._annotZoneKey(ed)];
        ed.__zoom = z;
        ed.style.setProperty('--z', String(z));
        ed.classList.toggle('is-zoomed', z !== 1);
    }

    _annotRefreshZoomUi(which) {
        const zone = this._annotZoneEl(which) && this._annotZoneEl(which).closest('.jam-annot-zone');
        if (!zone) return;
        const z = this.annotZoom[which];
        const reset = zone.querySelector('[data-zoom-act="reset"]'), out = zone.querySelector('[data-zoom-act="out"]'), inn = zone.querySelector('[data-zoom-act="in"]');
        if (reset) { reset.textContent = `${Math.round(z * 100)} %`; reset.classList.toggle('is-on', z !== 1); }
        if (out) out.disabled = z <= AC_ZOOM_MIN;
        if (inn) inn.disabled = z >= AC_ZOOM_MAX;
    }

    // Nouveau zoom (ancre = point de l'écran qui reste en place ; par défaut le centre de la zone).
    _annotSetZoom(which, z1, anchor) {
        const ed = this._annotZoneEl(which);
        if (!ed) return;
        const z0 = this.annotZoom[which];
        z1 = acClampZoom(z1);
        if (z1 === z0) return;
        const r = ed.getBoundingClientRect();
        const px = (anchor ? anchor.x - r.left : r.width / 2) - ed.clientLeft, py = (anchor ? anchor.y - r.top : r.height / 2) - ed.clientTop;
        this.annotZoom[which] = z1;
        try { localStorage.setItem(CN_KEYS.zoom, JSON.stringify(this.annotZoom)); } catch (e) {}
        this._annotApplyZoom(ed);
        ed.scrollLeft = acZoomScroll(ed.scrollLeft, px, z0, z1);
        ed.scrollTop = acZoomScroll(ed.scrollTop, py, z0, z1);
        this._annotRefreshZoomUi(which);
    }

    annotZoomAct(which, act) {
        const z = this.annotZoom[which];
        this._annotSetZoom(which, act === 'reset' ? 1 : acZoomStep(z, act === 'in' ? 1 : -1), null);
    }

    // Gestes de zoom d'une zone (en lecture comme en édition) : Ctrl / ⌘ + molette (et pincement du pavé tactile), pincement de Safari, pincement à deux doigts.
    _annotBindZoom(ed) {
        if (ed.__zoomBound) return;
        ed.__zoomBound = true;
        const which = () => this._annotZoneKey(ed), locked = () => true;
        ed.addEventListener('wheel', (ev) => {
            if (!(ev.ctrlKey || ev.metaKey) || !locked()) return;
            ev.preventDefault();
            this._annotSetZoom(which(), acZoomWheel(this.annotZoom[which()], ev.deltaY, ev.deltaMode), { x: ev.clientX, y: ev.clientY });
        }, { passive: false });
        let z0 = 1;
        ed.addEventListener('gesturestart', (ev) => { if (!locked()) return; ev.preventDefault(); z0 = this.annotZoom[which()]; });
        ed.addEventListener('gesturechange', (ev) => { if (!locked()) return; ev.preventDefault(); this._annotSetZoom(which(), z0 * ev.scale, { x: ev.clientX, y: ev.clientY }); });
        if ('ongesturestart' in window) return; // Safari : les gestes ci-dessus suffisent
        let d0 = 0;
        const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
        ed.addEventListener('touchstart', (ev) => { d0 = locked() && ev.touches.length === 2 ? dist(ev.touches) || 0 : 0; z0 = this.annotZoom[which()]; }, { passive: true });
        ed.addEventListener('touchmove', (ev) => {
            if (!d0 || ev.touches.length !== 2 || !locked()) return;
            ev.preventDefault();
            const t = ev.touches;
            this._annotSetZoom(which(), z0 * dist(t) / d0, { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
        }, { passive: false });
        ed.addEventListener('touchend', () => { d0 = 0; }, { passive: true });
    }

    _annotIsEditable(el) { return !!el && el.getAttribute('data-editable') === 'true'; }

    // Valide le contenu d'un champ d'annotation (nettoyé), sans toucher à son affichage hors cas vide.
    // Les portées sont enregistrées sous la forme de leur seul texte (le dessin est refait à l'ouverture).
    _annotCommit(ed) {
        if (!ed || !ed.isConnected) return;
        if (this._annotStaffTimer) { clearTimeout(this._annotStaffTimer); this._annotStaffTimer = null; }
        this._annotNormalize(ed);
        const html = sanitizeNoteHtml(annotationHtmlForSave(ed), PAGE_NOTE_MAX);
        this.commitPageNote(html);
        if (!html && ed.innerHTML !== '') ed.innerHTML = ''; // champ vraiment vide : le texte d'aide réapparaît
        ed.__html = html;
    }

    // Les tailles de la barre sont posées par le navigateur sous une taille « provisoire » (xxx-large) :
    // on la remplace tout de suite par la taille choisie, en pixels.
    _annotNormalize(ed) {
        const px = this._annotSizePx || 15;
        ed.querySelectorAll('span').forEach(sp => { if (sp.style.fontSize === 'xxx-large') sp.style.fontSize = `${px}px`; });
        ed.querySelectorAll('font').forEach(f => { // anciens navigateurs : <font size="7"> à la place du style
            if (f.getAttribute('size') === '7') { const sp = document.createElement('span'); sp.style.fontSize = `${px}px`; while (f.firstChild) sp.appendChild(f.firstChild); f.replaceWith(sp); }
        });
    }

    annotInput(ed) { this._annotQuiet = false; this._annotRefreshState(); this._annotMoveUndo = false; this._annotMoveRedo = false; this._annotNormalize(ed); this._annotSaveSel(); }

    // Le canevas d'une zone (ui/annot-canvas.js) : sélection des blocs, déplacement, repères d'alignement. Il appelle ces réglages.
    _annotCanvasOpts(ed) {
        return {
            isEditable: () => this._annotIsEditable(ed),
            magnet: () => !!this.annotMagnet,
            zones: () => (this._annotIsEditable(ed) ? [ed] : []),
            // Des blocs sont choisis : la zone devient la zone active (la barre n'apparaît pas d'elle-même, sauf avec ⌘A) et prend le focus pour le clavier
            onSelect: (cv, quiet) => {
                if (cv.sel.length) {
                    if (!this._annotActive) this._annotQuiet = quiet !== false;
                    this.annotActivate(ed);
                    try { ed.focus({ preventScroll: true }); } catch (e) {}
                }
                this._annotRefreshState();
            },
            onBackground: () => { this._annotQuiet = false; this.annotActivate(ed); this._annotRefreshState(); }, // un clic sur le fond choisit la zone et fait venir la barre (portée, cadre, mise en forme)
            onCreateAt: (cv, x, y) => this.annotInsertFrame({ x, y }, ed),                                           // un double-clic sur le fond crée un cadre de texte
            onGrab: () => { if (this._annotStaffTimer) this._annotCommit(ed); },                                     // changements en attente enregistrés avant le déplacement
            // Un déplacement à la souris est enregistré tout de suite ; une série de flèches (série = true) en une seule entrée : ↶ ou ⌘Z l'annule
            onMoved: (views, serie) => { this._annotMoveUndo = true; this._annotMoveRedo = false; if (serie) this._annotStaffChanged(ed); else this._annotCommit(ed); }
        };
    }

    // Clavier de la zone (focus sur la zone, aucun texte en cours de saisie) : les blocs sélectionnés se décalent avec les flèches (1 pixel, 10 avec Maj),
    // Suppr. les enlève, ⌘C / ⌘X les copient / coupent, ⌘A les sélectionne tous, Échap vide la sélection.
    // La saisie dans un cadre de texte en édition, elle, est laissée au navigateur.
    annotKeydown(ev) {
        ev.stopPropagation(); // les raccourcis de la page (flèches de la grille, ⌘Z de la grille…) ne s'appliquent pas à la saisie
        const ed = ev.currentTarget, cv = ed && ed.__canvas;
        const key = String(ev.key), mod = (ev.metaKey || ev.ctrlKey) && !ev.altKey;
        // Une portée dont une note est sélectionnée prend les flèches, lettres, Suppr. et ⌘Z.
        const sv = (typeof NSE_ACTIVE !== 'undefined') ? NSE_ACTIVE : null;
        const inStaff = !!(sv && ed && ed.contains(sv.el));
        if (inStaff && sv.handleKey(ev)) { ev.preventDefault(); return; }
        if (ev.target && ev.target.closest && ev.target.closest('.annot-frame-body')) return; // on écrit dans un cadre : le navigateur s'en charge (et annule la frappe)
        // ⌘Z / ⌘⇧Z (ou ⌘Y) sur la zone : annule ou rétablit la dernière modification du carnet (déplacement, ajout ou retrait de bloc, texte validé…).
        if (mod && (key.toLowerCase() === 'z' || key.toLowerCase() === 'y')) {
            ev.preventDefault();
            if (key.toLowerCase() === 'y' || ev.shiftKey) this.redo(); else this.undo();
            return;
        }
        if (mod && (key === 'c' || key === 'C' || key === 'x' || key === 'X') && !(ev.target && ev.target.closest && ev.target.closest('select, input'))) {
            const cut = key.toLowerCase() === 'x';
            if (inStaff && !(cv && cv.picked().length)) {                 // portée en édition : c'est elle qu'on copie (ou coupe)
                ev.preventDefault();
                this.annotCopyStaff(sv);
                if (cut) { sv.destroy(); sv.el.remove(); this._annotCommit(ed); }
            } else if (cv && cv.picked().length) {
                ev.preventDefault();
                this.annotCopyBlocks(ed, cut);
            }
            return;
        }
        if (mod && key.toLowerCase() === 'a' && cv && !inStaff) { ev.preventDefault(); cv.selectAll(); return; }
        const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (arrows[key] && !mod && !ev.altKey && cv && cv.picked().length) {
            const k = ev.shiftKey ? 10 : 1;
            ev.preventDefault();
            cv.nudgeSelected(arrows[key][0] * k, arrows[key][1] * k);
            return;
        }
        if ((key === 'Delete' || key === 'Backspace') && !mod && cv && cv.picked().length && !inStaff) {
            ev.preventDefault();
            this._annotRemoveBlocks(ed, cv.picked());
            return;
        }
        if (key === 'Escape') {
            ev.preventDefault();
            if (this._annotMenu) this._annotCloseMenu();
            else if (cv && cv.picked().length) cv.clearSelection(true);
            else if (ed) ed.blur();
        }
    }

    // Collage : un repère « [portée…] » ou « [cadre…] » (voir annotCopyBlocks) redevient une portée ou un cadre de texte, avec sa place si elle est notée.
    // Un texte ordinaire devient un nouveau cadre de texte (on n'écrit jamais en dehors d'un cadre). Dans un cadre en édition, seul le texte est collé.
    annotPaste(ev) {
        ev.preventDefault();
        const ed = ev.currentTarget;
        const t = (ev.clipboardData || window.clipboardData).getData('text/plain');
        if (!t) return;
        const parts = drawSplitClips(t);
        const inFrame = !!(ev.target && ev.target.closest && ev.target.closest('.annot-frame-body'));
        if (inFrame) document.execCommand('insertText', false, parts.map(p => p.text || '').join('')); // un cadre ne contient que du texte : ni portée ni autre cadre dedans
        else if (this._annotIsEditable(ed)) this._annotPasteParts(ed, parts);
    }

    // Copier / couper par l'événement du navigateur (menu Édition, par exemple) : mêmes blocs et même texte que ⌘C / ⌘X au clavier (annotKeydown).
    annotCopy(ev, cut = false) {
        const ed = ev.currentTarget;
        if (!ed || !ev.clipboardData) return;
        if (ev.target && ev.target.closest && ev.target.closest('.annot-frame-body')) return;  // texte d'un cadre en édition : la copie du navigateur suit son cours
        const cv = ed.__canvas, els = cv ? cv.picked() : [];
        const sv = (typeof NSE_ACTIVE !== 'undefined') ? NSE_ACTIVE : null;
        let text = null, removeActive = null;
        if (els.length) text = carnetBlocksToClipText(els);
        else if (sv && ed.contains(sv.el)) { text = staffClipText(sv.st); removeActive = sv; }
        if (text === null) return;
        ev.preventDefault();
        ev.clipboardData.setData('text/plain', text);
        this._annotRememberClip(text);
        if (!cut || !this._annotIsEditable(ed)) return;
        if (removeActive) { removeActive.destroy(); removeActive.el.remove(); this._annotCommit(ed); } else this._annotRemoveBlocks(ed, els);
    }

    _annotRememberClip(text) {
        const first = splitStaffClips(text).find(p => p.staff);
        if (first) this._staffClip = first.staff;
    }

    // Écrit dans le presse-papiers du système (l'API moderne d'abord, sinon l'ancienne méthode par un champ temporaire).
    _annotWriteClipboard(text) {
        try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).catch(() => this._annotLegacyCopy(text)); return; } } catch (e) {}
        this._annotLegacyCopy(text);
    }

    _annotLegacyCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        const keep = document.activeElement;
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        ta.remove();
        if (keep && keep.focus) { try { keep.focus({ preventScroll: true }); } catch (e) {} }
    }

    // Copie (ou coupe) les blocs sélectionnés : le presse-papiers reçoit un repère par bloc, avec sa place et son cadre, que le collage sait relire,
    // y compris dans l'autre zone d'annotation.
    annotCopyBlocks(ed, cut = false) {
        const cv = ed && ed.__canvas, els = cv ? cv.picked() : [];
        if (!els.length) return false;
        const text = carnetBlocksToClipText(els);
        this._annotWriteClipboard(text);
        this._annotRememberClip(text);
        if (cut && this._annotIsEditable(ed)) this._annotRemoveBlocks(ed, els);
        return true;
    }

    // Enlève des blocs de la zone (Suppr., couper) : une seule étape d'annulation.
    _annotRemoveBlocks(ed, els) {
        if (!ed || !els.length || !this._annotIsEditable(ed)) return;
        if (ed.__canvas) ed.__canvas.clearSelection(true);
        els.forEach((el) => { const v = el.__noteStaff || el.__noteFrame || el.__chordBlock || el.__drawBlock; if (v) v.destroy(); el.remove(); });
        this._annotMoveUndo = true; this._annotMoveRedo = false;
        this._annotCommit(ed);
        try { ed.focus({ preventScroll: true }); } catch (e) {}
        this._annotRefreshState();
    }

    // Crée des blocs dans la zone à partir de morceaux [{ text }] / [{ staff }] / [{ chords }] / [{ frame }] (collage). Un bloc copié avec sa place revient à cette place
    // décalée de quelques pixels (pour voir qu'il s'agit d'un double) ; sans place, il prend la première place libre. Un texte ordinaire devient un cadre.
    _annotPasteParts(ed, parts) {
        if (!this._annotIsEditable(ed) || !ed.__canvas) return;
        const cv = ed.__canvas;
        let room = NOTE_MAX_STAVES - ed.querySelectorAll('.annot-staff').length;
        let roomFrames = NOTE_MAX_FRAMES - ed.querySelectorAll('.annot-frame').length;
        let roomChords = NOTE_MAX_CHORDS - ed.querySelectorAll('.annot-chords').length;
        let roomDraw = NOTE_MAX_DRAWS - ed.querySelectorAll('.annot-draw').length;
        const max = PAGE_NOTE_MAX;
        const rects = cv.blocks().map(b => cv.rectOf(b));
        const made = [];
        const add = (html, at, w) => {
            const holder = document.createElement('div');
            holder.innerHTML = html;
            const stub = holder.firstElementChild;
            if (!stub) return false;
            ed.appendChild(stub);
            made.push(stub);
            rects.push({ x: at.x, y: at.y, w: w || 40, h: 24 });
            return true;
        };
        const shift = (at) => ({ x: Math.min(SN_AT_MAX, at.x + AC_CASCADE), y: Math.min(SN_AT_MAX, at.y + AC_CASCADE) });
        for (const p of parts) {
            if (p.frame) {
                if (roomFrames <= 0) continue;
                const at = p.at ? shift(p.at) : acFreeSpot(rects);
                const html = sanitizeNoteHtml(noteFrameStubHtml(parseFrameBox(p.frame.box), at, p.frame.html, !p.noBorder), max);
                if (add(html, at, (parseFrameBox(p.frame.box) || {}).w)) roomFrames--;
            } else if (p.draw) {
                if (roomDraw <= 0) continue;
                const at = p.at ? shift(p.at) : acFreeSpot(rects);
                const st = drawParse(p.draw);
                if (st && add(drawStubHtml(st, at, !p.noBorder), at, st.w)) roomDraw--;
            } else if (p.chords) {
                if (roomChords <= 0) continue;
                const at = p.at ? shift(p.at) : acFreeSpot(rects);
                if (add(chordsStubHtml(chordsParse(p.chords), at, !p.noBorder), at, 160)) roomChords--;
            } else if (p.staff) {
                if (room <= 0) continue;
                const at = p.at ? shift(p.at) : acFreeSpot(rects);
                if (add(noteStaffStubHtml(parseStaff(p.staff), at, !p.noBorder), at, 200)) room--;
            } else if (p.text) {
                const txt = p.text.replace(/ /g, ' ').replace(/^\s+|\s+$/g, '');
                if (!txt || roomFrames <= 0) continue;
                const w = Math.max(SN_FRAME_W_MIN, Math.min(SN_FRAME_W_DEFAULT, Math.floor(ed.clientWidth - 48)));
                const at = acFreeSpot(rects);
                const esc = txt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                if (add(sanitizeNoteHtml(noteFrameStubHtml({ w }, at, esc, false), max), at, w)) roomFrames--;
            }
        }
        if (!made.length) return;
        this._annotHydrate(ed);
        this._annotMoveUndo = true; this._annotMoveRedo = false;
        this._annotCommit(ed);
        cv.select(made.filter(m => m.isConnected), 'set', false);
    }

    // Bouton « Coller » de la barre d'une portée : colle la dernière portée copiée (à la première place libre de la zone).
    annotPasteStaff() {
        if (!this._staffClip || !this._annotEnsureActive()) return;
        const ed = this._annotActive;
        if (!this._annotIsEditable(ed)) return;
        this._annotLeaveFrame();
        this._annotPasteParts(ed, [{ staff: this._staffClip }]);
    }

    // Bouton « Copier » de la barre d'une portée : la portée en édition va dans le presse-papiers (et dans la mémoire de l'appli).
    annotCopyStaff(view) {
        if (!view) return;
        this._staffClip = formatStaff(view.st);
        try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(staffClipText(view.st)).catch(() => {}); } catch (e) {}
    }

    // Quitter le champ valide l'annotation, sauf si le focus passe à la barre, à un menu ou à une portée de ce champ.
    annotBlur(ed, ev) {
        const rt = ev && ev.relatedTarget;
        const bar = document.getElementById('jam-annot-bar');
        if (rt && (ed.contains(rt) || (bar && bar.contains(rt)) || (this._annotMenu && this._annotMenu.el.contains(rt)))) return;
        this._annotCommit(ed);
    }

    // ----- Barre de mise en forme (collée en haut de l'onglet) -----
    _annotBindBar(bar) {
        if (!bar) return;
        // Les boutons ne prennent pas le focus : la sélection du texte reste en place dans la zone.
        bar.addEventListener('mousedown', (ev) => { if (!ev.target.closest('select, input')) ev.preventDefault(); });
        bar.addEventListener('click', (ev) => this._annotBarClick(ev));
        const font = bar.querySelector('[data-font]');
        font.addEventListener('mousedown', () => { this._annotSaveSel(); });
        font.addEventListener('change', () => { this.annotCmd('fontName', font.value); });
        this._annotRefreshState();
    }

    _annotBarClick(ev) {
        const t = ev.target;
        let b;
        if ((b = t.closest('[data-size-step]'))) this.annotSetSize(nextAnnotSize(this._annotCurrentSize(), parseInt(b.dataset.sizeStep, 10)));
        else if ((b = t.closest('[data-menu]'))) this._annotToggleMenu(b.dataset.menu, b);
        else if ((b = t.closest('[data-cmd]'))) this.annotCmd(b.dataset.cmd);
        else if (t.closest('[data-insert-staff]')) this.annotInsertStaff();
        else if (t.closest('[data-insert-frame]')) this.annotInsertFrame();
        else if (t.closest('[data-insert-chords]')) this.annotInsertChords();
        else if (t.closest('[data-insert-draw]')) this.annotInsertDraw();
        else if (t.closest('[data-clear]')) { this.annotCmd('removeFormat'); this.annotCmd('justifyLeft'); }
    }

    // Zone d'écriture à utiliser si l'on clique sur la barre sans avoir choisi de zone : la page affichée (si elle est en édition).
    _annotEnsureActive() {
        if (this._annotActive && this._annotActive.isConnected) return this._annotActive;
        const g = this.zone;
        if (!g || !this._annotIsEditable(g)) return null;
        g.focus({ preventScroll: true });
        this.annotActivate(g);
        return this._annotActive;
    }

    // Une zone d'annotation est choisie (clic sur son fond ou sur un de ses blocs) : la barre s'applique à elle.
    annotActivate(ed) {
        if (!this._annotIsEditable(ed)) return;
        if (this._annotActive && this._annotActive !== ed) {
            const prev = this._annotActive;
            this._annotCommit(prev);
            if (prev.__canvas) prev.__canvas.clearSelection(true);
            this._annotRange = null;
        }
        this._annotActive = ed;
        this._annotGlobalOn();
        this._annotRefreshState();
    }

    // Plus de zone active (autre onglet, clic ailleurs, lecture lancée) : valide le texte, ferme le menu, vide la sélection.
    annotDeactivate() {
        const ed = this._annotActive;
        this._annotQuiet = false;
        if (typeof NSE_ACTIVE !== 'undefined' && NSE_ACTIVE) NSE_ACTIVE.deactivate();
        if (typeof NTF_ACTIVE !== 'undefined' && NTF_ACTIVE) NTF_ACTIVE.deactivate();
        if (typeof CHB_ACTIVE !== 'undefined' && CHB_ACTIVE) CHB_ACTIVE.deactivate();
        if (typeof DRB_ACTIVE !== 'undefined' && DRB_ACTIVE) DRB_ACTIVE.deactivate();
        this._annotCloseMenu();
        this._annotGlobalOff();
        this._annotActive = null;
        this._annotRange = null;
        if (ed && ed.__canvas) ed.__canvas.clearSelection(true);
        if (ed) this._annotCommit(ed);
        this._annotRefreshState();
    }

    _annotGlobalOn() {
        if (this._annotListening) return;
        this._annotListening = true;
        const outside = (t) => {
            if (!t || !t.closest) return;
            const m = this._annotMenu;
            if (m && !m.el.contains(t) && !m.anchor.contains(t)) this._annotCloseMenu();
            if (t.closest('.jam-annot-text, #jam-annot-bar, .ab-menu, .cn-chord-pop, .cn-draw-pop, .jam-annot-head, .jam-annot-span')) return; // l'en-tête (crayon, zoom, outils) ne fait pas ranger la barre : la page ne saute pas sous le doigt
            this.annotDeactivate();
        };
        this._annotOutside = (ev) => {
            const t = ev.target;
            // Au doigt, un appui hors des annotations ne les range qu'au relâcher (et pas si la page a défilé) : faire défiler la page ne doit pas fermer l'édition.
            if (ev.pointerType === 'touch' && t && t.closest && !t.closest('.jam-annot-text, #jam-annot-bar, .ab-menu, .cn-chord-pop, .cn-draw-pop, .jam-annot-head, .jam-annot-span') && typeof acOnTouchTap === 'function') acOnTouchTap(ev, outside);
            else outside(t);
        };
        this._annotSelChange = () => { this._annotSaveSel(); this._annotRefreshState(); };
        document.addEventListener('pointerdown', this._annotOutside, true);
        document.addEventListener('selectionchange', this._annotSelChange);
    }

    _annotGlobalOff() {
        if (!this._annotListening) return;
        this._annotListening = false;
        document.removeEventListener('pointerdown', this._annotOutside, true);
        document.removeEventListener('selectionchange', this._annotSelChange);
    }

    // Mémorise la sélection dans le texte du cadre en édition (la barre ou un menu peut la lui faire perdre, par exemple avec le curseur de taille).
    _annotSaveSel() {
        const f = this._annotFrameEditing(), sel = window.getSelection();
        if (!f || !sel || sel.rangeCount === 0) return;
        const r = sel.getRangeAt(0);
        if (f.body.contains(r.commonAncestorContainer)) this._annotRange = r.cloneRange();
    }

    // Cadre de texte dont le texte est en cours d'édition dans la zone active (ui/text-frame.js), ou null.
    _annotFrameEditing() {
        const f = (typeof NTF_ACTIVE !== 'undefined') ? NTF_ACTIVE : null;
        const ed = this._annotActive;
        return (f && f.isActive && f.el.isConnected && ed && ed.contains(f.el)) ? f : null;
    }

    // Cadres de texte sélectionnés (pas en édition) dans la zone active : la mise en forme de la barre s'applique alors à tout leur texte.
    _annotPickedFrames() {
        const ed = this._annotActive, cv = ed && ed.__canvas;
        return cv ? cv.picked().map(e => e.__noteFrame).filter(Boolean) : [];
    }

    // Blocs concernés par les boutons de disposition : les blocs sélectionnés, plus le cadre ou la portée en édition.
    _annotTargets() {
        const ed = this._annotActive, cv = ed && ed.__canvas, out = [];
        if (cv) cv.picked().forEach((e) => { const v = cv.viewOf(e); if (v) out.push(v); });
        const f = this._annotFrameEditing();
        if (f && !out.includes(f)) out.push(f);
        const s = (typeof NSE_ACTIVE !== 'undefined') ? NSE_ACTIVE : null;
        if (s && ed && ed.contains(s.el) && !out.includes(s)) out.push(s);
        const c = (typeof CHB_ACTIVE !== 'undefined') ? CHB_ACTIVE : null;
        if (c && ed && ed.contains(c.el) && !out.includes(c)) out.push(c);
        const d = (typeof DRB_ACTIVE !== 'undefined') ? DRB_ACTIVE : null;
        if (d && ed && ed.contains(d.el) && !out.includes(d)) out.push(d);
        return out;
    }

    // Sort de l'édition du cadre (s'il y en a un) et rend le focus à la zone.
    _annotLeaveFrame() {
        if (typeof CHB_ACTIVE !== 'undefined' && CHB_ACTIVE) CHB_ACTIVE.deactivate(); // l'éditeur d'accords se ferme aussi
        if (typeof DRB_ACTIVE !== 'undefined' && DRB_ACTIVE) DRB_ACTIVE.deactivate(); // et celui du dessin
        const f = this._annotFrameEditing();
        if (!f) return;
        const ed = this._annotActive;
        f.deactivate();
        try { ed.focus({ preventScroll: true }); } catch (e) {}
        this._annotRange = null;
    }

    // Replace le curseur dans le texte du cadre en édition (la barre l'a peut-être fait perdre).
    _annotRestoreSel(keepFocus = false) {
        const f = this._annotFrameEditing(), sel = window.getSelection();
        if (!f || !sel) return false;
        const host = f.body;
        const inside = sel.rangeCount && host.contains(sel.getRangeAt(0).commonAncestorContainer);
        if (inside && (keepFocus || document.activeElement === host)) return true;
        if (!keepFocus) host.focus({ preventScroll: true });
        let r = inside ? sel.getRangeAt(0).cloneRange() : this._annotRange;
        if (!(r && host.contains(r.commonAncestorContainer))) { r = document.createRange(); r.selectNodeContents(host); r.collapse(false); }
        sel.removeAllRanges();
        sel.addRange(r);
        return true;
    }

    // Applique une commande de mise en forme : à la sélection du texte du cadre en édition (ou, sans sélection, au texte qui sera tapé ensuite) ;
    // sans cadre en édition, à tout le texte des cadres sélectionnés. keepFocus : le curseur de taille garde le focus pendant qu'on le glisse.
    annotCmd(cmd, value, keepFocus = false) {
        if (!this._annotEnsureActive()) return;
        const ed = this._annotActive;
        if (!this._annotIsEditable(ed)) return;
        if (!this._annotFrameEditing()) { this._annotFormatPickedFrames(ed, cmd, value); return; }
        this._annotRestoreSel(keepFocus);
        try {
            document.execCommand('styleWithCSS', false, true); // styles en CSS (span) plutôt que balises <font>
            document.execCommand(cmd, false, value);
        } catch (e) {}
        this._annotNormalize(ed);
        this._annotSaveSel();
        this._annotRefreshState();
    }

    // Mise en forme de la barre appliquée à tout le texte de chaque cadre sélectionné (sans l'ouvrir en édition). Un symbole à insérer ne s'applique pas ici.
    _annotFormatPickedFrames(ed, cmd, value) {
        if (cmd === 'insertText') return;
        const frames = this._annotPickedFrames();
        if (!frames.length) return;
        const sel = window.getSelection();
        frames.forEach((fv) => {
            const body = fv.body;
            body.setAttribute('contenteditable', 'true');
            try { body.focus({ preventScroll: true }); } catch (e) {}
            if (sel) { const r = document.createRange(); r.selectNodeContents(body); sel.removeAllRanges(); sel.addRange(r); }
            try {
                document.execCommand('styleWithCSS', false, true);
                document.execCommand(cmd, false, value);
            } catch (e) {}
            body.removeAttribute('contenteditable');
        });
        if (sel) sel.removeAllRanges();
        this._annotNormalize(ed);
        frames.forEach((fv) => { fv._layout(); fv.commit(); });
        try { ed.focus({ preventScroll: true }); } catch (e) {}
        this._annotMoveUndo = false; this._annotMoveRedo = false;
        this._annotCommit(ed);
        this._annotRefreshState();
    }

    // Taille du texte, en pixels (boutons − / +, curseur, tailles du menu).
    annotSetSize(px, keepFocus = false) {
        this._annotSizePx = clampAnnotSize(px);
        this.annotCmd('fontSize', '7', keepFocus);
    }

    // Élément qui porte la mise en forme à l'endroit de la sélection (ou du curseur) du cadre en édition ; sans édition, le premier cadre sélectionné.
    _annotAtSelection() {
        const f = this._annotFrameEditing();
        if (f) {
            const sel = window.getSelection();
            let n = (sel && sel.rangeCount && f.body.contains(sel.anchorNode)) ? sel.anchorNode : (this._annotRange ? this._annotRange.startContainer : null);
            if (!n || !f.body.contains(n)) return f.body;
            return n.nodeType === 1 ? n : n.parentElement;
        }
        const pf = this._annotPickedFrames();
        return pf.length ? pf[0].body : null;
    }

    _annotCurrentSize() {
        const el = this._annotAtSelection();
        if (!el) return this._annotSizePx || ANNOT_SIZE_DEFAULT;
        return Math.round(parseFloat(getComputedStyle(el).fontSize)) || ANNOT_SIZE_DEFAULT;
    }

    // Boutons allumés selon le style du texte sélectionné ; taille et police affichées ; barre grisée sans zone active.
    _annotRefreshState() {
        const bar = document.getElementById('jam-annot-bar');
        if (!bar) return;
        const ed = this._annotActive;
        // La barre n'apparaît que pendant l'édition ; un bloc choisi d'un clic ou d'un glisser ne la fait pas surgir
        // (les zones ne sautent pas sous le pointeur) : elle vient avec un clic sur le fond de la zone, le crayon d'un bloc ou ⌘A.
        const idle = !ed || !!this._annotQuiet;
        bar.classList.toggle('is-idle', idle);
        if (bar.parentElement) bar.parentElement.classList.toggle('jam-annot-barless', idle); // barre masquée : les zones prennent sa place
        const f = this._annotFrameEditing();
        bar.querySelectorAll('[data-state]').forEach(b => {
            let on = false;
            try { on = !!(f && f.body.contains(window.getSelection().anchorNode) && document.queryCommandState(b.dataset.state)); } catch (e) {}
            b.classList.toggle('is-on', on);
        });
        const el = ed ? this._annotAtSelection() : null;
        const size = el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) || ANNOT_SIZE_DEFAULT : ANNOT_SIZE_DEFAULT;
        const lab = bar.querySelector('[data-size-label]');
        if (lab) lab.textContent = String(size);
        const font = bar.querySelector('[data-font]');
        if (font && el) {
            const name = annotFontLabel(getComputedStyle(el).fontFamily);
            const opt = Array.from(font.options).find(o => o.text === name);
            if (opt) font.value = opt.value;
        }
        const m = this._annotMenu;
        if (m && m.kind === 'size') {
            const rng = m.el.querySelector('[data-size-range]'), out = m.el.querySelector('[data-size-out]');
            if (rng && document.activeElement !== rng) rng.value = String(size);
            if (out && document.activeElement !== rng) out.textContent = String(size);
        }
        this._annotRefreshTools();
    }

    // ----- Boutons de disposition, en tête de chaque zone : aimant, cadre visible / caché, premier plan, arrière-plan -----
    // L'aimant est un réglage de la page (gardé d'une visite à l'autre) ; les trois autres s'appliquent aux blocs sélectionnés de la zone active
    // (et au cadre ou à la portée en édition).
    annotToolAct(act) {
        if (act === 'magnet') {
            this.annotMagnet = !this.annotMagnet;
            try { localStorage.setItem(CN_KEYS.magnet, this.annotMagnet ? '1' : '0'); } catch (e) {}
            this._annotRefreshTools();
            return;
        }
        const ed = this._annotActive;
        const views = this._annotTargets();
        if (!ed || !views.length) return;
        if (act === 'border') {
            const show = !views.every(v => v.border);
            let changed = false;
            views.forEach((v) => { if (v.setBorder(show)) changed = true; });
            if (!changed) return;
        } else if (act === 'front' || act === 'back') {
            const els = views.map(v => v.el).filter(e => e.parentNode === ed);
            const ordered = Array.from(ed.children).filter(c => els.includes(c)); // dans leur ordre actuel
            if (act === 'front') ordered.forEach(e => ed.appendChild(e));
            else ordered.reverse().forEach(e => ed.insertBefore(e, ed.firstChild));
        } else return;
        this._annotMoveUndo = true; this._annotMoveRedo = false;
        this._annotCommit(ed);
        this._annotRefreshState();
    }

    _annotRefreshTools() {
        const targets = this._annotTargets();
        document.querySelectorAll('.jam-annot-tools').forEach((strip) => {
            const zone = strip.closest('.jam-annot-zone') && strip.closest('.jam-annot-zone').querySelector('.jam-annot-text');
            const mine = !!zone && zone === this._annotActive;
            strip.querySelectorAll('[data-annot-act]').forEach((b) => {
                const a = b.dataset.annotAct;
                if (a === 'magnet') {
                    b.classList.toggle('is-on', !!this.annotMagnet);
                    b.setAttribute('aria-pressed', this.annotMagnet ? 'true' : 'false');
                    return;
                }
                b.disabled = !mine || targets.length === 0;
                if (a === 'border') {
                    const on = mine && targets.length > 0 && targets.every(v => v.border);
                    b.classList.toggle('is-on', on);
                    b.setAttribute('aria-pressed', on ? 'true' : 'false');
                }
            });
        });
    }

    // Le focus clavier arrive sur la zone (Tab, clic sur un bloc) : la barre n'apparaît pas d'elle-même.
    annotFocus(ed) {
        if (!this._annotIsEditable(ed)) return;
        if (!this._annotActive) this._annotQuiet = true;
        this.annotActivate(ed);
    }

    // ----- Menus flottants de la barre (taille avec curseur, couleurs, symboles) -----
    _annotToggleMenu(kind, anchor) {
        if (this._annotMenu && this._annotMenu.kind === kind) { this._annotCloseMenu(); return; }
        this._annotCloseMenu();
        if (!this._annotEnsureActive()) return;
        this._annotSaveSel();
        const el = document.createElement('div');
        el.className = `ab-menu ab-menu-${kind}`;
        el.setAttribute('role', 'dialog');
        el.innerHTML = annotMenuHtml(kind, { size: this._annotCurrentSize() });
        // Les boutons ne prennent pas le focus (la sélection du texte reste en place) ; le curseur et le sélecteur de couleur si.
        el.addEventListener('mousedown', (ev) => { if (!ev.target.closest('input')) ev.preventDefault(); });
        el.addEventListener('click', (ev) => {
            const t = ev.target;
            let b;
            if ((b = t.closest('[data-size]'))) { this.annotSetSize(parseInt(b.dataset.size, 10)); this._annotRefreshState(); }
            else if ((b = t.closest('[data-color]'))) { this._annotPickColor(b.dataset.color); this._annotCloseMenu(); }
            else if ((b = t.closest('[data-hilite]'))) { this.annotCmd('hiliteColor', b.dataset.hilite); this._annotCloseMenu(); }
            else if ((b = t.closest('[data-ins]'))) this.annotCmd('insertText', b.dataset.ins);
        });
        const rng = el.querySelector('[data-size-range]');
        if (rng) {
            const out = el.querySelector('[data-size-out]');
            rng.addEventListener('pointerdown', () => el.classList.add('is-dragging'));
            rng.addEventListener('input', () => { out.textContent = rng.value; this.annotSetSize(parseInt(rng.value, 10), true); });
            rng.addEventListener('change', () => { el.classList.remove('is-dragging'); this.annotSetSize(parseInt(rng.value, 10)); });
            ['pointerup', 'pointercancel', 'blur'].forEach(ev => rng.addEventListener(ev, () => el.classList.remove('is-dragging')));
        }
        const custom = el.querySelector('[data-color-custom]');
        if (custom) custom.addEventListener('change', () => { this._annotPickColor(custom.value); this._annotCloseMenu(); });
        (document.fullscreenElement || document.body).appendChild(el);
        const r = anchor.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
        const w = el.offsetWidth, h = el.offsetHeight;
        el.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
        el.style.top = `${(r.bottom + 6 + h > vh - 8 && r.top - 6 - h > 8) ? r.top - 6 - h : r.bottom + 6}px`;
        anchor.classList.add('is-open');
        this._annotMenu = { el, kind, anchor };
    }

    _annotCloseMenu() {
        const m = this._annotMenu;
        if (!m) return;
        this._annotMenu = null;
        m.anchor.classList.remove('is-open');
        m.el.remove();
    }

    // Couleur du texte : posée, et rappelée sous la lettre « A » de la barre.
    _annotPickColor(color) {
        this.annotCmd('foreColor', color);
        const bar = document.querySelector('#jam-annot-bar [data-color-bar]');
        if (bar) bar.style.background = color;
    }

    // ----- Blocs de la zone : portées éditables (ui/staff-editor.js) et cadres de texte (ui/text-frame.js) -----
    // Réglages communs à toutes les portées de la page : est-elle modifiable, enregistrement après les changements, son.
    _annotStaffOpts(ed) {
        return {
            isEditable: () => this._annotIsEditable(ed),
            canvas: () => ed.__canvas,
            onChange: () => { this._annotMoveUndo = false; this._annotMoveRedo = false; this._annotStaffChanged(ed); },
            // Un redimensionnement à la souris est enregistré tout de suite (↶ ou ⌘Z l'annule)
            onMoved: () => { this._annotMoveUndo = true; this._annotMoveRedo = false; this._annotCommit(ed); },
            toolsHost: () => document.getElementById('jam-annot-staff-host'),
            onActivate: () => { this._annotQuiet = false; this.annotActivate(ed); try { ed.focus({ preventScroll: true }); } catch (e) {} this._annotStaffMode(true); this._annotRefreshState(); },
            onDeactivate: () => { this._annotStaffMode(false); this._annotRefreshState(); },
            onFocusBack: () => { try { ed.focus({ preventScroll: true }); } catch (e) {} },
            onRemove: (view) => { view.destroy(); view.el.remove(); this._annotCommit(ed); },
            maxStaves: NOTE_MAX_STAVES,
            onGrab: () => { if (this._annotStaffTimer) this._annotCommit(ed); }, // changements en attente enregistrés avant le redimensionnement : il aura sa propre étape d'annulation
            onCopy: (view) => this.annotCopyStaff(view),
            onPaste: () => this.annotPasteStaff(),
            audio: this._annotAudio()
        };
    }

    // Réglages communs à tous les cadres d'une zone. Le texte d'un cadre se met en forme avec la barre habituelle (elle reste affichée).
    _annotFrameOpts(ed) {
        return {
            isEditable: () => this._annotIsEditable(ed),
            canvas: () => ed.__canvas,
            keepOpen: (t) => !!(t && t.closest && t.closest('#jam-annot-bar, .ab-menu, .jam-annot-tools')), // la barre, ses menus et les boutons de disposition ne font pas sortir de l'édition
            onChange: () => { this._annotMoveUndo = false; this._annotMoveRedo = false; this._annotStaffChanged(ed); },
            onMoved: () => { this._annotMoveUndo = true; this._annotMoveRedo = false; this._annotCommit(ed); },
            onActivate: () => { this._annotQuiet = false; this.annotActivate(ed); this._annotStaffMode(false); this._annotRefreshState(); },
            onDeactivate: () => this._annotRefreshState(),
            onFocusBack: () => { try { ed.focus({ preventScroll: true }); } catch (e) {} },
            maxFrames: NOTE_MAX_FRAMES,
            onGrab: () => { if (this._annotStaffTimer) this._annotCommit(ed); }
        };
    }

    // Réglages communs à tous les blocs d'accords d'une zone (ui/chord-block.js) : leur éditeur est une fenêtre à part, la barre de texte reste rangée.
    _annotChordOpts(ed) {
        return {
            isEditable: () => this._annotIsEditable(ed),
            canvas: () => ed.__canvas,
            keepOpen: (t) => !!(t && t.closest && t.closest('.cn-chord-pop, .jam-annot-tools')), // les boutons de disposition s'appliquent au bloc en édition
            onChange: () => { this._annotMoveUndo = false; this._annotMoveRedo = false; this._annotStaffChanged(ed); },
            onMoved: () => { this._annotMoveUndo = true; this._annotMoveRedo = false; this._annotCommit(ed); },
            onActivate: () => { this._annotQuiet = true; this.annotActivate(ed); this._annotStaffMode(false); this._annotRefreshState(); },
            onDeactivate: () => this._annotRefreshState(),
            onFocusBack: () => { try { ed.focus({ preventScroll: true }); } catch (e) {} },
            onGrab: () => { if (this._annotStaffTimer) this._annotCommit(ed); },
            audio: this._annotAudio()
        };
    }

    // Réglages communs à tous les cadres de dessin d'une zone (ui/draw-block.js) : leurs outils sont une fenêtre à part, la barre de texte reste rangée.
    _annotDrawOpts(ed) {
        return {
            isEditable: () => this._annotIsEditable(ed),
            canvas: () => ed.__canvas,
            keepOpen: (t) => !!(t && t.closest && t.closest('.cn-draw-pop, .jam-annot-tools')),
            onChange: () => { this._annotMoveUndo = false; this._annotMoveRedo = false; this._annotStaffChanged(ed); },
            onMoved: () => { this._annotMoveUndo = true; this._annotMoveRedo = false; this._annotCommit(ed); },
            onActivate: () => { this._annotQuiet = true; this.annotActivate(ed); this._annotStaffMode(false); this._annotRefreshState(); },
            onDeactivate: () => this._annotRefreshState(),
            onFocusBack: () => { try { ed.focus({ preventScroll: true }); } catch (e) {} },
            onGrab: () => { if (this._annotStaffTimer) this._annotCommit(ed); }
        };
    }

    // Place d'un nouveau bloc : celle qu'on a indiquée (double-clic), ramenée dans la zone, ou la première place libre en cascade.
    _annotNewSpot(ed, at, w) {
        const cv = ed.__canvas;
        const pos = at ? { x: at.x, y: at.y } : acFreeSpot(cv ? cv.blocks().map(b => cv.rectOf(b)) : []);
        pos.x = Math.max(0, Math.min(pos.x, Math.max(0, acCanvasWidth(ed) - w - 12)));
        pos.y = Math.max(0, pos.y);
        return pos;
    }

    // Bouton « Cadre » de la barre (ou double-clic sur le fond de la zone) : un cadre de texte vide à la place indiquée, ouvert en édition.
    annotInsertFrame(at, ed) {
        if (!ed) { if (!this._annotEnsureActive()) return; ed = this._annotActive; }
        if (!this._annotIsEditable(ed)) return;
        if (ed.querySelectorAll('.annot-frame').length >= NOTE_MAX_FRAMES) return;
        this._annotLeaveFrame(); // un seul cadre en édition à la fois
        const w = 24; // un nouveau cadre a la taille d'un caractère (largeur automatique) : il s'allonge avec le texte
        const before = new Set(ed.querySelectorAll('.annot-frame'));
        const holder = document.createElement('div');
        holder.innerHTML = noteFrameStubHtml({ w, auto: true }, this._annotNewSpot(ed, at && Number.isFinite(at.x) ? at : null, w), undefined, false);
        ed.appendChild(holder.firstChild);
        this._annotHydrate(ed);
        const added = Array.from(ed.querySelectorAll('.annot-frame')).find(el => !before.has(el));
        if (added && added.__noteFrame) { added.__noteFrame.activate(); added.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        this._annotStaffChanged(ed);
    }

    // Réglages de lecture d'un nouveau bloc (portée ou accords) : ceux du dernier bloc créé (tempo, swing, instrument tels qu'il les joue) ;
    // sans bloc sur la page, ceux du carnet (en-tête). Chaque bloc garde ensuite les siens.
    _annotNewBlockSettings(ed) {
        const base = this.doc.settings;
        let last = this._annotLastBlock && this._annotLastBlock.isConnected && ed.contains(this._annotLastBlock) ? this._annotLastBlock : null;
        if (!last) { const all = ed.querySelectorAll('.annot-staff, .annot-chords'); last = all.length ? all[all.length - 1] : null; }
        const v = last && (last.__noteStaff || last.__chordBlock);
        const st = v && v.st;
        return {
            bpm: (st && st.bpm) || base.bpm,
            swing: (st && st.swing) || base.swing,
            instr: (st && st.instr) || base.instrument
        };
    }

    // Bouton « Dessin » de la barre : un cadre de dessin vide à la première place libre de la zone, ses outils ouverts.
    annotInsertDraw() {
        if (!this._annotEnsureActive()) return;
        const ed = this._annotActive;
        if (!this._annotIsEditable(ed)) return;
        if (ed.querySelectorAll('.annot-draw').length >= NOTE_MAX_DRAWS) return;
        this._annotLeaveFrame();
        const before = new Set(ed.querySelectorAll('.annot-draw'));
        const holder = document.createElement('div');
        const st = drawDefault();
        st.bg = 't';   // fond transparent par défaut
        holder.innerHTML = drawStubHtml(st, this._annotNewSpot(ed, null, st.w), true);
        ed.appendChild(holder.firstChild);
        this._annotHydrate(ed);
        const added = Array.from(ed.querySelectorAll('.annot-draw')).find(el => !before.has(el));
        if (added && added.__drawBlock) { added.__drawBlock.activate(); added.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        this._annotStaffChanged(ed);
    }

    // Bouton « Accords » de la barre : un bloc d'accords (do majeur, 4 temps) à la première place libre de la zone, son éditeur ouvert.
    annotInsertChords() {
        if (!this._annotEnsureActive()) return;
        const ed = this._annotActive;
        if (!this._annotIsEditable(ed)) return;
        if (ed.querySelectorAll('.annot-chords').length >= NOTE_MAX_CHORDS) return;
        this._annotLeaveFrame();
        const before = new Set(ed.querySelectorAll('.annot-chords'));
        const holder = document.createElement('div');
        holder.innerHTML = chordsStubHtml(chordsDefault(this._annotNewBlockSettings(ed)), this._annotNewSpot(ed, null, 120), false);
        ed.appendChild(holder.firstChild);
        this._annotHydrate(ed);
        const added = Array.from(ed.querySelectorAll('.annot-chords')).find(el => !before.has(el));
        if (added) this._annotLastBlock = added;
        if (added && added.__chordBlock) { added.__chordBlock.activate(); added.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        this._annotStaffChanged(ed);
    }

    // Une portée est active : ses outils remplacent ceux du texte dans la barre (et inversement).
    _annotStaffMode(on) {
        const bar = document.getElementById('jam-annot-bar');
        if (bar) bar.classList.toggle('staff-mode', !!on);
        if (on && typeof acIsPhone === 'function' && acIsPhone()) this._annotRevealStaff();
    }

    // Téléphone : la portée qui s'ouvre occupe toute sa zone ; on fait défiler la page pour que cette zone apparaisse juste sous la barre d'outils
    // (collée en haut), de sorte que les outils et la portée se voient ensemble. Sans effet si la zone y est déjà.
    _annotRevealStaff() {
        const s = (typeof NSE_ACTIVE !== 'undefined') ? NSE_ACTIVE : null;
        const bar = document.getElementById('jam-annot-bar');
        const zone = s && s.el.closest('.jam-annot-text');
        if (!zone || !bar) return;
        const host = zone.closest('.jam-annot-zone') || zone;
        host.style.scrollMarginTop = `${Math.ceil(bar.getBoundingClientRect().height) + 6}px`;
        const r = host.getBoundingClientRect(), br = bar.getBoundingClientRect();
        if (r.top >= br.bottom && r.bottom <= window.innerHeight) return;
        try { host.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { host.scrollIntoView(); }
    }

    // Reconstruit les blocs d'une zone (portées, cadres). Une annotation écrite avant les canevas (texte libre et blocs rangés dans le texte) est
    // convertie : voir _annotMigrate.
    _annotHydrate(ed) {
        if (!ed.__canvas && typeof AnnotCanvas === 'function') new AnnotCanvas(ed, this._annotCanvasOpts(ed));
        this._annotBindZoom(ed);
        const legacy = this._annotIsLegacy(ed);
        if (legacy && !ed.clientWidth) return; // zone cachée : impossible de mesurer la mise en page, on attend qu'elle s'affiche
        if (legacy) { ed.classList.add('legacy-flow'); this._annotWrapLoose(ed); }
        if (typeof hydrateNoteStaves === 'function') hydrateNoteStaves(ed, this._annotStaffOpts(ed));
        if (typeof hydrateNoteFrames === 'function') hydrateNoteFrames(ed, this._annotFrameOpts(ed));
        if (typeof hydrateChordBlocks === 'function') hydrateChordBlocks(ed, this._annotChordOpts(ed));
        if (typeof hydrateDrawBlocks === 'function') hydrateDrawBlocks(ed, this._annotDrawOpts(ed));
        if (legacy) this._annotMigrate(ed);
        this._annotApplyZoom(ed);
    }

    // L'annotation contient-elle du texte libre, ou des blocs qui n'ont pas encore de place sur le canevas (data-at) ?
    _annotIsLegacy(ed) {
        const blank = (t) => !/\S/.test(String(t || '').replace(/ /g, ' '));
        for (const n of Array.from(ed.childNodes)) {
            if (n.nodeType === 3) { if (!blank(n.nodeValue)) return true; continue; }
            if (n.nodeType !== 1 || n.classList.contains('annot-overlay') || n.tagName === 'BR') continue;
            if (n.classList.contains('annot-staff') || n.classList.contains('annot-frame') || n.classList.contains('annot-chords') || n.classList.contains('annot-draw')) { if (!n.hasAttribute('data-at')) return true; continue; }
            if (!blank(n.textContent) || n.querySelector('.annot-staff, .annot-frame, .annot-chords, .annot-draw')) return true;
        }
        return false;
    }

    // Ancienne annotation, 1re étape : le texte libre est rangé dans des cadres sans bord (un par passage de texte entre deux blocs),
    // les blocs rangés dans des enveloppes sont sortis de leur enveloppe.
    _annotWrapLoose(ed) {
        const isBlock = (n) => n.nodeType === 1 && (n.classList.contains('annot-staff') || n.classList.contains('annot-frame') || n.classList.contains('annot-chords') || n.classList.contains('annot-draw'));
        for (let again = true, guard = 0; again && guard++ < 20;) {
            again = false;
            Array.from(ed.children).forEach((n) => {
                if (!isBlock(n) && !n.classList.contains('annot-overlay') && n.querySelector('.annot-staff, .annot-frame, .annot-chords, .annot-draw')) {
                    while (n.firstChild) ed.insertBefore(n.firstChild, n);
                    n.remove();
                    again = true;
                }
            });
        }
        let run = [];
        const flush = () => {
            if (!run.length) return;
            if (run.some(n => /\S/.test(String(n.textContent || '').replace(/ /g, ' ')))) {
                const f = document.createElement('div');
                f.className = 'annot-frame';
                f.setAttribute('data-frame', String(Math.max(SN_FRAME_W_MIN, Math.min(SN_FRAME_W_MAX, ed.clientWidth - 24))));
                f.setAttribute('data-border', '0');
                ed.insertBefore(f, run[0]);
                run.forEach(n => f.appendChild(n));
            } else run.forEach(n => n.remove());
            run = [];
        };
        Array.from(ed.childNodes).forEach((n) => { if (isBlock(n) || (n.nodeType === 1 && n.classList.contains('annot-overlay'))) flush(); else run.push(n); });
        flush();
    }

    // Ancienne annotation, 2e étape : les blocs ont été mis en page comme avant (dans le texte, avec leur décalage) ; on relève la place de chacun
    // et on la lui donne en propre. La mise en page est ainsi reconstruite une seule fois, puis chaque bloc est indépendant.
    _annotMigrate(ed) {
        const spots = Array.from(ed.querySelectorAll(':scope > .annot-staff, :scope > .annot-frame, :scope > .annot-chords, :scope > .annot-draw'))
            .map(b => ({ v: b.__noteStaff || b.__noteFrame || b.__chordBlock || b.__drawBlock, x: b.offsetLeft, y: b.offsetTop }));
        ed.classList.remove('legacy-flow');
        spots.forEach(s => { if (s.v) s.v.setAt({ x: s.x, y: s.y }); });
    }

    // Les changements d'une portée sont enregistrés peu après le dernier (une seule entrée d'annulation pour une série de notes).
    _annotStaffChanged(ed) {
        if (this._annotStaffTimer) clearTimeout(this._annotStaffTimer);
        this._annotStaffTimer = setTimeout(() => { this._annotStaffTimer = null; this._annotCommit(ed); }, 600);
    }

    // Bouton « Portée » de la barre : une portée vide à la première place libre de la zone, ouverte en édition.
    annotInsertStaff() {
        if (!this._annotEnsureActive()) return;
        const ed = this._annotActive;
        if (!this._annotIsEditable(ed)) return;
        if (ed.querySelectorAll('.annot-staff').length >= NOTE_MAX_STAVES) return;
        this._annotLeaveFrame();
        const before = new Set(ed.querySelectorAll('.annot-staff'));
        const holder = document.createElement('div');
        holder.innerHTML = noteStaffStubHtml(Object.assign(staffDefault(), this._annotNewBlockSettings(ed)), this._annotNewSpot(ed, null, 260), false);
        ed.appendChild(holder.firstChild);
        this._annotHydrate(ed);
        const added = Array.from(ed.querySelectorAll('.annot-staff')).find(el => !before.has(el));
        if (added) this._annotLastBlock = added;
        if (added && added.__noteStaff) { added.__noteStaff.activate(); added.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
        this._annotStaffChanged(ed);
    }

    // ===== Colle propre au Carnet (une seule zone : la page affichée) =====
    _annotZoneEl() { return this.zone; }
    _annotZoneKey() { return 'page'; }

    // Mode édition de la page : cadre bleu, blocs déplaçables, barre de mise en forme. Hors édition la page se lit (zoom, écoute des portées).
    _annotSyncMode() {
        const ed = this.zone;
        if (!ed) return;
        const on = !!this.annotEdit.page;
        const was = this._annotIsEditable(ed);
        ed.setAttribute('data-can-edit', 'true');
        ed.setAttribute('data-editable', on ? 'true' : 'false');
        ed.tabIndex = on ? 0 : -1;
        ed.setAttribute('aria-readonly', on ? 'false' : 'true');
        ed.dataset.placeholder = on ? 'Double-cliquez pour ajouter un cadre de texte…' : 'Page vide — cliquez sur le crayon pour écrire';
        const zone = ed.closest('.jam-annot-zone');
        if (zone) {
            zone.classList.toggle('is-editing', on);
            const pen = zone.querySelector('[data-annot-mode]');
            if (pen) { pen.classList.toggle('is-on', on); pen.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        }
        if (was && !on) { // on quitte l'édition : texte validé, sélection vidée, barre rangée
            if (this._annotActive === ed) this.annotDeactivate();
            else if (ed.__canvas) ed.__canvas.clearSelection(true);
            if (ed.contains(document.activeElement)) { try { document.activeElement.blur(); } catch (e) {} }
        }
        this._annotRefreshZoomUi('page');
        this._annotSyncReadPlay();
    }

    // Lecture : hors édition, chaque portée garde un bouton ▶ pour l'écouter (en édition, ses outils ont leur propre bouton).
    // Ces boutons ne sont jamais enregistrés (annotationHtmlForSave reconstruit chaque bloc à partir de son seul texte).
    _annotSyncReadPlay() {
        const ed = this.zone;
        if (!ed) return;
        ed.querySelectorAll('.cn-staff-play').forEach((b) => b.remove());
        if (this._annotIsEditable(ed)) return;
        ed.querySelectorAll('.annot-staff, .annot-chords').forEach((el) => {
            const v = el.__noteStaff || el.__chordBlock;
            if (!v || (el.__noteStaff && (!v.st || !v.st.ev.length))) return;
            const what = el.__chordBlock ? 'les accords' : 'la portée';
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'cn-staff-play'; b.setAttribute('contenteditable', 'false');
            b.title = `Écouter ${what}`; b.setAttribute('aria-label', `Écouter ${what}`); b.textContent = '▶';
            b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
            b.addEventListener('click', (ev) => { ev.stopPropagation(); this._annotTogglePlay(el, b); });
            el.appendChild(b);
        });
    }

    _annotTogglePlay(el, b) {
        const v = el.__noteStaff || el.__chordBlock;
        if (!v) return;
        if (v.playing) { v.stop(); b.textContent = '▶'; b.classList.remove('is-on'); return; }
        this.zone.querySelectorAll('.annot-staff, .annot-chords').forEach((o) => { const ov = o.__noteStaff || o.__chordBlock; if (o !== el && ov && ov.playing) ov.stop(); });
        v.play();
        b.textContent = '■'; b.classList.add('is-on');
        const poll = setInterval(() => {
            if (!b.isConnected) { clearInterval(poll); return; }
            if (!v.playing) { clearInterval(poll); b.textContent = '▶'; b.classList.remove('is-on'); }
        }, 200);
    }

    // Son des portées : le piano de l'appli, au tempo du carnet, avec sa transposition (Ut, Si♭ ou Mi♭ : la hauteur écrite est transposée)
    // et, tant que la portée n'a pas son propre réglage, son swing.
    _annotAudio() {
        if (this._annotAudioApi) return this._annotAudioApi;
        this._annotAudioApi = {
            ready: () => {
                this.loadPiano();
                if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
                return Promise.resolve(this._pianoPromise || this.pianoInstrument).then(() => !!this.pianoInstrument);
            },
            // instr : instrument propre au bloc ('C', 'Bb', 'Eb') ; vide ou absent = celui du carnet
            play: (midi, after, duration, instr) => {
                try {
                    const tr = Object.prototype.hasOwnProperty.call(CARNET_TRANSPOSE, instr) ? instr : this.doc.settings.instrument;
                    return this.pianoInstrument.play(midiToName(midi + (CARNET_TRANSPOSE[tr] || 0)), this.audioCtx.currentTime + after,
                        { duration, destination: this.reverbInput || this.audioCtx.destination });
                } catch (e) { return null; }
            },
            bpm: () => this.doc.settings.bpm,
            swing: () => this.doc.settings.swing / 100 // 0,5 (droit) … 0,75
        };
        return this._annotAudioApi;
    }
}

// L'instance de l'appli : index.html y accède par `app` (boutons, barre de mise en forme).
const app = new CarnetApp();
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => app.init());
    else app.init();
}
