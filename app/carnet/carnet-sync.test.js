// Tests de carnet-sync.js : une fausse API GitHub (en mémoire, avec de vrais sha git et le refus des écritures sur un sha périmé)
// et deux ou trois « appareils » (chacun son stockage et ses carnets sauvegardés).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const S = require('./carnet-sync.js');
const F = require('./carnet-format.js');

// ---------- Fausse API GitHub ----------
class FakeGithub {
    constructor(owner = 'moi', repo = 'carnet-data', token = 'jeton') {
        this.owner = owner; this.repo = repo; this.token = token;
        this.files = new Map();   // chemin → { text, sha }
        this.blobs = new Map();   // sha → texte
        this.repoExists = true;
        this.log = [];
        this.hook = null;         // (method, route) → peut lever une erreur ou modifier le dépôt
        this.offline = false;
    }
    sha(text) { return crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex'); }
    set(path, text) { const sha = this.sha(text); this.files.set(path, { text, sha }); this.blobs.set(sha, text); return sha; }
    res(status, body, headers = {}) {
        return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body };
    }
    fetch = async (url, init) => {
        if (this.offline) throw new TypeError('Failed to fetch');
        const u = new URL(url);
        const prefix = `/repos/${this.owner}/${this.repo}`;
        assert.equal(u.origin, 'https://api.github.com');
        assert.equal(init.headers['Authorization'], `Bearer ${this.token}`);
        const method = init.method;
        if (!u.pathname.startsWith(prefix)) return this.res(404, { message: 'Not Found' });
        const route = u.pathname.slice(prefix.length);
        this.log.push(`${method} ${route}`);
        if (this.hook) { const r = this.hook(method, route); if (r) return r; }
        if (!this.repoExists) return this.res(404, { message: 'Not Found' });
        const body = init.body ? JSON.parse(init.body) : null;
        if (method === 'GET' && route === '') return this.res(200, { name: this.repo });
        if (method === 'GET' && route === '/contents/carnets') {
            const list = [...this.files].filter(([p]) => p.startsWith('carnets/')).map(([p, f]) => ({ name: p.slice(8), path: p, sha: f.sha, type: 'file' }));
            return list.length ? this.res(200, list) : this.res(404, { message: 'Not Found' });
        }
        let m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(route);
        if (method === 'GET' && m) {
            const t = this.blobs.get(m[1]);
            return t === undefined ? this.res(404, { message: 'Not Found' }) : this.res(200, { encoding: 'base64', content: Buffer.from(t).toString('base64').replace(/(.{60})/g, '$1\n') });
        }
        m = /^\/contents\/(.+)$/.exec(route);
        if (m) {
            const path = decodeURIComponent(m[1]);
            const cur = this.files.get(path);
            if (method === 'PUT') {
                if (cur && body.sha !== cur.sha) return this.res(body.sha ? 409 : 422, { message: body.sha ? `${path} does not match ${cur.sha}` : 'Invalid request. "sha" wasn\'t supplied.' });
                if (!cur && body.sha) return this.res(404, { message: 'Not Found' });
                const text = Buffer.from(body.content, 'base64').toString('utf8');
                const sha = this.set(path, text);
                return this.res(cur ? 200 : 201, { content: { sha, path } });
            }
            if (method === 'DELETE') {
                if (!cur) return this.res(404, { message: 'Not Found' });
                if (body.sha !== cur.sha) return this.res(409, { message: 'does not match' });
                this.files.delete(path);
                return this.res(200, {});
            }
        }
        return this.res(500, { message: 'route inconnue ' + method + ' ' + route });
    };
    names() { return [...this.files.values()].map(f => JSON.parse(f.text).name).sort(); }
    byName(name) { for (const [p, f] of this.files) { const j = JSON.parse(f.text); if (j.name === name) return { path: p, sha: f.sha, json: j }; } return null; }
}

