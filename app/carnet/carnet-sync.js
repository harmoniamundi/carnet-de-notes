// carnet/carnet-sync.js — synchronisation des carnets sauvegardés entre appareils, via un dépôt GitHub privé (API « contents »).
// Sans DOM : tout ce qui touche à l'écran est dans carnet-engine.js. Le réseau (fetch) et le stockage sont injectés, ce qui permet de tout tester
// avec une fausse API GitHub (carnet-sync.test.js).
//
// Principe : chaque carnet sauvegardé (menu « Ouvrir ») est un fichier `carnets/<nom>-<empreinte>.json` du dépôt. Pour chaque carnet, on se souvient de
// l'état de la DERNIÈRE synchro réussie (« meta » : chemin du fichier, sha GitHub, empreinte du contenu local). À la synchro suivante :
//   - seul le local a changé    → on envoie ;
//   - seul le dépôt a changé    → on récupère ;
//   - les deux ont changé       → conflit : rien n'est perdu, la version du dépôt est gardée à côté sous « Nom (conflit JJ/MM HH:mm) » ;
//   - supprimé volontairement ici (noteDeleted) → supprimé dans le dépôt ; supprimé dans le dépôt par un autre appareil → supprimé ici (sauf si modifié ici depuis).
// Ce qui n'a pas été sauvegardé (le brouillon) n'est jamais envoyé. Le jeton ne sert qu'à api.github.com.
// Chargé par index.html via <script src="app/carnet/carnet-sync.js"> (après carnet-format.js) et testé par carnet-sync.test.js.

const CSY_FMT = (typeof sanitizeCarnet !== 'undefined')
    ? { sanitizeCarnet, carnetToFile, carnetCleanText, CARNET_TITLE_MAX }
    : require('./carnet-format.js');

const CSY_API = 'https://api.github.com';
const CSY_DIR = 'carnets';
const CSY_KEYS = { cfg: 'carnetSyncCfg', state: 'carnetSyncState' };
const CSY_TIMEOUT_MS = 30000;

// ===== Outils purs =====

// Empreinte courte d'un texte (deux FNV-1a 32 bits de graines différentes + longueur) : sert à savoir si un carnet a changé, pas à la sécurité.
function csyHash(str) {
    let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e3779b9;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
        b = (b ^ (b >>> 13)) >>> 0;
    }
    return a.toString(36) + b.toString(36) + '.' + str.length.toString(36);
}

// Chemin du fichier d'un carnet : lisible (nom simplifié) et sans collision (empreinte du nom exact).
function csyFileFor(name) {
    const slug = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'carnet';
    return `${CSY_DIR}/${slug}-${csyHash(String(name).normalize('NFC')).replace(/[^a-z0-9]/g, '').slice(0, 10)}.json`;
}

function csyB64Encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

