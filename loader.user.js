// ==UserScript==
// @name         Cisco Case Review Assistant — Loader
// @namespace    http://tampermonkey.net/
// @version      0.27.0
// @description  Loads the Case Review Assistant script.
// @author       Oday (odemar@cisco.com)
// @match        https://scripts.cisco.com/app/quicker_csone/case/*
// @match        https://ss.estarta.com/CaseReview/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addValueChangeListener
// @connect      workers.dev
// @connect      raw.githubusercontent.com
// @connect      gist.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ---- CONFIG ----
    const WORKER_URL    = 'https://cra-loader.odayaamar97.workers.dev';
    const LOADER_SECRET = 'cra_a1b2c3d4e5f6g7h8';
    const CACHE_KEY     = 'craLoaderCachedCode';
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

    function runFromCache(reason) {
        let cached = null;
        try { cached = GM_getValue(CACHE_KEY, null); } catch (e) {}
        if (cached) {
            console.warn('[CRA Loader] ' + reason + ' → running cached copy.');
            runCode(cached, 'cache');
        } else {
            console.error('[CRA Loader] ' + reason + ' and no cached copy available.');
        }
    }

    if (typeof GM_xmlhttpRequest !== 'function') {
        console.error('[CRA Loader] GM_xmlhttpRequest unavailable.');
        return;
    }

    GM_xmlhttpRequest({
        method: 'GET',
        url: WORKER_URL + '?_=' + Date.now(),   // cache-bust
        headers: { 'x-cra-key': LOADER_SECRET },
        timeout: 8000,
        onload: (resp) => {
            if (resp.status >= 200 && resp.status < 300 && resp.responseText) {
                const code = resp.responseText;
                try { GM_setValue(CACHE_KEY, code); } catch (e) {}   // cache last-known-good first
                runCode(code, 'remote');
            } else {
                runFromCache('Fetch HTTP ' + resp.status);
            }
        },
        onerror:   () => runFromCache('Network error'),
        ontimeout: () => runFromCache('Timed out')
    });
})();
