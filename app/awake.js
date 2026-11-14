// awake.js — empêche la mise en veille de l'écran tant que l'appli est ouverte (iPhone, iPad, ordinateur).
//  1) L'API « Screen Wake Lock » (Safari 16.4+, Chrome, Edge…) : le verrou saute quand la page passe en arrière-plan, on le reprend au retour.
//  2) Repli : une vidéo muette de 32 px en boucle, invisible (technique « NoSleep »), qui empêche aussi la veille. Utilisée quand l'API manque ou refuse,
//     et en plus de l'API dans une appli ajoutée à l'écran d'accueil de l'iPhone / iPad (là, l'API a longtemps été sans effet).
// Sur iOS, la vidéo ne démarre qu'après un geste : on réessaie à chaque toucher / touche tant qu'elle ne joue pas.
// Chargé par index.html (après le moteur) ; la logique (awakeCreate) est testée par awake.test.js avec de faux navigateur et document.

const AWAKE_VIDEO = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANGbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAnB0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHobWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABk21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAVNzdGJsAAAAu3N0c2QAAAAAAAAAAQAAAKthdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMWF2Y0MBQsAe/+EAGGdCwB6mESWwEQAAAwABAAADAAgPFi4RgAEABmjIQgOSyAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAAsoAAALKAAAABhzdHRzAAAAAAAAAAEAAAAIAAAQAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAIAAAAAQAAADRzdHN6AAAAAAAAAAAAAAAIAAAChAAAAAoAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAUc3RjbwAAAAAAAAABAAADdgAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAwAAAACGZyZWUAAALSbWRhdAAAAm8GBf//a9xF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0xNiBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTMxIG1lPXVtaCBzdWJtZT0xMCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTI0IGNocm9tYV9tZT0xIHRyZWxsaXM9MiA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9OCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD04IHJjPWNyZiBtYnRyZWU9MSBjcmY9NDAuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAA1liIICXkxQABGfvrrwAAAABkGaHAS8sAAAAAZBmioBLywAAAAGQZo7AS8sAAAABkGaSQBLywAAAAZBmllAS8sAAAAGQZppgEfLAAAABkGaecBDyw==';

// env : { navigator, document, standalone (appli installée ?), ios (iPhone / iPad ?) } — injectés pour les tests.
function awakeCreate(env) {
    const nav = env.navigator, doc = env.document;
    const hasApi = !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function');
    const alsoVideo = !!(env.standalone && env.ios);      // appli installée sur iOS : l'API seule ne suffit pas toujours
    const st = { lock: null, video: null, pending: false, mode: 'none' };

    function startVideo() {
        if (!st.video) {
            const v = doc.createElement('video');
            v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.setAttribute('aria-hidden', 'true');
            v.muted = true; v.loop = true; v.tabIndex = -1;
            v.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:.01;pointer-events:none;';
            v.src = AWAKE_VIDEO;
            doc.body.appendChild(v);
            st.video = v;
        }
        if (st.video.paused) { try { const p = st.video.play(); if (p && p.catch) p.catch(() => { /* pas encore de geste : on réessaiera */ }); } catch (e) {} }
        if (st.mode === 'none') st.mode = 'video';
    }

    async function acquire() {
        if (doc.visibilityState === 'hidden') return;
        if (hasApi && !st.pending && !(st.lock && !st.lock.released)) {
            st.pending = true;
            try {
                const lock = await nav.wakeLock.request('screen');
                st.lock = lock; st.mode = 'api';
                if (lock.addEventListener) lock.addEventListener('release', () => {
                    if (st.lock === lock) st.lock = null;
                    if (doc.visibilityState !== 'hidden') startVideo();   // lâché sans que la page soit masquée : le système n'en veut plus, on passe à la vidéo
                });
            } catch (e) { startVideo(); }                              // refusé (économie d'énergie, appli installée…) : repli
            finally { st.pending = false; }
        }
        if (!hasApi || alsoVideo) startVideo();
    }

    return { acquire, state: st, hasApi };
}

function setupAwake() {
    if (typeof document === 'undefined' || typeof navigator === 'undefined') return;
    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPadOS se présente comme un Mac
    let standalone = false;
    try { standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches); } catch (e) {}
    const awake = awakeCreate({ navigator, document, standalone, ios });
    const go = () => { awake.acquire(); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') go(); });
    ['pointerdown', 'touchend', 'keydown', 'click'].forEach(ev => window.addEventListener(ev, go, { passive: true }));
    window.addEventListener('focus', go);
    go();
    window.__awake = awake; // pour le diagnostic (console)
}

if (typeof module !== 'undefined' && module.exports) module.exports = { awakeCreate, AWAKE_VIDEO };
else setupAwake();
