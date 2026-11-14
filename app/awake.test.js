// Tests de awake.js : maintien de l'écran allumé, avec de faux navigateur et document.
const test = require('node:test');
const assert = require('node:assert/strict');
const { awakeCreate, AWAKE_VIDEO } = require('./awake.js');

function fakeDoc(visibility = 'visible') {
    const added = [];
    return {
        visibilityState: visibility, added,
        body: { appendChild: (e) => added.push(e) },
        createElement: (tag) => {
            const attrs = {}; const el = { tag, attrs, style: {}, paused: true, plays: 0, setAttribute: (k, v) => { attrs[k] = v; } };
            el.play = () => { el.plays++; el.paused = false; return Promise.resolve(); };
            return el;
        }
    };
}
function fakeNav(behaviour = 'ok') {
    const locks = [];
    return { locks, wakeLock: { request: async (type) => {
        if (behaviour === 'deny') throw Object.assign(new Error('refus'), { name: 'NotAllowedError' });
        const handlers = {}; const lock = { type, released: false, addEventListener: (e, f) => { handlers[e] = f; }, release: () => { lock.released = true; if (handlers.release) handlers.release(); } };
        locks.push(lock); return lock;
    } } };
}

test('la vidéo de repli est une petite vidéo mp4 embarquée', () => {
    assert.match(AWAKE_VIDEO, /^data:video\/mp4;base64,[A-Za-z0-9+/=]+$/);
    assert.ok(AWAKE_VIDEO.length < 4000);
    assert.equal(Buffer.from(AWAKE_VIDEO.split(',')[1], 'base64').subarray(4, 8).toString(), 'ftyp');
});

test('API disponible : un verrou « screen » est pris, pas de vidéo', async () => {
    const nav = fakeNav(), doc = fakeDoc();
    const a = awakeCreate({ navigator: nav, document: doc });
    await a.acquire();
    assert.equal(nav.locks.length, 1);
    assert.equal(nav.locks[0].type, 'screen');
    assert.equal(a.state.mode, 'api');
    assert.equal(doc.added.length, 0);
    await a.acquire();                       // déjà tenu : pas de 2e demande
    assert.equal(nav.locks.length, 1);
});

test('retour sur la page : le verrou perdu en arrière-plan est repris', async () => {
    const nav = fakeNav(), doc = fakeDoc();
    const a = awakeCreate({ navigator: nav, document: doc });
    await a.acquire();
    doc.visibilityState = 'hidden'; nav.locks[0].release();     // le système le lâche quand la page est masquée
    assert.equal(doc.added.length, 0, 'masquée : pas de vidéo');
    await a.acquire();                                            // masquée : rien
    assert.equal(nav.locks.length, 1);
    doc.visibilityState = 'visible';
    await a.acquire();
    assert.equal(nav.locks.length, 2);
    assert.equal(a.state.lock, nav.locks[1]);
});

test('API refusée : repli sur la vidéo muette en boucle, une seule', async () => {
    const nav = fakeNav('deny'), doc = fakeDoc();
    const a = awakeCreate({ navigator: nav, document: doc });
    await a.acquire(); await a.acquire();
    assert.equal(doc.added.length, 1);
    const v = doc.added[0];
    assert.equal(v.tag, 'video');
    assert.equal(v.muted, true); assert.equal(v.loop, true);
    assert.ok('playsinline' in v.attrs);
    assert.equal(v.src, AWAKE_VIDEO);
    assert.ok(v.plays >= 1);
    assert.equal(a.state.mode, 'video');
});

test('pas d\'API (ancien iOS) : vidéo ; elle est relancée au geste suivant si elle ne jouait pas', async () => {
    const doc = fakeDoc();
    const a = awakeCreate({ navigator: {}, document: doc });
    await a.acquire();
    const v = doc.added[0];
    v.paused = true;                         // iOS a refusé de la lancer sans geste
    await a.acquire();
    assert.equal(doc.added.length, 1);
    assert.ok(v.plays >= 2 && v.paused === false);
});

test('appli installée sur iOS : l\'API ET la vidéo', async () => {
    const nav = fakeNav(), doc = fakeDoc();
    const a = awakeCreate({ navigator: nav, document: doc, standalone: true, ios: true });
    await a.acquire();
    assert.equal(nav.locks.length, 1);
    assert.equal(doc.added.length, 1);
    const b = awakeCreate({ navigator: fakeNav(), document: fakeDoc(), standalone: true, ios: false });
    await b.acquire();
    assert.equal(b.state.mode, 'api');       // installée mais pas sur iOS : l'API suffit
});

test('verrou lâché alors que la page est visible : bascule sur la vidéo', async () => {
    const nav = fakeNav(), doc = fakeDoc();
    const a = awakeCreate({ navigator: nav, document: doc });
    await a.acquire();
    nav.locks[0].release();
    assert.equal(doc.added.length, 1);
});

test('page masquée au démarrage : rien n\'est pris', async () => {
    const nav = fakeNav(), doc = fakeDoc('hidden');
    const a = awakeCreate({ navigator: nav, document: doc });
    await a.acquire();
    assert.equal(nav.locks.length, 0); assert.equal(doc.added.length, 0);
});