// ---------- Appareils ----------
let clock = Date.UTC(2026, 10, 14, 14, 0, 0);
function device(server, opts = {}) {
    const store = new Map();
    const d = {
        saved: {},
        storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } },
        store,
        failWrite: false
    };
    d.sync = new S.CarnetSync({
        fetch: server.fetch, storage: d.storage,
        getSaved: () => d.saved,
        setSaved: (o) => { if (d.failWrite) return false; d.saved = o; return true; },
        now: () => new Date((clock += 60000))
    });
    if (opts.configure !== false) assert.equal(d.sync.setConfig('moi/carnet-data', 'jeton'), '');
    return d;
}
function carnet(title, text, extra) {
    const pages = [{ name: 'Page 1', html: `<div>${text}</div>` }].concat(extra ? [{ name: 'Page 2', html: `<div>${extra}</div>` }] : []);
    return S.csyCanon(title, { format: 'carnet-de-notes', version: 1, title, settings: F.defaultCarnetSettings(), pages });
}
const put = (d, title, text, extra) => { d.saved = Object.assign({}, d.saved, { [title]: carnet(title, text, extra) }); };
const text = (d, title) => d.saved[title].pages[0].html;

// ---------- Outils purs ----------
test('csyParseRepo accepte owner/repo et les adresses GitHub, refuse le reste', () => {
    assert.deepEqual(S.csyParseRepo('moi/carnet-data'), { owner: 'moi', repo: 'carnet-data' });
    assert.deepEqual(S.csyParseRepo(' https://github.com/moi/carnet-data.git '), { owner: 'moi', repo: 'carnet-data' });
    assert.deepEqual(S.csyParseRepo('https://github.com/moi/carnet-data/'), { owner: 'moi', repo: 'carnet-data' });
    for (const bad of ['', 'moi', 'moi/', '/repo', 'a/b/c', 'moi/..', 'moi/re po', '-moi/x', null, undefined]) assert.equal(S.csyParseRepo(bad), null, String(bad));
});

test('csyFileFor : chemin sûr, stable, distinct pour deux noms voisins', () => {
    const a = S.csyFileFor('Été 2026 / Jazz ♭'), b = S.csyFileFor('Ete 2026 - Jazz');
    assert.match(a, /^carnets\/[a-z0-9-]+-[a-z0-9]{1,10}\.json$/);
    assert.equal(a, S.csyFileFor('Été 2026 / Jazz ♭'));
    assert.notEqual(a, b);
    assert.match(S.csyFileFor('♭♭♭'), /^carnets\/carnet-/);
});

test('base64 : aller-retour avec accents, emoji et gros texte', () => {
    const t = 'Héllo ♭♯ 🎷 ' + 'é'.repeat(100000);
    assert.equal(S.csyB64Decode(S.csyB64Encode(t)), t);
    assert.equal(S.csyB64Decode(Buffer.from('abc\ndef').toString('base64').replace(/(.{2})/g, '$1\n')), 'abc\ndef');
});

// ---------- Synchro ----------
test('non configurée : pas de réseau, erreur claire', async () => {
    const srv = new FakeGithub();
    const d = device(srv, { configure: false });
    const r = await d.sync.sync();
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'config');
    assert.equal(srv.log.length, 0);
});

test('setConfig refuse un dépôt ou un jeton invalide', () => {
    const d = device(new FakeGithub(), { configure: false });
    assert.match(d.sync.setConfig('n importe quoi', 'x'), /Dépôt invalide/);
    assert.match(d.sync.setConfig('moi/depot', ''), /jeton/i);
    assert.match(d.sync.setConfig('moi/depot', 'a b'), /jeton/i);
    assert.equal(d.sync.isConfigured(), false);
    assert.equal(d.sync.setConfig('https://github.com/moi/depot', ' ghp_abc '), '');
    assert.deepEqual(d.sync.getConfig(), { owner: 'moi', repo: 'depot', repoText: 'moi/depot', token: 'ghp_abc' });
});

test('première synchro : les carnets d’ici partent dans le dépôt (dépôt neuf, dossier absent)', async () => {
    const srv = new FakeGithub();
    const A = device(srv);
    put(A, 'Standards', 'All the things'); put(A, 'Été ♭', 'accents');
    const r = await A.sync.sync();
    assert.equal(r.ok, true);
    assert.deepEqual(r.pushed.sort(), ['Standards', 'Été ♭']);
    assert.deepEqual(srv.names(), ['Standards', 'Été ♭'].sort());
    assert.equal(srv.byName('Standards').json.carnet.pages[0].html, text(A, 'Standards'));
    // seconde synchro sans rien changer : aucune écriture
    const before = srv.log.length;
    const r2 = await A.sync.sync();
    assert.deepEqual([r2.pushed, r2.pulled, r2.deleted, r2.conflicts], [[], [], [], []]);
    assert.equal(srv.log.slice(before).filter(x => !x.startsWith('GET')).length, 0);
    assert.equal(S.csyDescribe(r2), 'À jour');
});