function csyB64Decode(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

// « owner/repo » ou une adresse https://github.com/owner/repo(.git) → { owner, repo } ; null si ce n'est pas un dépôt valide.
function csyParseRepo(text) {
    let s = String(text || '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})$/.exec(s);
    if (!m || m[2] === '.' || m[2] === '..') return null;
    return { owner: m[1], repo: m[2] };
}

// Un carnet venu de l'extérieur (ou du stockage) sous sa forme canonique pour ce nom : nettoyé, titre = nom. null si ce n'est pas un carnet.
function csyCanon(name, raw) {
    const c = CSY_FMT.sanitizeCarnet(raw);
    if (!c) return null;
    c.title = name;
    return CSY_FMT.carnetToFile(c);
}

function csySig(file) { return JSON.stringify(file); }

// Contenu d'un fichier du dépôt → { name, carnet } (carnet canonique), ou null s'il n'est pas lisible.
function csyReadRemote(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const name = CSY_FMT.carnetCleanText(parsed.name, CSY_FMT.CARNET_TITLE_MAX);
    if (!name) return null;
    const carnet = csyCanon(name, parsed.carnet);
    return carnet ? { name, carnet } : null;
}

function csyPayload(name, file, now) {
    return JSON.stringify({ app: 'carnet-de-notes', syncVersion: 1, name, savedAt: now.toISOString(), carnet: file }, null, 1);
}

function csyStamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

class CsyError extends Error {
    constructor(code, message) { super(message); this.name = 'CsyError'; this.code = code; }
}

// ===== Client GitHub (les seules routes utilisées : contents, git/blobs, repo) =====
class CsyGithub {
    constructor(fetchImpl, token, owner, repo) {
        this.fetch = fetchImpl;
        this.token = token;
        this.base = `${CSY_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    }

    async _req(method, path, body, noCache) {
        let url = this.base + path;
        if (noCache) url += (url.includes('?') ? '&' : '?') + '_=' + Date.now(); // l'API répond avec un cache de 60 s : on le contourne
        const init = { method, headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };
        if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
        let timer = null;
        if (typeof AbortController !== 'undefined') {
            const ctrl = new AbortController();
            init.signal = ctrl.signal;
            timer = setTimeout(() => ctrl.abort(), CSY_TIMEOUT_MS);
        }
        let res;
        try { res = await this.fetch(url, init); }
        catch (e) { throw new CsyError('network', 'Pas de connexion à GitHub (réseau coupé ou trop lent).'); }
        finally { if (timer) clearTimeout(timer); }
        if (res.ok) {
            try { return { status: res.status, data: await res.json() }; }
            catch (e) { throw new CsyError('http', 'Réponse illisible de GitHub.'); }
        }
        let msg = '';
        try { const j = await res.json(); msg = j && j.message ? String(j.message) : ''; } catch (e) {}
        const st = res.status;
        if (st === 401) throw new CsyError('auth', 'Jeton refusé par GitHub (incorrect ou expiré).');
        if (st === 403 || st === 429) {
            const rem = res.headers && res.headers.get ? res.headers.get('x-ratelimit-remaining') : null;
            if (st === 429 || rem === '0' || /rate limit/i.test(msg)) throw new CsyError('rate', 'Limite de requêtes GitHub atteinte : réessayez dans un moment.');
            throw new CsyError('forbidden', 'Accès refusé : le jeton doit avoir la permission « Contents : Read and write » sur ce dépôt.');
        }
        if (st === 404) throw new CsyError('notfound', 'Introuvable sur GitHub (dépôt inexistant, ou jeton sans accès à ce dépôt).');
        if (st === 409 || (st === 422 && /sha/i.test(msg))) throw new CsyError('conflict', 'Le fichier a changé entre-temps sur GitHub.');
        throw new CsyError('http', `GitHub a répondu ${st}${msg ? ' : ' + msg : ''}.`);
    }

    async checkRepo() { await this._req('GET', '', undefined, true); }

    // Fichiers du dossier des carnets : [{ name, sha, type }] ; null si le dossier n'existe pas encore.
    async listDir() {
        try {
            const { data } = await this._req('GET', `/contents/${CSY_DIR}`, undefined, true);
            return Array.isArray(data) ? data.map(f => ({ name: f.name, sha: f.sha, type: f.type })) : [];
        } catch (e) {
            if (e.code === 'notfound') return null;
            throw e;
        }
    }

    // Contenu d'un fichier désigné par son sha (immuable, donc cohérent avec la liste ; jusqu'à 100 Mo).
    async getBlob(sha) {
        const { data } = await this._req('GET', `/git/blobs/${encodeURIComponent(sha)}`);
        if (!data || typeof data.content !== 'string') throw new CsyError('http', 'Fichier illisible sur GitHub.');
        return csyB64Decode(data.content);
    }

    async putFile(path, text, sha, message) {
        const body = { message, content: csyB64Encode(text) };
        if (sha) body.sha = sha;
        const { data } = await this._req('PUT', '/contents/' + path.split('/').map(encodeURIComponent).join('/'), body);
        if (!data || !data.content || !data.content.sha) throw new CsyError('http', 'Réponse inattendue de GitHub.');
        return data.content.sha;
    }

    async deleteFile(path, sha, message) {
        await this._req('DELETE', '/contents/' + path.split('/').map(encodeURIComponent).join('/'), { message, sha });
    }
}

// ===== La synchro =====
class CarnetSync {
    // opts : fetch (comme window.fetch), storage ({getItem,setItem,removeItem}), getSaved() → { nom: fichier }, setSaved(obj) → bool, now() → Date.
    constructor(opts) {
        this.fetch = opts.fetch;
        this.storage = opts.storage;
        this.getSaved = opts.getSaved;
        this.setSaved = opts.setSaved;
        this.now = opts.now || (() => new Date());
        this._running = null;
    }

    _read(key) { try { return JSON.parse(this.storage.getItem(key) || 'null'); } catch (e) { return null; } }
    _write(key, v) { try { this.storage.setItem(key, JSON.stringify(v)); return true; } catch (e) { return false; } }

    // ----- Réglages (dépôt + jeton, propres à cet appareil) -----
    getConfig() {
        const c = this._read(CSY_KEYS.cfg);
        if (!c || typeof c.token !== 'string' || !c.token) return null;
        const r = csyParseRepo(c.repo);
        return r ? { owner: r.owner, repo: r.repo, repoText: `${r.owner}/${r.repo}`, token: c.token } : null;
    }

    isConfigured() { return !!this.getConfig(); }

    // Enregistre le dépôt et le jeton ; renvoie un message d'erreur, ou '' si tout va bien. Changer de dépôt repart de zéro (rien n'est supprimé).
    setConfig(repoText, token) {
        const r = csyParseRepo(repoText);
        if (!r) return 'Dépôt invalide : écrivez « votre-identifiant/nom-du-dépôt ».';
        const t = String(token || '').trim();
        if (!t || /\s/.test(t)) return 'Collez le jeton GitHub (sans espaces).';
        if (!this._write(CSY_KEYS.cfg, { repo: `${r.owner}/${r.repo}`, token: t })) return "Impossible d'enregistrer les réglages dans ce navigateur.";
        return '';
    }

    // Arrête la synchro sur cet appareil : le jeton est oublié, les carnets restent là (ici comme dans le dépôt).
    clearConfig() {
        try { this.storage.removeItem(CSY_KEYS.cfg); this.storage.removeItem(CSY_KEYS.state); } catch (e) {}
    }

    _state(repoText) {
        const s = this._read(CSY_KEYS.state);
        if (s && s.repo === repoText && s.meta && typeof s.meta === 'object' && s.pending && typeof s.pending === 'object') return s;
        return { repo: repoText, meta: {}, pending: {}, last: null };
    }

    _saveState(s) { this._write(CSY_KEYS.state, s); }

    lastSync() {
        const c = this.getConfig();
        return c ? (this._state(c.repoText).last || null) : null;
    }

    // Un carnet synchronisé vient d'être supprimé ici (suppression voulue) : la prochaine synchro le supprimera aussi du dépôt.
    noteDeleted(name) {
        const c = this.getConfig();
        if (!c) return false;
        const s = this._state(c.repoText);
        if (!s.meta[name]) return false;
        s.pending[name] = { file: s.meta[name].file, sha: s.meta[name].sha };
        delete s.meta[name];
        this._saveState(s);
        return true;
    }

    // ----- Synchro -----
    // opts.busyName : nom du carnet ouvert qui a des modifications non sauvegardées — la synchro n'y touche pas côté local.
    // Renvoie toujours un objet (jamais d'exception) :
    //   { ok, error?, pushed, pulled, deleted (ici), deletedRemote, conflicts: [{name, copy}], linked, skipped, ignored, retry, suspect }
    sync(opts) {
        if (this._running) return this._running;
        this._running = this._syncOnce(opts || {}).finally(() => { this._running = null; });
        return this._running;
    }

    async _syncOnce(opts) {
        const res = { ok: true, pushed: [], pulled: [], deleted: [], deletedRemote: [], conflicts: [], linked: [], skipped: [], ignored: [], retry: false, suspect: 0 };
        const cfg = this.getConfig();
        if (!cfg) { res.ok = false; res.error = { code: 'config', message: 'La synchro n’est pas configurée.' }; return res; }
        const state = this._state(cfg.repoText);
        try {
            await this._run(new CsyGithub(this.fetch, cfg.token, cfg.owner, cfg.repo), state, opts, res);
            state.last = { at: this.now().toISOString(), ok: true, message: csyDescribe(res) };
        } catch (e) {
            res.ok = false;
            res.error = { code: e && e.code ? e.code : 'error', message: e instanceof CsyError ? e.message : 'Erreur inattendue : ' + (e && e.message ? e.message : e) };
            state.last = { at: this.now().toISOString(), ok: false, code: res.error.code, message: res.error.message };
        } finally {
            this._saveState(state);
        }
        return res;
    }

    async _run(gh, state, opts, res) {
        const meta = state.meta, pending = state.pending;
        const now = this.now();
        const isConflict = (e) => e instanceof CsyError && e.code === 'conflict';

        // 1. Ce que contient le dépôt. Le contenu n'est téléchargé que pour les fichiers dont le sha a changé (ou qu'on ne connaît pas encore).
        let list = await gh.listDir();
        if (list === null) { await gh.checkRepo(); list = []; } // dossier absent : dépôt vide ou jeton sans accès (alors checkRepo échoue)
        const files = list.filter(f => f.type === 'file' && /\.json$/i.test(f.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const nameByFile = {};
        for (const n of Object.keys(meta)) nameByFile[meta[n].file] = n;
        for (const n of Object.keys(pending)) nameByFile[pending[n].file] = n;
        const remote = {};
        for (const f of files) {
            const path = `${CSY_DIR}/${f.name}`;
            const known = nameByFile[path];
            const knownSha = known ? (meta[known] || pending[known]).sha : null;
            const entry = { file: path, sha: f.sha, carnet: null };
            if (known) entry.name = known;
            if (knownSha !== f.sha) {
                let rec = null;
                try { rec = csyReadRemote(JSON.parse(await gh.getBlob(f.sha))); }
                catch (e) { if (e instanceof CsyError && e.code !== 'http') throw e; }
                if (!rec) { res.ignored.push(path); continue; }
                if (!known) entry.name = rec.name;
                entry.carnet = csyCanon(entry.name, rec.carnet) || rec.carnet;
            }
            if (remote[entry.name]) { res.ignored.push(path); continue; } // deux fichiers pour un même nom : on garde le premier
            remote[entry.name] = entry;
        }
        const load = async (entry) => {
            if (entry.carnet) return entry.carnet;
            const rec = csyReadRemote(JSON.parse(await gh.getBlob(entry.sha)));
            if (!rec) throw new CsyError('http', `Le fichier « ${entry.file} » du dépôt n'est pas un carnet.`);
            entry.carnet = csyCanon(entry.name, rec.carnet);
            return entry.carnet;
        };

        // 2. Les carnets d'ici (ceux qui ne sont pas lisibles ne sont pas touchés).
        const savedNow = this.getSaved();
        const local = {};
        for (const n of Object.keys(savedNow)) {
            const file = csyCanon(n, savedNow[n]);
            if (file) { const sig = csySig(file); local[n] = { file, sig, hash: csyHash(sig) }; }
        }

        // 3. Suppressions voulues ici.
        for (const n of Object.keys(pending)) {
            const p = pending[n], R = remote[n];
            if (local[n]) { meta[n] = { file: p.file, sha: p.sha, hash: '' }; delete pending[n]; continue; } // recréé depuis : traité comme modifié
            if (!R) { delete pending[n]; continue; }
            if (R.sha !== p.sha) { delete pending[n]; continue; }                                               // modifié ailleurs depuis : la modification l'emporte
            try { await gh.deleteFile(R.file, R.sha, `Suppression de « ${n} »`); delete pending[n]; delete remote[n]; res.deletedRemote.push(n); }
            catch (e) { if (isConflict(e)) res.retry = true; else throw e; }
        }

        // 4. Que faire de chaque carnet ?
        const names = Array.from(new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(meta)])).sort((a, b) => a.localeCompare(b, 'fr'));
        const plan = [];
        for (const n of names) {
            const L = local[n], R = remote[n], M = meta[n];
            const localChanged = !!L && (!M || L.hash !== M.hash);
            const remoteChanged = !!R && (!M || R.sha !== M.sha);
            const busy = n === opts.busyName;
            if (L && R) {
                if (R.carnet && csySig(R.carnet) === L.sig) plan.push({ n, act: 'link' });
                else if (!M) plan.push({ n, act: 'conflict' });
                else if (localChanged && remoteChanged) plan.push({ n, act: 'conflict' });
                else if (localChanged) plan.push({ n, act: 'push' });
                else if (remoteChanged) plan.push({ n, act: busy ? 'skip' : 'pull' });
            } else if (L) {
                if (!M || localChanged) plan.push({ n, act: 'push' });
                else plan.push({ n, act: busy ? 'skip' : 'delLocal' });
            } else if (R) {
                plan.push({ n, act: 'pull' });
            } else if (M) {
                delete meta[n];
            }
        }
        // Garde-fou : une série de suppressions locales d'un coup (plus de la moitié des carnets) est suspecte — on ne supprime rien.
        const dels = plan.filter(p => p.act === 'delLocal');
        if (dels.length >= 3 && dels.length * 2 >= Object.keys(meta).length) {
            res.suspect = dels.length;
            for (const p of dels) { p.act = 'skip'; }
        }

        // 5. Exécution, un carnet après l'autre (GitHub refuse les écritures simultanées).
        const saves = {};        // nom → fichier à écrire ici (null = supprimer)
        const deferredMeta = {}; // nom → meta à adopter une fois les carnets d'ici bien écrits (null = oublier)
        const kind = {};         // nom → 'pull' | 'del' (pour retirer du bilan ce qui n'a finalement pas été écrit)
        const commit = () => {
            if (!Object.keys(saves).length) return;
            const cur = Object.assign({}, this.getSaved());
            for (const n of Object.keys(saves)) {
                // Un carnet modifié ici pendant la synchro (ou illisible) n'est pas écrasé : il sera traité à la prochaine.
                const before = local[n] ? local[n].sig : null;
                let nowSig = null;
                if (cur[n] !== undefined) { const cf = csyCanon(n, cur[n]); nowSig = cf ? csySig(cf) : '?'; }
                if (before !== nowSig) {
                    res.skipped.push(n);
                    if (kind[n] === 'pull') res.pulled = res.pulled.filter(x => x !== n);
                    if (kind[n] === 'del') res.deleted = res.deleted.filter(x => x !== n);
                    delete saves[n]; delete deferredMeta[n];
                    continue;
                }
                if (saves[n] === null) delete cur[n]; else cur[n] = saves[n];
            }
            if (!Object.keys(saves).length) return;
            if (!this.setSaved(cur)) throw new CsyError('storage', "Impossible d'écrire les carnets dans ce navigateur (espace plein ?).");
            for (const n of Object.keys(deferredMeta)) { if (deferredMeta[n]) meta[n] = deferredMeta[n]; else delete meta[n]; }
        };
        const pushOne = async (n, file, path, sha, hash) => {
            const newSha = await gh.putFile(path, csyPayload(n, file, now), sha, `Carnet « ${n} »`);
            meta[n] = { file: path, sha: newSha, hash };
            res.pushed.push(n);
        };
        try {
            for (const p of plan) {
                const n = p.n, L = local[n], R = remote[n], M = meta[n];
                try {
                    if (p.act === 'link') { meta[n] = { file: R.file, sha: R.sha, hash: L.hash }; res.linked.push(n); }
                    else if (p.act === 'skip') { res.skipped.push(n); }
                    else if (p.act === 'push') {
                        const path = R ? R.file : (M ? M.file : csyFileFor(n));
                        await pushOne(n, L.file, path, R ? R.sha : undefined, L.hash);
                    } else if (p.act === 'pull') {
                        const c = await load(R);
                        saves[n] = c; kind[n] = 'pull';
                        deferredMeta[n] = { file: R.file, sha: R.sha, hash: csyHash(csySig(c)) };
                        res.pulled.push(n);
                    } else if (p.act === 'delLocal') {
                        saves[n] = null; kind[n] = 'del'; deferredMeta[n] = null;
                        res.deleted.push(n);
                    } else if (p.act === 'conflict') {
                        const theirs = await load(R);
                        const copy = this._copyName(n, now, Object.assign({}, this.getSaved(), saves, remote));
                        const copyFile = csyCanon(copy, theirs);
                        await pushOne(copy, copyFile, csyFileFor(copy), undefined, csyHash(csySig(copyFile)));
                        saves[copy] = copyFile;
                        await pushOne(n, L.file, R.file, R.sha, L.hash);
                        res.conflicts.push({ name: n, copy });
                    }
                } catch (e) {
                    if (isConflict(e)) res.retry = true; else throw e;
                }
            }
        } finally {
            // Même si la synchro s'arrête en route (réseau coupé…), ce qui a déjà été récupéré est écrit ici.
            commit();
        }
    }

    // Nom libre pour la copie d'un conflit : « Nom (conflit 14/11 15:02) », raccourci pour tenir dans la limite d'un titre.
    _copyName(name, now, taken) {
        const suffix = ` (conflit ${csyStamp(now)})`;
        const base = name.slice(0, CSY_FMT.CARNET_TITLE_MAX - suffix.length).trim();
        let cand = base + suffix, i = 2;
        while (Object.prototype.hasOwnProperty.call(taken, cand)) {
            const sfx = suffix.slice(0, -1) + ' ' + i + ')';
            cand = name.slice(0, CSY_FMT.CARNET_TITLE_MAX - sfx.length).trim() + sfx;
            i++;
        }
        return cand;
    }
}

