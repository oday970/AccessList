// ==UserScript==
// @name         Case Status SLA Color Guard — Loader
// @namespace    http://tampermonkey.net/
// @version      1.0.1
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
    const CACHE_KEY     = 'slaLoaderCachedCode';
    const SHA_KEY       = 'slaLoaderCachedSha';
    const CHECKED_KEY   = 'slaLoaderCheckedAt';
    const CHECK_EVERY   = 60 * 60 * 1000;   // 1 hour
    // ----------------

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

    const get = (key, def) => { try { return GM_getValue(key, def); } catch (e) { return def; } };
    const set = (key, val) => { try { GM_setValue(key, val); } catch (e) {} };

    function runFromCache(reason) {
        const cached = get(CACHE_KEY, null);
        if (cached) {
            console.warn('[SLA Loader] ' + reason + ' → running cached copy.');
            runCode(cached, 'cache');
        } else {
            console.error('[SLA Loader] ' + reason + ' and no cached copy available.');
        }
    }

    function fetchScript(reason) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: API_BASE + '/sla/script?_=' + Date.now(),
            headers: { 'x-cra-key': LOADER_SECRET },
            timeout: 15000,
            onload: (resp) => {
                if (resp.status >= 200 && resp.status < 300 && resp.responseText) {
                    // Cache last-known-good BEFORE running, so a guard that
                    // throws still leaves a usable copy behind.
                    set(CACHE_KEY, resp.responseText);
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
        console.error('[SLA Loader] GM_xmlhttpRequest unavailable.');
        return;
    }

    const cached    = get(CACHE_KEY, null);
    const lastCheck = get(CHECKED_KEY, 0);

    // First run on this machine: nothing to do but fetch. This is the one
    // path where the guard starts later than document-start — it cannot
    // colour a status that has already painted, so on a cold install the
    // effect appears on the next page load rather than this one.
    if (!cached) { fetchScript('remote (cold)'); return; }

    // Inside the hourly window: run instantly, no network at all.
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
                onload: (r2) => {
                    if (r2.status >= 200 && r2.status < 300 && r2.responseText) {
                        set(CACHE_KEY, r2.responseText);
                        set(SHA_KEY, meta.sha);
                        console.log('[SLA Loader] Updated to ' + (meta.version || meta.sha.slice(0, 8)) + '; active on next load.');
                    }
                }
            });
        }
    });
})();