test('un second appareil récupère les carnets, puis suit les modifications dans les deux sens', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'Standards', 'v1');
    await A.sync.sync();
    const rb = await B.sync.sync();
    assert.deepEqual(rb.pulled, ['Standards']);
    assert.deepEqual(B.saved['Standards'], A.saved['Standards']);
    // B modifie → A reçoit
    put(B, 'Standards', 'v2 sur B');
    assert.deepEqual((await B.sync.sync()).pushed, ['Standards']);
    const ra = await A.sync.sync();
    assert.deepEqual(ra.pulled, ['Standards']);
    assert.equal(text(A, 'Standards'), '<div>v2 sur B</div>');
    // A modifie → B reçoit
    put(A, 'Standards', 'v3 sur A');
    await A.sync.sync();
    assert.deepEqual((await B.sync.sync()).pulled, ['Standards']);
    assert.equal(text(B, 'Standards'), '<div>v3 sur A</div>');
    // pas d'aller-retour inutile ensuite
    const r = await B.sync.sync();
    assert.deepEqual([r.pushed, r.pulled], [[], []]);
});

test('le contenu n’est téléchargé que pour les fichiers dont le sha a changé', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'Un', '1'); put(A, 'Deux', '2');
    await A.sync.sync(); await B.sync.sync();
    put(A, 'Deux', '2bis'); await A.sync.sync();
    srv.log.length = 0;
    await B.sync.sync();
    assert.equal(srv.log.filter(x => x.startsWith('GET /git/blobs')).length, 1);
});

test('conflit : les deux versions sont gardées, la version d’ici garde le nom', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'Standards', 'base'); await A.sync.sync(); await B.sync.sync();
    put(A, 'Standards', 'édité sur A'); put(B, 'Standards', 'édité sur B');
    await A.sync.sync();                                  // A part le premier
    const rb = await B.sync.sync();                       // B tombe sur un conflit
    assert.equal(rb.conflicts.length, 1);
    const { name, copy } = rb.conflicts[0];
    assert.equal(name, 'Standards');
    assert.match(copy, /^Standards \(conflit \d\d\/\d\d \d\d:\d\d\)$/);
    assert.equal(text(B, 'Standards'), '<div>édité sur B</div>');
    assert.equal(text(B, copy), '<div>édité sur A</div>');
    assert.equal(B.saved[copy].title, copy);
    // le dépôt a les deux, et A les retrouve
    assert.deepEqual(srv.names(), ['Standards', copy].sort());
    assert.equal(srv.byName('Standards').json.carnet.pages[0].html, '<div>édité sur B</div>');
    const ra = await A.sync.sync();
    assert.deepEqual(ra.pulled.sort(), ['Standards', copy].sort());
    assert.equal(text(A, 'Standards'), '<div>édité sur B</div>');
    assert.equal(text(A, copy), '<div>édité sur A</div>');
});

test('première synchro avec le même nom des deux côtés : identique → rien ; différent → conflit sans perte', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'Même', 'pareil'); put(A, 'Autre', 'A');
    await A.sync.sync();
    put(B, 'Même', 'pareil'); put(B, 'Autre', 'B');
    const rb = await B.sync.sync();
    assert.deepEqual(rb.linked, ['Même']);
    assert.equal(rb.conflicts.length, 1);
    assert.equal(rb.conflicts[0].name, 'Autre');
    assert.equal(text(B, 'Autre'), '<div>B</div>');
    assert.equal(text(B, rb.conflicts[0].copy), '<div>A</div>');
});