// Phrase courte pour l'état de la synchro.
function csyDescribe(r) {
    if (!r) return '';
    if (r.error) return r.error.message;
    const parts = [];
    if (r.pushed.length) parts.push(`${r.pushed.length} envoyé${r.pushed.length > 1 ? 's' : ''}`);
    if (r.pulled.length) parts.push(`${r.pulled.length} reçu${r.pulled.length > 1 ? 's' : ''}`);
    const del = r.deleted.length + r.deletedRemote.length;
    if (del) parts.push(`${del} supprimé${del > 1 ? 's' : ''}`);
    if (r.conflicts.length) parts.push(`${r.conflicts.length} conflit${r.conflicts.length > 1 ? 's' : ''} (version de l'autre appareil gardée à côté)`);
    if (r.suspect) parts.push(`${r.suspect} suppressions ignorées (suspect : à vérifier)`);
    if (r.skipped.length) parts.push(`${r.skipped.length} en attente (carnet ouvert modifié)`);
    return parts.length ? parts.join(', ') : 'À jour';
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CSY_DIR, CSY_KEYS, CsyError, CsyGithub, CarnetSync, csyHash, csyFileFor, csyB64Encode, csyB64Decode, csyParseRepo, csyCanon, csyReadRemote, csyDescribe };
}
