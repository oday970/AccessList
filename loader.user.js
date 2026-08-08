// ==UserScript==
// @name         Cisco Case Review Assistant — Loader
// @namespace    http://tampermonkey.net/
// @version      0.30.0
// @description  Loads the Case Review Assistant script.
// @author       Oday (odemar@cisco.com)
// @match        https://scripts.cisco.com/app/quicker_csone/case/*
// @match        https://ss.estarta.com/CaseReview/*
// @updateURL    https://casereview.cc/loader.user.js
// @downloadURL  https://casereview.cc/loader.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addValueChangeListener
// @connect      casereview.cc
// NOTE: the wildcard grant for *.workers.dev hosts was removed in 0.29.1.
// It let the fetched client talk to EVERY host under that domain, which is
// a broad exfiltration path for code this loader executes with GM_*
// privileges and never verifies. Nothing needs it: cra.user.js builds
// every URL from API_BASE = 'https://api.casereview.cc' (see its
// LB_WORKER_URL). If the API ever moves back to such a hostname, add a
// grant naming that exact host rather than the wildcard.
//
// The directive's literal text is deliberately not written out anywhere in
// this block: metadata parsers differ on how strictly they anchor a
// directive to the start of a line, and a commented-out grant that one
// engine ignores and another honours is the worst of both.
// TRANSITION GRANT — remove in a later version bump, after cutover.
// Between publishing this loader and merging the new client, the Worker still
// serves the OLD client, which fetches auth.json from raw.githubusercontent.com.
// Tampermonkey attributes that request to THIS file, so without this grant
// every user gets a permission prompt on every auth sync for the whole
// ~24h propagation window. The new client never calls this host.
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ---- CONFIG ----
    const API_BASE      = 'https://api.casereview.cc';
    const LOADER_SECRET = 'cra_a1b2c3d4e5f6g7h8';
    const CHECKED_KEY   = 'craLoaderCheckedAt';
    const SHA_KEY       = 'craLoaderCachedSha';
    const CHECK_EVERY   = 60 * 60 * 1000;   // 1 hour

    /* Cache key changed in 0.30.0. The old one held a bare code string
       with no signature beside it; this one holds { code, sig }. A new
       key rather than a format sniff on the old one, so there is no
       chance of mistaking the first line of an unsigned script for a
       signature. The old entry is deleted on first run. */
    const CACHE_KEY     = 'craLoaderSignedCache';
    const LEGACY_CACHE  = 'craLoaderCachedCode';

    const SIG_HEADER    = 'x-cra-signature';

    /* Release signing key. PUBLIC half — safe to publish, which is the
       point: it can verify a release but cannot create one.

       This loader executes whatever the API returns, with GM_* powers,
       inside an authenticated Cisco session. Before 0.30.0 nothing
       checked WHO wrote that code, so anyone who could change what the
       server returns -- via the GitHub repo, the GH_TOKEN, the
       Cloudflare account, or the KV namespace -- could run code in every
       reviewer's browser. Verifying here removes all four from the
       trusted set: the private key lives offline and is never uploaded
       anywhere, so a compromised server can at worst stop updates, not
       forge one.

       Rotating this key means republishing this file and waiting for it
       to propagate, so it is not a routine operation. */
    const PUBLIC_KEY_JWK = {
        kty: 'EC', crv: 'P-256',
        x: 's979RwgXLmn3pmEcZK9HlTLi14_o2PMx997xS7dUXOs',
        y: 'iiF4eFA8O_yCmSIs7Qe_F1B9Ugk4D1NcalaE4HrqOxY'
    };
    // ----------------

    const get = (key, def) => { try { return GM_getValue(key, def); } catch (e) { return def; } };
    const set = (key, val) => { try { GM_setValue(key, val); } catch (e) {} };

    const b64ToBytes = (b64) => {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    };

    let verifyKey = null;
    async function getVerifyKey() {
        if (!verifyKey) {
            verifyKey = await crypto.subtle.importKey(
                'jwk', PUBLIC_KEY_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
            );
        }
        return verifyKey;
    }

    /* Any failure here -- bad signature, malformed base64, missing
       WebCrypto -- returns false, and every caller treats false as "do
       not run". Failing closed is the whole design: refusing to run is a
       broken feature, running unverified code is a compromised browser
       inside a Cisco case session. */
    async function verify(code, sigB64) {
        try {
            if (!code || !sigB64) return false;
            return await crypto.subtle.verify(
                { name: 'ECDSA', hash: 'SHA-256' },
                await getVerifyKey(),
                b64ToBytes(sigB64),
                new TextEncoder().encode(code)
            );
        } catch (e) {
            console.error('[CRA Loader] Signature check errored:', e);
            return false;
        }
    }

    function runCode(code, sourceLabel) {
        try {
            // Explicitly pass the GM_* functions so code run via new Function() can see them.
            const fn = new Function(
                'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues',
                'GM_openInTab', 'GM_xmlhttpRequest', 'GM_setClipboard', 'GM_addValueChangeListener',
                code
            );
            fn(
                (typeof GM_setValue !== 'undefined') ? GM_setValue : undefined,
                (typeof GM_getValue !== 'undefined') ? GM_getValue : undefined,
                (typeof GM_deleteValue !== 'undefined') ? GM_deleteValue : undefined,
                (typeof GM_listValues !== 'undefined') ? GM_listValues : undefined,
                (typeof GM_openInTab !== 'undefined') ? GM_openInTab : undefined,
                (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest : undefined,
                (typeof GM_setClipboard !== 'undefined') ? GM_setClipboard : undefined,
                (typeof GM_addValueChangeListener !== 'undefined') ? GM_addValueChangeListener : undefined
            );
            console.log('[CRA Loader] Script executed (' + sourceLabel + ')');
            return true;
        } catch (e) {
            console.error('[CRA Loader] Execution failed (' + sourceLabel + '):', e);
            return false;
        }
    }

    /* The only path to runCode. Verifying on EVERY run, including from
       cache, is deliberate: it means the cache does not have to be
       trusted. Anything able to write Tampermonkey storage still cannot
       produce a signature, so a tampered cache is rejected rather than
       executed. It costs about a millisecond. */
    async function runVerified(entry, sourceLabel) {
        if (!entry || !(await verify(entry.code, entry.sig))) {
            console.error('[CRA Loader] REFUSED to run ' + sourceLabel +
                          ': signature did not verify. Nothing was executed.');
            return false;
        }
        return runCode(entry.code, sourceLabel);
    }

    function readCache() {
        const raw = get(CACHE_KEY, null);
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            return (parsed && parsed.code && parsed.sig) ? parsed : null;
        } catch (e) { return null; }
    }

    const writeCache = (code, sig) => set(CACHE_KEY, JSON.stringify({ code, sig }));

    const headerOf = (resp, name) => {
        const re = new RegExp('^' + name + ':\\s*(.+)$', 'im');
        const m = re.exec(resp.responseHeaders || '');
        return m ? m[1].trim() : null;
    };

    async function runFromCache(reason) {
        const cached = readCache();
        if (cached) {
            console.warn('[CRA Loader] ' + reason + ' → running cached copy.');
            return runVerified(cached, 'cache');
        }
        console.error('[CRA Loader] ' + reason + ' and no cached copy available.');
        return false;
    }

    /* Fetches, verifies, and only then caches. Order matters: caching
       before verifying would persist whatever the server sent, and every
       later page load would re-reject it while the last good copy was
       already gone. */
    function fetchScript(reason) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: API_BASE + '/script?_=' + Date.now(),
            headers: { 'x-cra-key': LOADER_SECRET },
            timeout: 15000,
            onload: async (resp) => {
                if (resp.status < 200 || resp.status >= 300 || !resp.responseText) {
                    runFromCache('Fetch HTTP ' + resp.status);
                    return;
                }

                const sig = headerOf(resp, SIG_HEADER);
                if (!(await verify(resp.responseText, sig))) {
                    // The last known-good cached copy is left untouched
                    // and used instead, so a bad or unsigned release
                    // degrades to "no update" rather than "no script".
                    console.error('[CRA Loader] Downloaded script FAILED signature verification. ' +
                                  'It was not cached and not run.');
                    runFromCache('Signature check failed');
                    return;
                }

                writeCache(resp.responseText, sig);
                set(CHECKED_KEY, Date.now());

                // /script responds with an ETag containing the sha (see
                // worker/src/routes/client.js). Capture it so a cold start
                // records the sha it just fetched; without this the first
                // revalidation always sees a null SHA_KEY, treats the
                // script as changed, and re-downloads it for nothing.
                // Cloudflare rewrites the strong ETag to a weak one
                // (W/"<sha>") when it compresses, so the prefix is
                // tolerated here.
                try {
                    const etag = /^etag:\s*(?:W\/)?"?([^"\r\n]+)"?/im.exec(resp.responseHeaders || '');
                    if (etag) set(SHA_KEY, etag[1]);
                } catch (e) {}

                runCode(resp.responseText, reason);   // already verified above
            },
            onerror:   () => runFromCache('Network error'),
            ontimeout: () => runFromCache('Timed out')
        });
    }

    async function main() {
        if (typeof GM_xmlhttpRequest !== 'function') {
            console.error('[CRA Loader] GM_xmlhttpRequest unavailable.');
            return;
        }
        // No WebCrypto means no way to check what we are about to run.
        // Refuse rather than fall back to running it unverified.
        if (typeof crypto === 'undefined' || !crypto.subtle) {
            console.error('[CRA Loader] WebCrypto unavailable — cannot verify the script, ' +
                          'so nothing was run.');
            return;
        }

        // One-time cleanup of the pre-0.30.0 unsigned cache.
        if (get(LEGACY_CACHE, null)) {
            try { GM_deleteValue(LEGACY_CACHE); } catch (e) {}
            console.log('[CRA Loader] Discarded the pre-signing cache; fetching a signed copy.');
        }

        const cached    = readCache();
        const lastCheck = get(CHECKED_KEY, 0);

        // No verified copy — nothing to run but a fresh fetch. This is
        // also the path every user takes once, on upgrade to 0.30.0.
        if (!cached) { fetchScript('remote (cold)'); return; }

        // Inside the hourly window: run instantly, no network at all. This is
        // what keeps the Worker under 100,000 requests/day — fetching on
        // every page load costs ~21,000/day at 700 users, and it also removes
        // a blocking round-trip from the case page.
        if (Date.now() - lastCheck < CHECK_EVERY) {
            await runVerified(cached, 'cache (fresh)');
            return;
        }

        // Past the window: run the cache immediately anyway, then check for a
        // new version in the background. The user never waits on the network;
        // a change lands on the next page load.
        await runVerified(cached, 'cache (revalidating)');

        GM_xmlhttpRequest({
            method: 'GET',
            url: API_BASE + '/version?_=' + Date.now(),
            headers: { 'x-cra-key': LOADER_SECRET },
            timeout: 8000,
            onload: (resp) => {
                if (resp.status < 200 || resp.status >= 300) return;
                let meta = null;
                try { meta = JSON.parse(resp.responseText); } catch (e) { return; }
                if (!meta || !meta.sha) return;

                set(CHECKED_KEY, Date.now());
                if (meta.sha === get(SHA_KEY, null)) return;   // unchanged

                GM_xmlhttpRequest({
                    method: 'GET',
                    url: API_BASE + '/script?_=' + Date.now(),
                    headers: { 'x-cra-key': LOADER_SECRET },
                    timeout: 15000,
                    onload: async (r2) => {
                        if (r2.status < 200 || r2.status >= 300 || !r2.responseText) return;

                        const sig = headerOf(r2, SIG_HEADER);
                        if (!(await verify(r2.responseText, sig))) {
                            console.error('[CRA Loader] Update FAILED signature verification; ' +
                                          'keeping the current copy.');
                            return;
                        }
                        writeCache(r2.responseText, sig);
                        set(SHA_KEY, meta.sha);
                        console.log('[CRA Loader] Updated to ' +
                                    (meta.version || meta.sha.slice(0, 8)) + '; active on next load.');
                    }
                });
            }
        });
    }

    main();
})();