test('suppression voulue ici → supprimée dans le dépôt, puis chez les autres', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'Garde', 'g'); put(A, 'Jette', 'j');
    await A.sync.sync(); await B.sync.sync();
    delete A.saved['Jette'];
    assert.equal(A.sync.noteDeleted('Jette'), true);
    const ra = await A.sync.sync();
    assert.deepEqual(ra.deletedRemote, ['Jette']);
    assert.deepEqual(srv.names(), ['Garde']);
    const rb = await B.sync.sync();
    assert.deepEqual(rb.deleted, ['Jette']);
    assert.deepEqual(Object.keys(B.saved), ['Garde']);
});

test('suppression ici alors que l’autre appareil a modifié depuis : la modification l’emporte', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'X', 'v1'); await A.sync.sync(); await B.sync.sync();
    put(B, 'X', 'v2'); await B.sync.sync();
    delete A.saved['X']; A.sync.noteDeleted('X');
    const ra = await A.sync.sync();
    assert.deepEqual(ra.deletedRemote, []);
    assert.deepEqual(ra.pulled, ['X']);
    assert.equal(text(A, 'X'), '<div>v2</div>');
    assert.deepEqual(srv.names(), ['X']);
});

test('supprimé ailleurs mais modifié ici depuis : le carnet est renvoyé, pas perdu', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'X', 'v1'); await A.sync.sync(); await B.sync.sync();
    delete B.saved['X']; B.sync.noteDeleted('X'); await B.sync.sync();
    assert.deepEqual(srv.names(), []);
    put(A, 'X', 'v2 modifié sur A');
    const ra = await A.sync.sync();
    assert.deepEqual(ra.pushed, ['X']);
    assert.deepEqual(srv.names(), ['X']);
    assert.equal(text(A, 'X'), '<div>v2 modifié sur A</div>');
});

test('supprimé puis recréé sous le même nom avant la synchro : remplacé, pas de conflit', async () => {
    const srv = new FakeGithub();
    const A = device(srv);
    put(A, 'X', 'v1'); await A.sync.sync();
    delete A.saved['X']; A.sync.noteDeleted('X');
    put(A, 'X', 'neuf');
    const r = await A.sync.sync();
    assert.deepEqual(r.pushed, ['X']);
    assert.deepEqual(r.conflicts, []);
    assert.equal(srv.byName('X').json.carnet.pages[0].html, '<div>neuf</div>');
});

test('le carnet ouvert avec des modifications non sauvegardées n’est pas écrasé (busyName)', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'X', 'v1'); await A.sync.sync(); await B.sync.sync();
    put(B, 'X', 'v2'); await B.sync.sync();
    const ra = await A.sync.sync({ busyName: 'X' });
    assert.deepEqual(ra.pulled, []);
    assert.deepEqual(ra.skipped, ['X']);
    assert.equal(text(A, 'X'), '<div>v1</div>');
    // une fois le carnet sauvegardé avec ses modifs, la synchro voit le conflit et garde tout
    put(A, 'X', 'v1 retouché');
    const r2 = await A.sync.sync();
    assert.equal(r2.conflicts.length, 1);
    assert.equal(text(A, 'X'), '<div>v1 retouché</div>');
    assert.equal(text(A, r2.conflicts[0].copy), '<div>v2</div>');
});

test('busyName protège aussi d’une suppression venue d’un autre appareil', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'X', 'v1'); put(A, 'Y', 'y'); await A.sync.sync(); await B.sync.sync();
    delete B.saved['X']; B.sync.noteDeleted('X'); await B.sync.sync();
    const ra = await A.sync.sync({ busyName: 'X' });
    assert.deepEqual(ra.deleted, []);
    assert.ok(A.saved['X']);
});

test('un carnet modifié ici pendant la synchro n’est pas écrasé par ce qu’on récupère', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'X', 'v1'); put(A, 'Z', 'z1'); await A.sync.sync(); await B.sync.sync();
    put(B, 'X', 'v2 B'); await B.sync.sync();
    put(A, 'Z', 'z2');   // A a un envoi à faire (Z) : c'est pendant cet envoi que l'utilisateur sauvegarde une retouche de X
    srv.hook = (method) => { if (method === 'PUT') { put(A, 'X', 'v1 retouché pendant'); srv.hook = null; } return null; };
    const ra = await A.sync.sync();
    assert.deepEqual(ra.pulled, []);
    assert.deepEqual(ra.skipped, ['X']);
    assert.deepEqual(ra.pushed, ['Z']);
    assert.equal(text(A, 'X'), '<div>v1 retouché pendant</div>');
    const r2 = await A.sync.sync(); // la fois suivante : conflit propre, rien de perdu
    assert.equal(r2.conflicts.length, 1);
    assert.equal(text(A, r2.conflicts[0].copy), '<div>v2 B</div>');
});

