// ==UserScript==
// @name         Cisco Case Review Assistant — Loader
// @namespace    http://tampermonkey.net/
// @version      0.30.1
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
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE      = 'https://api.casereview.cc';
    const LOADER_SECRET = 'cra_a1b2c3d4e5f6g7h8';
    const CHECKED_KEY   = 'craLoaderCheckedAt';
    const SHA_KEY       = 'craLoaderCachedSha';
    const CHECK_EVERY   = 60 * 60 * 1000;

    const CACHE_KEY     = 'craLoaderSignedCache';
    const LEGACY_CACHE  = 'craLoaderCachedCode';

    const SIG_HEADER    = 'x-cra-signature';

    const PUBLIC_KEY_JWK = {
        kty: 'EC', crv: 'P-256',
        x: 's979RwgXLmn3pmEcZK9HlTLi14_o2PMx997xS7dUXOs',
        y: 'iiF4eFA8O_yCmSIs7Qe_F1B9Ugk4D1NcalaE4HrqOxY'
    };

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
                    console.error('[CRA Loader] Downloaded script FAILED signature verification. ' +
                                  'It was not cached and not run.');
                    runFromCache('Signature check failed');
                    return;
                }

                writeCache(resp.responseText, sig);
                set(CHECKED_KEY, Date.now());

                try {
                    const etag = /^etag:\s*(?:W\/)?"?([^"\r\n]+)"?/im.exec(resp.responseHeaders || '');
                    if (etag) set(SHA_KEY, etag[1]);
                } catch (e) {}

                runCode(resp.responseText, reason);
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
        if (typeof crypto === 'undefined' || !crypto.subtle) {
            console.error('[CRA Loader] WebCrypto unavailable — cannot verify the script, ' +
                          'so nothing was run.');
            return;
        }

        if (get(LEGACY_CACHE, null)) {
            try { GM_deleteValue(LEGACY_CACHE); } catch (e) {}
            console.log('[CRA Loader] Discarded the pre-signing cache; fetching a signed copy.');
        }

        const cached    = readCache();
        const lastCheck = get(CHECKED_KEY, 0);

        if (!cached) { fetchScript('remote (cold)'); return; }

        if (Date.now() - lastCheck < CHECK_EVERY) {
            await runVerified(cached, 'cache (fresh)');
            return;
        }

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
                if (meta.sha === get(SHA_KEY, null)) return;

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
