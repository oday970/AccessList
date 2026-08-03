// ==UserScript==
// @name         Cisco Case Review Assistant — Loader
// @namespace    http://tampermonkey.net/
// @version      0.29.0
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
// @connect      workers.dev
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ---- CONFIG ----
    const API_BASE      = 'https://api.casereview.cc';
    const LOADER_SECRET = 'cra_a1b2c3d4e5f6g7h8';
    const CACHE_KEY     = 'craLoaderCachedCode';
    const SHA_KEY       = 'craLoaderCachedSha';
    const CHECKED_KEY   = 'craLoaderCheckedAt';
    const CHECK_EVERY   = 60 * 60 * 1000;   // 1 hour
    // ----------------

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

    const get = (key, def) => { try { return GM_getValue(key, def); } catch (e) { return def; } };
    const set = (key, val) => { try { GM_setValue(key, val); } catch (e) {} };

    function runFromCache(reason) {
        const cached = get(CACHE_KEY, null);
        if (cached) {
            console.warn('[CRA Loader] ' + reason + ' → running cached copy.');
            runCode(cached, 'cache');
        } else {
            console.error('[CRA Loader] ' + reason + ' and no cached copy available.');
        }
    }

    function fetchScript(reason) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: API_BASE + '/script?_=' + Date.now(),
            headers: { 'x-cra-key': LOADER_SECRET },
            timeout: 15000,
            onload: (resp) => {
                if (resp.status >= 200 && resp.status < 300 && resp.responseText) {
                    // Cache last-known-good BEFORE running, so a script
                    // that throws still leaves a usable copy behind.
                    set(CACHE_KEY, resp.responseText);
                    set(CHECKED_KEY, Date.now());

                    // /script responds with an ETag containing the sha (see
                    // worker/src/routes/client.js handleScript). Capture it
                    // here so cold start records the sha it just fetched.
                    // Without this, the first revalidation after any cold
                    // start always sees a null SHA_KEY, treats the script as
                    // changed, and re-downloads 327 KB unnecessarily. A
                    // missing/malformed ETag just leaves SHA_KEY unset,
                    // which degrades to that same harmless extra fetch.
                    try {
                        const etag = /^etag:\s*"?([^"\r\n]+)"?/im.exec(resp.responseHeaders || '');
                        if (etag) set(SHA_KEY, etag[1]);
                    } catch (e) {}

                    runCode(resp.responseText, reason);
                } else {
                    runFromCache('Fetch HTTP ' + resp.status);
                }
            },
            onerror:   () => runFromCache('Network error'),
            ontimeout: () => runFromCache('Timed out')
        });
    }

    if (typeof GM_xmlhttpRequest !== 'function') {
        console.error('[CRA Loader] GM_xmlhttpRequest unavailable.');
        return;
    }

    const cached    = get(CACHE_KEY, null);
    const lastCheck = get(CHECKED_KEY, 0);

    // No cached copy — nothing to run but a fresh fetch.
    if (!cached) { fetchScript('remote (cold)'); return; }

    // Inside the hourly window: run instantly, no network at all. This is
    // what keeps the Worker under 100,000 requests/day — fetching on
    // every page load costs ~21,000/day at 700 users, and it also removes
    // a blocking round-trip from the case page.
    if (Date.now() - lastCheck < CHECK_EVERY) {
        runCode(cached, 'cache (fresh)');
        return;
    }

    // Past the window: run the cache immediately anyway, then check for a
    // new version in the background. The user never waits on the network;
    // a change lands on the next page load.
    runCode(cached, 'cache (revalidating)');

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
                onload: (r2) => {
                    if (r2.status >= 200 && r2.status < 300 && r2.responseText) {
                        set(CACHE_KEY, r2.responseText);
                        set(SHA_KEY, meta.sha);
                        console.log('[CRA Loader] Updated to ' + (meta.version || meta.sha.slice(0, 8)) + '; active on next load.');
                    }
                }
            });
        }
    });
})();