test('sha périmé à l’envoi : retry demandé et état intact', async () => {
    const srv = new FakeGithub();
    const A = device(srv);
    put(A, 'X', 'v1'); await A.sync.sync();
    put(A, 'X', 'v2');
    // le dépôt change sous les pieds d'A pendant l'écriture
    srv.hook = (method) => { if (method === 'PUT') { srv.hook = null; srv.set(srv.byName('X').path, JSON.stringify({ name: 'X', carnet: carnet('X', 'v-ailleurs') })); } return null; };
    const r = await A.sync.sync();
    assert.equal(r.ok, true);
    assert.equal(r.retry, true);
    assert.deepEqual(r.pushed, []);
    const r2 = await A.sync.sync();
    assert.equal(r2.conflicts.length, 1);
    assert.equal(text(A, 'X'), '<div>v2</div>');
    assert.equal(text(A, r2.conflicts[0].copy), '<div>v-ailleurs</div>');
});

test('réseau coupé : erreur claire, carnets et état intacts, reprise ensuite', async () => {
    const srv = new FakeGithub();
    const A = device(srv);
    put(A, 'X', 'v1');
    srv.offline = true;
    const r = await A.sync.sync();
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'network');
    assert.match(A.sync.lastSync().message, /connexion/);
    assert.equal(text(A, 'X'), '<div>v1</div>');
    srv.offline = false;
    const r2 = await A.sync.sync();
    assert.deepEqual(r2.pushed, ['X']);
    assert.equal(A.sync.lastSync().ok, true);
});

test('coupure en plein envoi : ce qui est déjà parti est mémorisé (pas de conflit fantôme ensuite)', async () => {
    const srv = new FakeGithub();
    const A = device(srv);
    put(A, 'A1', '1'); put(A, 'B2', '2'); put(A, 'C3', '3');
    let puts = 0;
    srv.hook = (method) => { if (method === 'PUT' && ++puts === 2) { srv.offline = true; } return null; };
    const r = await A.sync.sync();
    assert.equal(r.ok, false);
    assert.equal(r.pushed.length, 2);   // le 3e envoi tombe dans la coupure
    srv.offline = false; srv.hook = null;
    const r2 = await A.sync.sync();
    assert.equal(r2.ok, true);
    assert.equal(r2.pushed.length, 1);
    assert.deepEqual(r2.conflicts, []);
    assert.equal(srv.names().length, 3);
});

