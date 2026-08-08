// ==UserScript==
// @name         Case Status SLA Color Guard — Loader
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Loads the Case Status SLA Color Guard.
// @author       Oday Emar
// @match        https://scripts.cisco.com/app/quicker_csone/case/*
// @updateURL    https://casereview.cc/sla.user.js
// @downloadURL  https://casereview.cc/sla.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      casereview.cc
// The wildcard grant for *.workers.dev hosts was removed in 1.0.1 — see
// the longer note in loader.user.js, including why the directive's literal
// text is not written out here. The guard talks to api.casereview.cc and
// the SFDC proxy named below, and to nothing else.
//
// NOTE FOR FUTURE EDITS: this block deliberately grants no more than it
// did in 1.0.0. Tampermonkey installs an update silently only while the
// requested permissions are unchanged; ADDING a @grant or @connect makes
// it show a confirmation window instead, which turns a silent update into
// a support conversation with every user. 1.1.0 clears its pre-signing
// cache by overwriting it rather than calling GM_deleteValue, purely to
// avoid needing that grant.
//
// The guard itself talks to the SFDC proxy. Tampermonkey attributes that
// request to THIS file once the code is eval'd here, so the grant has to
// live in the loader's metadata block, not in the fetched source — the
// fetched source's own ==UserScript== header is inert.
// @connect      quicker-sfdc-proxy.cisco.com
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ---- CONFIG ----
    const API_BASE      = 'https://api.casereview.cc';
    const LOADER_SECRET = 'cra_a1b2c3d4e5f6g7h8';
    const CHECKED_KEY   = 'slaLoaderCheckedAt';
    const SHA_KEY       = 'slaLoaderCachedSha';
    const CHECK_EVERY   = 60 * 60 * 1000;   // 1 hour

    // New in 1.1.0: holds { code, sig } rather than a bare code string.
    const CACHE_KEY     = 'slaLoaderSignedCache';
    const LEGACY_CACHE  = 'slaLoaderCachedCode';

    const SIG_HEADER    = 'x-cra-signature';

    // Public half of the release signing key — the same pair that signs
    // the review client. See the long note in loader.user.js for why this
    // exists and why publishing it is safe.
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

    // Fails closed on every error path: refusing to run is a broken
    // feature, running unverified code is a compromised browser.
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
            console.error('[SLA Loader] Signature check errored:', e);
            return false;
        }
    }

    // The guard only needs GM_xmlhttpRequest, but it is passed explicitly
    // for the same reason the review loader does it: code run through
    // new Function() does not inherit the sandbox's GM_* bindings.
    function runCode(code, sourceLabel) {
        try {
            const fn = new Function('GM_xmlhttpRequest', 'GM_setValue', 'GM_getValue', code);
            fn(
                (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest : undefined,
                (typeof GM_setValue !== 'undefined') ? GM_setValue : undefined,
                (typeof GM_getValue !== 'undefined') ? GM_getValue : undefined
            );
            console.log('[SLA Loader] Guard executed (' + sourceLabel + ')');
            return true;
        } catch (e) {
            console.error('[SLA Loader] Execution failed (' + sourceLabel + '):', e);
            return false;
        }
    }

    // The only path to runCode. Verified on every run, cache included, so
    // the cache does not have to be trusted.
    async function runVerified(entry, sourceLabel) {
        if (!entry || !(await verify(entry.code, entry.sig))) {
            console.error('[SLA Loader] REFUSED to run ' + sourceLabel +
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
            console.warn('[SLA Loader] ' + reason + ' → running cached copy.');
            return runVerified(cached, 'cache');
        }
        console.error('[SLA Loader] ' + reason + ' and no cached copy available.');
        return false;
    }

    // Verifies BEFORE caching, so a bad release cannot displace the last
    // known-good copy.
    function fetchScript(reason) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: API_BASE + '/sla/script?_=' + Date.now(),
            headers: { 'x-cra-key': LOADER_SECRET },
            timeout: 15000,
            onload: async (resp) => {
                if (resp.status < 200 || resp.status >= 300 || !resp.responseText) {
                    runFromCache('Fetch HTTP ' + resp.status);
                    return;
                }

                const sig = headerOf(resp, SIG_HEADER);
                if (!(await verify(resp.responseText, sig))) {
                    console.error('[SLA Loader] Downloaded guard FAILED signature verification. ' +
                                  'It was not cached and not run.');
                    runFromCache('Signature check failed');
                    return;
                }

                writeCache(resp.responseText, sig);
                set(CHECKED_KEY, Date.now());

                // Capture the sha from the ETag so the first revalidation
                // after a cold start does not redownload unnecessarily.
                // Cloudflare rewrites the Worker's strong ETag to a weak
                // one (W/"<sha>") when it compresses, so the W/ prefix is
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
            console.error('[SLA Loader] GM_xmlhttpRequest unavailable.');
            return;
        }
        if (typeof crypto === 'undefined' || !crypto.subtle) {
            console.error('[SLA Loader] WebCrypto unavailable — cannot verify the guard, ' +
                          'so nothing was run.');
            return;
        }

        // One-time cleanup of the pre-1.1.0 unsigned cache. Overwritten
        // rather than deleted: GM_deleteValue is not granted here, and
        // adding that grant would make Tampermonkey prompt on update.
        if (get(LEGACY_CACHE, null)) {
            set(LEGACY_CACHE, '');
            console.log('[SLA Loader] Discarded the pre-signing cache; fetching a signed copy.');
        }

        const cached    = readCache();
        const lastCheck = get(CHECKED_KEY, 0);

        // First run on this machine: nothing to do but fetch. This is the one
        // path where the guard starts later than document-start — it cannot
        // colour a status that has already painted, so on a cold install the
        // effect appears on the next page load rather than this one. Every
        // user takes this path once, on upgrade to 1.1.0.
        if (!cached) { fetchScript('remote (cold)'); return; }

        // Inside the hourly window: run instantly, no network at all.
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
            url: API_BASE + '/sla/version?_=' + Date.now(),
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
                    url: API_BASE + '/sla/script?_=' + Date.now(),
                    headers: { 'x-cra-key': LOADER_SECRET },
                    timeout: 15000,
                    onload: async (r2) => {
                        if (r2.status < 200 || r2.status >= 300 || !r2.responseText) return;

                        const sig = headerOf(r2, SIG_HEADER);
                        if (!(await verify(r2.responseText, sig))) {
                            console.error('[SLA Loader] Update FAILED signature verification; ' +
                                          'keeping the current copy.');
                            return;
                        }
                        writeCache(r2.responseText, sig);
                        set(SHA_KEY, meta.sha);
                        console.log('[SLA Loader] Updated to ' +
                                    (meta.version || meta.sha.slice(0, 8)) + '; active on next load.');
                    }
                });
            }
        });
    }

    main();
})();
