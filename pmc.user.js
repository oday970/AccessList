// ==UserScript==
// @name         PMC Closure Email — Loader
// @namespace    http://tampermonkey.net/
// @version      0.2.0
// @description  Loads the PMC / PMCT closure e-mail script on Quicker and pastes the drafted e-mail into Outlook web.
// @author       Oday (odemar@cisco.com)
// @match        https://scripts.cisco.com/app/quicker_csone/*
// @match        https://scripts.cisco.com/app/quicker/*
// @match        https://outlook.office.com/*
// @match        https://outlook.office365.com/*
// @match        https://outlook.cloud.microsoft/*
// @updateURL    https://casereview.cc/pmc.user.js
// @downloadURL  https://casereview.cc/pmc.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      casereview.cc
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    console.log('[PMC Loader] Loader started:', location.href);

    const API_BASE      = 'https://api.casereview.cc';
    const LOADER_SECRET = 'cra_a1b2c3d4e5f6g7h8';
    const CHECKED_KEY   = 'pmcLoaderCheckedAt';
    const SHA_KEY       = 'pmcLoaderCachedSha';
    const CHECK_EVERY   = 60 * 60 * 1000;

    const CACHE_KEY     = 'pmcLoaderSignedCache';

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
            console.error('[PMC Loader] Signature check errored:', e);
            return false;
        }
    }

    function runCode(code, sourceLabel) {
        try {
            const fn = new Function(
                'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_listValues',
                'GM_openInTab', 'GM_xmlhttpRequest', 'GM_setClipboard',
                code
            );
            fn(
                (typeof GM_setValue !== 'undefined') ? GM_setValue : undefined,
                (typeof GM_getValue !== 'undefined') ? GM_getValue : undefined,
                (typeof GM_deleteValue !== 'undefined') ? GM_deleteValue : undefined,
                (typeof GM_listValues !== 'undefined') ? GM_listValues : undefined,
                (typeof GM_openInTab !== 'undefined') ? GM_openInTab : undefined,
                (typeof GM_xmlhttpRequest !== 'undefined') ? GM_xmlhttpRequest : undefined,
                (typeof GM_setClipboard !== 'undefined') ? GM_setClipboard : undefined
            );
            console.log('[PMC Loader] Script executed (' + sourceLabel + ')');
            return true;
        } catch (e) {
            console.error('[PMC Loader] Execution failed (' + sourceLabel + '):', e);
            return false;
        }
    }

    async function runVerified(entry, sourceLabel) {
        if (!entry || !(await verify(entry.code, entry.sig))) {
            console.error('[PMC Loader] REFUSED to run ' + sourceLabel +
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
            console.warn('[PMC Loader] ' + reason + ' → running cached copy.');
            return runVerified(cached, 'cache');
        }
        console.error('[PMC Loader] ' + reason + ' and no cached copy available.');
        return false;
    }

    function fetchScript(reason) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: API_BASE + '/pmc/script?_=' + Date.now(),
            headers: { 'x-cra-key': LOADER_SECRET },
            timeout: 15000,
            onload: async (resp) => {
                if (resp.status < 200 || resp.status >= 300 || !resp.responseText) {
                    runFromCache('Fetch HTTP ' + resp.status);
                    return;
                }

                const sig = headerOf(resp, SIG_HEADER);
                if (!(await verify(resp.responseText, sig))) {
                    console.error('[PMC Loader] Downloaded script FAILED signature verification. ' +
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


    /* ============================================================
       OUTLOOK HALF -- lives in the loader, not the payload.

       outlook.office.com ships a Content-Security-Policy without
       'unsafe-eval', so on that host the new Function() used to run the
       signed payload is refused and nothing executes: the compose window
       opened by the deep link but the body was never pasted (0.1.0).
       Quicker's CSP allows eval, so the payload keeps running there.

       The code below is the payload's Outlook half, copied verbatim from
       cra-private/pmc.user.js (pendingDrafts .. runOutlook). It reads the
       draft the payload stashed in GM storage, finds the compose window
       with that subject, fills Cc and pastes the body. The storage
       contract with the payload: key 'pmc:draft:<id>', value
       { to, cc, subject, html, text, ts }, TTL 3 minutes.

       Keep the two copies in step: a change to the Outlook half in the
       payload must be mirrored here and shipped as a loader update.
       ============================================================ */
    function outlookHalf() {
        const DRAFT_PREFIX   = 'pmc:draft:';
        const DRAFT_TTL_MS   = 3 * 60 * 1000;
        const clean = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
        const gmGet  = (k, d) => { try { return GM_getValue(k, d); } catch (e) { return d; } };
        const gmDel  = (k)    => { try { GM_deleteValue(k); } catch (e) {} };
        const gmList = ()     => { try { return GM_listValues() || []; } catch (e) { return []; } };
        const log = (msg, lvl) => console[lvl === 'err' ? 'error' : lvl === 'warn' ? 'warn' : 'log']('[PMC] ' + msg);

        function pendingDrafts(now) {
            now = now || Date.now();
            const out = [];
            for (const k of gmList()) {
                if (!k.startsWith(DRAFT_PREFIX)) continue;
                const v = gmGet(k, null);
                if (v && typeof v.ts === 'number' && now - v.ts <= DRAFT_TTL_MS) out.push({ key: k, ...v });
                else gmDel(k);
            }
            return out;
        }
        function findCompose(subject) {
            const want = clean(subject);
            const subjectEl = [...document.querySelectorAll('input')]
                .find(i => /subject/i.test((i.getAttribute('aria-label') || '') + ' ' + (i.getAttribute('placeholder') || '')) && clean(i.value) === want);
            if (!subjectEl) return null;
            const editor = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')]
                .find(e => /message body|body/i.test(e.getAttribute('aria-label') || ''));
            return editor ? { subjectEl, editor } : null;
        }
        /* ---------- Cc ----------------------------------------------------
           The deeplink's ?cc= is honoured by classic OWA only; new Outlook
           drops it and opens with To + Subject alone. So the Outlook half fills
           the Cc well itself. Works on the compose container that owns the
           matched subject input, never on a different open draft. */
        function composeRoot(subjectEl) {
            let el = subjectEl;
            for (let i = 0; el && i < 12; i++, el = el.parentElement) {
                if (el.querySelector('[contenteditable="true"][role="textbox"]')) return el;
            }
            return document.body;
        }
        function isRecipientInput(el, kind) {
            const lab = clean((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || ''));
            return new RegExp('^' + kind + '(?:$|[^A-Za-z])', 'i').test(lab);
        }
        function findCcInput(root) {
            return [...root.querySelectorAll('input,[role="combobox"],[contenteditable="true"]')]
                .find(el => isRecipientInput(el, 'Cc')) || null;
        }
        function revealCc(root) {
            const btn = [...root.querySelectorAll('button,[role="button"]')]
                .find(b => /^cc$/i.test(clean(b.textContent)) || /^(?:add\s+)?cc(?:\s+recipients?)?$/i.test(clean(b.getAttribute('aria-label') || '')));
            if (btn) { btn.click(); return true; }
            return false;
        }
        function ccResolved(root, email) {
            const want = email.toLowerCase();
            const ccIn = findCcInput(root);
            if (!ccIn) return false;
            // The well is the input's nearest ancestor that also holds pills; a
            // pill carries the address in a title/aria-label or as text.
            let well = ccIn.parentElement;
            for (let i = 0; well && i < 5; i++, well = well.parentElement) {
                const txt = clean((well.innerText || '') + ' ' + [...well.querySelectorAll('[aria-label],[title]')]
                    .map(e => (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).join(' ')).toLowerCase();
                if (txt.includes(want)) return true;
            }
            return false;
        }
        /* Outlook's recipient picker shows a suggestion list (a portal outside
           the compose form) once text is typed; a synthetic Enter is ignored by
           React, so the row is clicked instead -- the one whose text carries the
           address, or the only row if there is just one. */
        async function pickSuggestion(email) {
            const want = email.toLowerCase();
            for (let i = 0; i < 16; i++) {
                await new Promise(r => setTimeout(r, 200));
                const opts = [...document.querySelectorAll('[role="listbox"] [role="option"], [role="option"]')]
                    .filter(o => o.offsetParent !== null);
                const hit = opts.find(o => clean(o.innerText || o.textContent).toLowerCase().includes(want)) || (opts.length === 1 ? opts[0] : null);
                if (hit) { hit.click(); return true; }
            }
            return false;
        }
        /* The compose form appears BEFORE the deeplink has finished resolving
           its recipients: subject is painted first, To/Cc pills a beat later.
           Typing at that moment produces a second Cc pill once the deeplink's
           own one lands. So: wait for the deeplink to settle (To pill present,
           then a short grace period) and only type if Cc is still missing. */
        function toResolved(root) {
            const toIn = [...root.querySelectorAll('input,[role="combobox"],[contenteditable="true"]')].find(el => isRecipientInput(el, 'To'));
            if (!toIn) return false;
            let well = toIn.parentElement;
            for (let i = 0; well && i < 5; i++, well = well.parentElement) {
                if (well.querySelector('[role="listitem"],[class*="pill" i],[class*="persona" i],[class*="recipient" i] button,[aria-label*="Remove" i]')) return true;
            }
            return false;
        }
        async function ensureCc(subjectEl, email) {
            if (!email) return 'none';
            const root = composeRoot(subjectEl);
            // Give the deeplink up to 4 s to paint its recipients before judging.
            for (let i = 0; i < 16; i++) {
                if (ccResolved(root, email)) return 'present';     // deeplink resolved it (mailtouri path)
                if (toResolved(root) && i >= 6) break;             // To is in and Cc still absent after 1.5 s -> ours to add
                await new Promise(r => setTimeout(r, 250));
            }
            if (ccResolved(root, email)) return 'present';
            let ccIn = findCcInput(root);
            if (!ccIn) {
                if (!revealCc(root)) return null;
                for (let i = 0; i < 10 && !(ccIn = findCcInput(root)); i++) await new Promise(r => setTimeout(r, 150));
                if (!ccIn) return null;
            }
            ccIn.focus();
            let typed = false;
            try { typed = document.execCommand('insertText', false, email); } catch (e) {}
            if (!typed) {
                try {
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                    if (ccIn instanceof HTMLInputElement && setter) setter.set.call(ccIn, email); else ccIn.textContent = email;
                    ccIn.dispatchEvent(new Event('input', { bubbles: true }));
                } catch (e) {}
            }
            // First choice: click the suggestion row Outlook offers for the typed
            // address (this is the click you used to make by hand). Then Enter / ';'.
            if (await pickSuggestion(email)) {
                for (let i = 0; i < 8; i++) {
                    await new Promise(r => setTimeout(r, 250));
                    if (ccResolved(root, email)) return 'filled';
                }
            }
            for (const type of ['keydown', 'keypress', 'keyup']) {
                ccIn.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            }
            for (let i = 0; i < 12; i++) {
                await new Promise(r => setTimeout(r, 250));
                if (ccResolved(root, email)) return 'filled';
            }
            try { document.execCommand('insertText', false, ';'); } catch (e) {}
            await new Promise(r => setTimeout(r, 500));
            return ccResolved(root, email) ? 'filled' : null;
        }
        function caretToStart(editor) {
            try {
                editor.focus();
                const sel = window.getSelection(); const range = document.createRange();
                range.setStart(editor, 0); range.collapse(true);
                sel.removeAllRanges(); sel.addRange(range);
            } catch (e) {}
        }
        /* Preference order: a synthetic paste (what the editor would do for a
           real Ctrl+V), then execCommand('insertHTML'), then give up and let
           runOutlook point at the clipboard. "Worked" means the editor's HTML
           changed; the dispatch itself proves nothing. */
        function insertHtml(editor, html, text) {
            const before = editor.innerHTML;
            caretToStart(editor);
            let pasted = false;
            try {
                if (typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function') {
                    const dt = new DataTransfer(); dt.setData('text/html', html); dt.setData('text/plain', text);
                    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                    pasted = true;
                }
            } catch (e) {}
            return new Promise((resolve) => setTimeout(() => {
                if (pasted && editor.innerHTML !== before) return resolve('paste');
                let ok = false;
                try { caretToStart(editor); ok = document.execCommand('insertHTML', false, html); } catch (e) {}
                if (ok && editor.innerHTML !== before) return resolve('execCommand');
                resolve(null);
            }, 300));
        }
        function showToast(msg, ms) {
            let t = document.getElementById('pmc-toast');
            if (!t) {
                t = document.createElement('div'); t.id = 'pmc-toast';
                // Outlook pages never get injectStyles(); inline the look there.
                if (!document.getElementById('pmc-styles')) t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483001;background:#0f172a;color:#fff;padding:10px 16px;border-radius:8px;font:13px system-ui;box-shadow:0 6px 24px rgba(0,0,0,.4);border:1px solid #334155;max-width:min(520px,90vw);line-height:1.4';
                document.body.appendChild(t);
            }
            t.textContent = msg;
            clearTimeout(t._pmcTimer);
            t._pmcTimer = setTimeout(() => { if (t.parentNode) t.remove(); }, ms || 12000);
        }
        function runOutlook(opts) {
            const intervalMs = (opts && opts.intervalMs) || 250;
            const maxMs = (opts && opts.maxMs) || 60000;
            const drafts = pendingDrafts();
            if (!drafts.length) return;
            const started = Date.now();
            let busy = false;
            const iv = setInterval(async () => {
                if (busy) return;
                if (Date.now() - started > maxMs) { clearInterval(iv); return; }
                for (const d of drafts) {
                    const hit = findCompose(d.subject);
                    if (!hit) continue;
                    busy = true; clearInterval(iv);
                    const ccHow = await ensureCc(hit.subjectEl, d.cc);
                    const how = await insertHtml(hit.editor, d.html, d.text);
                    gmDel(d.key);
                    const ccNote = ccHow ? '' : ` Cc was NOT added — add ${d.cc} by hand.`;
                    if (ccHow) log(`Cc ${ccHow}: ${d.cc}`, 'ok'); else log(`Cc not set: ${d.cc}`, 'err');
                    if (how) { log(`Body inserted via ${how}.`, 'ok'); showToast('PMC draft ready — review and send.' + ccNote); }
                    else showToast('Body is on your clipboard — click into the message and press Ctrl+V.' + ccNote);
                    return;
                }
            }, intervalMs);
        }

        runOutlook();
    }

    const IS_OUTLOOK = /^outlook\.(office|office365)\.com$|^outlook\.cloud\.microsoft$/.test(location.host);

    async function main() {
        if (IS_OUTLOOK) { outlookHalf(); return; }
        if (typeof GM_xmlhttpRequest !== 'function') {
            console.error('[PMC Loader] GM_xmlhttpRequest unavailable.');
            return;
        }
        if (typeof crypto === 'undefined' || !crypto.subtle) {
            console.error('[PMC Loader] WebCrypto unavailable — cannot verify the script, ' +
                          'so nothing was run.');
            return;
        }

        const cached    = readCache();
        const lastCheck = get(CHECKED_KEY, 0);

        if (!cached) { fetchScript('remote (cold)'); return; }

        if (Date.now() - lastCheck < CHECK_EVERY) {
            if (!(await runVerified(cached, 'cache (fresh)'))) {
                fetchScript('remote (invalid cache recovery)');
            }
            return;
        }

        if (!(await runVerified(cached, 'cache (revalidating)'))) {
            fetchScript('remote (invalid cache recovery)');
            return;
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: API_BASE + '/pmc/version?_=' + Date.now(),
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
                    url: API_BASE + '/pmc/script?_=' + Date.now(),
                    headers: { 'x-cra-key': LOADER_SECRET },
                    timeout: 15000,
                    onload: async (r2) => {
                        if (r2.status < 200 || r2.status >= 300 || !r2.responseText) return;

                        const sig = headerOf(r2, SIG_HEADER);
                        if (!(await verify(r2.responseText, sig))) {
                            console.error('[PMC Loader] Update FAILED signature verification; ' +
                                          'keeping the current copy.');
                            return;
                        }
                        writeCache(r2.responseText, sig);
                        set(SHA_KEY, meta.sha);
                        console.log('[PMC Loader] Updated to ' +
                                    (meta.version || meta.sha.slice(0, 8)) + '; active on next load.');
                    }
                });
            }
        });
    }

    main();
})();