test('erreurs GitHub : jeton refusé, dépôt introuvable, droits insuffisants, limite atteinte', async () => {
    const srv = new FakeGithub();
    const A = device(srv);
    put(A, 'X', '1');
    srv.token = 'autre'; // le jeton d'A n'est plus accepté… la fausse API le vérifie par assert : on simule plutôt 401 par hook
    srv.token = 'jeton';
    srv.hook = () => srv.res(401, { message: 'Bad credentials' });
    assert.equal((await A.sync.sync()).error.code, 'auth');
    srv.hook = () => srv.res(403, { message: 'Resource not accessible by personal access token' });
    assert.equal((await A.sync.sync()).error.code, 'forbidden');
    srv.hook = () => srv.res(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
    assert.equal((await A.sync.sync()).error.code, 'rate');
    srv.hook = null; srv.repoExists = false;
    const r = await A.sync.sync();
    assert.equal(r.error.code, 'notfound');
    assert.match(r.error.message, /dépôt/i);
    assert.equal(text(A, 'X'), '<div>1</div>');
});

test('changer de dépôt repart de zéro sans rien supprimer', async () => {
    const srv = new FakeGithub();
    const A = device(srv);
    put(A, 'X', '1'); await A.sync.sync();
    const srv2 = new FakeGithub('moi', 'autre-depot', 'jeton');
    A.sync.fetch = srv2.fetch;
    assert.equal(A.sync.setConfig('moi/autre-depot', 'jeton'), '');
    const r = await A.sync.sync();
    assert.deepEqual(r.pushed, ['X']);
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(srv.names(), ['X']); // l'ancien dépôt n'est pas touché
});

test('dépôt vidé à la main : on ne supprime pas en masse les carnets d’ici', async () => {
    const srv = new FakeGithub();
    const A = device(srv);
    for (const n of ['a', 'b', 'c', 'd']) put(A, n, n);
    await A.sync.sync();
    srv.files.clear();
    const r = await A.sync.sync();
    assert.equal(r.suspect, 4);
    assert.deepEqual(r.deleted, []);
    assert.equal(Object.keys(A.saved).length, 4);
});

test('carnets illisibles : ignorés dans le dépôt, laissés tels quels ici', async () => {
    const srv = new FakeGithub();
    const A = device(srv);
    srv.set('carnets/n-importe-quoi.json', '{pas du json');
    srv.set('carnets/autre.json', JSON.stringify({ name: 'Faux', carnet: { format: 'autre-chose', pages: [] } }));
    srv.set('carnets/doublon-1.json', JSON.stringify({ name: 'Dup', carnet: carnet('Dup', '1') }));
    srv.set('carnets/doublon-2.json', JSON.stringify({ name: 'Dup', carnet: carnet('Dup', '2') }));
    A.saved = { Abîmé: { n: 'importe quoi' } };
    const r = await A.sync.sync();
    assert.equal(r.ok, true);
    assert.deepEqual(r.pulled, ['Dup']);
    assert.equal(r.ignored.length, 3);
    assert.deepEqual(A.saved['Abîmé'], { n: 'importe quoi' });
});

test('stockage plein : l’écriture locale échoue, aucune meta fausse (la synchro suivante réessaie)', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    put(A, 'X', 'v1'); await A.sync.sync();
    B.failWrite = true;
    const rb = await B.sync.sync();
    assert.equal(rb.ok, false);
    assert.equal(rb.error.code, 'storage');
    B.failWrite = false;
    const rb2 = await B.sync.sync();
    assert.deepEqual(rb2.pulled, ['X']);
    assert.ok(B.saved['X']);
});

test('deux synchros en même temps : une seule tournée', async () => {
    const srv = new FakeGithub();
    const A = device(srv);
    put(A, 'X', '1');
    const [r1, r2] = await Promise.all([A.sync.sync(), A.sync.sync()]);
    assert.equal(r1, r2);
    assert.equal(srv.log.filter(x => x.startsWith('PUT')).length, 1);
});

test('toutes les requêtes passent par api.github.com avec le jeton et sans cache sur les lectures de liste', async () => {
    const srv = new FakeGithub();
    const urls = [];
    const A = device(srv);
    const orig = srv.fetch;
    A.sync.fetch = async (url, init) => { urls.push(url); return orig(url, init); };
    put(A, 'X', '1'); await A.sync.sync(); await A.sync.sync();
    assert.ok(urls.length >= 3);
    assert.ok(urls.every(u => u.startsWith('https://api.github.com/repos/moi/carnet-data')));
    assert.ok(urls.filter(u => u.includes('/contents/carnets?')).every(u => /_=\d+/.test(u)));
});

test('gros carnet avec dessin : aller-retour intact', async () => {
    const srv = new FakeGithub();
    const A = device(srv), B = device(srv);
    const big = 'é'.repeat(7000);
    put(A, 'Gros', big, 'page deux'); await A.sync.sync();
    await B.sync.sync();
    assert.deepEqual(B.saved['Gros'], A.saved['Gros']);
    assert.equal(B.saved['Gros'].pages.length, 2);
});

test('csyDescribe', () => {
    const base = { pushed: [], pulled: [], deleted: [], deletedRemote: [], conflicts: [], skipped: [], suspect: 0 };
    assert.equal(S.csyDescribe(base), 'À jour');
    assert.equal(S.csyDescribe(Object.assign({}, base, { pushed: ['a'], pulled: ['b', 'c'] })), '1 envoyé, 2 reçus');
    assert.match(S.csyDescribe(Object.assign({}, base, { conflicts: [{}] })), /1 conflit/);
    assert.equal(S.csyDescribe({ error: { message: 'Oups' } }), 'Oups');
});
