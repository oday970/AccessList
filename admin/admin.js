'use strict';

const API = 'https://api.casereview.cc';
const TOKEN_KEY = 'craAdminToken';

// sessionStorage, not localStorage: the token dies with the tab, so a
// shared machine does not leave an admin session behind.
const getToken = () => sessionStorage.getItem(TOKEN_KEY);
const $ = (sel) => document.querySelector(sel);

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let page = 0;
let PAGE_SIZE = 50;

/* ------------------------------------------------------------------
   Errors carry their kind, so a expired session and a failing server
   can be told apart. Previously both ended in a silent signOut() and
   an admin could not distinguish "logged out" from "server is down".
   ------------------------------------------------------------------ */
class ApiError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind;          // 'auth' | 'server' | 'network'
    this.status = status;
  }
}

async function api(path, options = {}) {
  let resp;
  try {
    resp = await fetch(API + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken(),
        ...(options.headers || {})
      }
    });
  } catch (e) {
    throw new ApiError('Could not reach the server. Check your connection.', 'network', 0);
  }
  if (resp.status === 401) throw new ApiError('Your session expired.', 'auth', 401);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new ApiError(body.error || ('Request failed (' + resp.status + ')'), 'server', resp.status);
  }
  return resp.json();
}

/* ---- feedback surfaces ---- */
function showBanner(message, retryFn) {
  $('#banner-text').textContent = message;
  $('#banner').hidden = false;
  $('#banner-retry').hidden = !retryFn;
  bannerRetry = retryFn || null;
}
function hideBanner() {
  $('#banner').hidden = true;
  bannerRetry = null;
}
let bannerRetry = null;
$('#banner-retry').onclick = () => { const fn = bannerRetry; hideBanner(); if (fn) fn(); };
$('#banner-dismiss').onclick = hideBanner;

let toastTimer = null;
function showToast(message, undoFn) {
  $('#toast-text').textContent = message;
  $('#toast-undo').hidden = !undoFn;
  toastUndo = undoFn || null;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undoFn ? 12000 : 4000);
}
function hideToast() { $('#toast').hidden = true; toastUndo = null; }
let toastUndo = null;
$('#toast-undo').onclick = () => { const fn = toastUndo; hideToast(); if (fn) fn(); };
$('#toast-close').onclick = hideToast;

/* Any failure routes through here, so nothing fails silently and only a
   real 401 ends the session. */
function handleError(err, context, retryFn) {
  if (err instanceof ApiError && err.kind === 'auth') {
    signOut('Your session expired. Sign in again.');
    return;
  }
  showBanner((context ? context + ': ' : '') + (err.message || 'Something went wrong.'), retryFn);
}

function signOut(message) {
  sessionStorage.removeItem(TOKEN_KEY);
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  hideBanner();
  hideToast();
  const err = $('#login-error');
  if (message) { err.textContent = message; err.hidden = false; }
  else { err.hidden = true; }
  $('#password').focus();
}

async function signIn(password) {
  let resp;
  try {
    resp = await fetch(API + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
  } catch (e) {
    throw new Error('Could not reach the server. Check your connection.');
  }
  if (!resp.ok) {
    // A locked-out IP gets the exact same 401 body as a wrong password
    // (by design, so an attacker can't distinguish the two states). The
    // only tell is the Retry-After header, so surface that when present
    // rather than making a locked-out admin think their password changed.
    const retryAfter = resp.headers.get('Retry-After');
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10);
      const mins = Math.max(1, Math.ceil(secs / 60));
      throw new Error(`Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    throw new Error('Invalid password');
  }
  const { token } = await resp.json();
  sessionStorage.setItem(TOKEN_KEY, token);
}

/* ---- table state rows: loading, empty, error are all visible ---- */
function stateRow(tbody, colspan, big, small) {
  clearChildren(tbody);
  const tr = document.createElement('tr');
  tr.className = 'state-row';
  const td = document.createElement('td');
  td.colSpan = colspan;
  const b = document.createElement('span');
  b.className = 'big';
  b.textContent = big;
  td.appendChild(b);
  if (small) td.appendChild(document.createTextNode(small));
  tr.appendChild(td);
  tbody.appendChild(tr);
}

/* ---- users ---- */
let usersBusy = false;

async function loadUsers() {
  const tbody = $('#user-table tbody');
  const query = $('#user-search').value.trim();
  if (usersBusy) return;
  usersBusy = true;
  stateRow(tbody, 6, 'Loading…', '');

  try {
    const q = encodeURIComponent(query);
    const data = await api(`/admin/users?q=${q}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
    clearChildren(tbody);

    if (!data.users.length) {
      stateRow(
        tbody, 6,
        query ? `No users match “${query}”` : 'No users yet',
        query ? 'Clear the search to see the whole list.' : 'Add one, or use Bulk add to paste a list.'
      );
    } else {
      for (const u of data.users) tbody.appendChild(userRow(u));
    }

    const from = data.total ? page * PAGE_SIZE + 1 : 0;
    $('#page-info').textContent = `${from}–${Math.min(data.total, (page + 1) * PAGE_SIZE)} of ${data.total}`;
    $('#users-caption').textContent = query
      ? `Allow-list — filtered by “${query}”`
      : 'Allow-list';
    $('#prev-page').disabled = page === 0;
    $('#next-page').disabled = (page + 1) * PAGE_SIZE >= data.total;
    hideBanner();
  } catch (err) {
    stateRow(tbody, 6, 'Could not load users', err.message || '');
    handleError(err, 'Loading users', () => loadUsers());
  } finally {
    usersBusy = false;
  }
}

function userRow(u) {
  const tr = document.createElement('tr');

  const tdUser = document.createElement('td');
  const uname = document.createElement('span');
  uname.className = 'uname';
  uname.textContent = u.username;
  tdUser.appendChild(uname);
  if (!u.authorized) tdUser.className = 'revoked';

  const tdAccess = document.createElement('td');
  tdAccess.textContent = u.authorized ? 'Active' : 'Revoked';

  // An empty cell announces nothing to a screen reader, so "off" is
  // written out rather than left as the absence of a tick.
  const tdRainbow = flagCell(u.rainbow);
  const tdThemes = flagCell(u.themes);

  const tdNote = document.createElement('td');
  tdNote.textContent = u.note || '';

  const tdActions = document.createElement('td');
  tdActions.className = 'actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.textContent = 'Edit';
  editBtn.setAttribute('aria-label', 'Edit ' + u.username);
  editBtn.onclick = () => openUserDialog(u);

  const revokeBtn = document.createElement('button');
  revokeBtn.type = 'button';
  revokeBtn.className = 'danger';
  revokeBtn.textContent = u.authorized ? 'Revoke' : 'Restore';
  revokeBtn.setAttribute('aria-label', (u.authorized ? 'Revoke ' : 'Restore ') + u.username);
  revokeBtn.onclick = () => (u.authorized ? revokeUser(u, revokeBtn) : restoreUser(u, revokeBtn));

  tdActions.appendChild(editBtn);
  tdActions.appendChild(revokeBtn);

  tr.append(tdUser, tdAccess, tdRainbow, tdThemes, tdNote, tdActions);
  return tr;
}

function flagCell(on) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = 'flag';
  span.dataset.on = String(!!on);
  span.textContent = on ? 'Yes' : 'No';
  td.appendChild(span);
  return td;
}

/* Revoke is reversible — the confirm message always said so. So it is
   optimistic with an Undo instead of a blocking confirm the admin
   learns to click through. */
async function revokeUser(u, btn) {
  btn.disabled = true;
  try {
    await api('/admin/users/' + encodeURIComponent(u.username), { method: 'DELETE' });
    showToast('Revoked ' + u.username + '. Leaderboard history is kept.', () => restoreUser(u));
    await Promise.all([loadUsers(), loadStats()]);
  } catch (err) {
    btn.disabled = false;
    handleError(err, 'Revoking ' + u.username);
  }
}

async function restoreUser(u, btn) {
  if (btn) btn.disabled = true;
  try {
    await api('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: u.username,
        authorized: true,
        rainbow: !!u.rainbow,
        themes: !!u.themes,
        note: u.note || ''
      })
    });
    showToast('Restored ' + u.username + '.');
    await Promise.all([loadUsers(), loadStats()]);
  } catch (err) {
    if (btn) btn.disabled = false;
    handleError(err, 'Restoring ' + u.username);
  }
}

/* ---- user dialog: the POST happens while the dialog is still open, so
   a rejected save keeps the typed values and can show the reason. ---- */
let editingUser = null;

function openUserDialog(user) {
  editingUser = user;
  $('#user-dialog-title').textContent = user ? 'Edit ' + user.username : 'Add user';
  $('#f-username').value = user ? user.username : '';
  $('#f-username').readOnly = !!user;
  $('#f-authorized').checked = user ? !!user.authorized : true;
  $('#f-rainbow').checked = user ? !!user.rainbow : false;
  $('#f-themes').checked = user ? !!user.themes : false;
  $('#f-note').value = user ? (user.note || '') : '';
  $('#f-username-err').textContent = '';
  $('#f-form-err').textContent = '';
  $('#f-save').disabled = false;
  $('#f-save').textContent = 'Save';
  $('#user-dialog').showModal();
}

$('#f-cancel').onclick = () => $('#user-dialog').close();

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#f-username').value.trim();
  $('#f-username-err').textContent = '';
  $('#f-form-err').textContent = '';

  if (!username) {
    $('#f-username-err').textContent = 'Enter a username.';
    $('#f-username').focus();
    return;
  }

  const save = $('#f-save');
  save.disabled = true;
  save.textContent = 'Saving…';
  try {
    await api('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        authorized: $('#f-authorized').checked,
        rainbow: $('#f-rainbow').checked,
        themes: $('#f-themes').checked,
        note: $('#f-note').value
      })
    });
    $('#user-dialog').close();
    showToast((editingUser ? 'Saved ' : 'Added ') + username + '.');
    await Promise.all([loadUsers(), loadStats()]);
  } catch (err) {
    save.disabled = false;
    save.textContent = 'Save';
    if (err instanceof ApiError && err.kind === 'auth') {
      $('#user-dialog').close();
      handleError(err);
      return;
    }
    $('#f-form-err').textContent = err.message || 'Could not save user.';
  }
});

/* ---- bulk add ----
   The API returns counts, not which names failed, so the dialog offers a
   local dry run before submitting and never clears the textarea. */
const USERNAME_RE = /^[A-Za-z0-9._-]{1,32}$/;

function analyseBulk(raw) {
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  const seen = new Set();
  const unique = [], duplicates = [], suspicious = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) { duplicates.push(p); continue; }
    seen.add(key);
    unique.push(p);
    if (!USERNAME_RE.test(p)) suspicious.push(p);
  }
  return { parts, unique, duplicates, suspicious };
}

function renderBulkPreview(a) {
  const box = $('#bulk-preview');
  clearChildren(box);
  const dl = document.createElement('dl');
  const add = (k, v) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  };
  add('Entries pasted', a.parts.length);
  add('Will be sent', a.unique.length);
  add('Repeated in your list', a.duplicates.length);
  add('Look invalid', a.suspicious.length);
  box.appendChild(dl);

  if (a.suspicious.length) {
    const p = document.createElement('p');
    p.className = 'bulk-flagged';
    p.textContent = 'Flagged locally: ' + a.suspicious.join(', ');
    box.appendChild(p);
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'These do not match the usual username shape. They are still sent — the server decides.';
    box.appendChild(note);
  }
  box.hidden = false;
}

$('#bulk-btn').onclick = () => {
  $('#f-bulk-err').textContent = '';
  $('#bulk-preview').hidden = true;
  $('#f-bulk-save').disabled = false;
  $('#f-bulk-save').textContent = 'Add all';
  $('#bulk-dialog').showModal();
};
$('#f-bulk-cancel').onclick = () => $('#bulk-dialog').close();
$('#f-bulk-check').onclick = () => renderBulkPreview(analyseBulk($('#f-bulk').value));

$('#bulk-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#f-bulk-err').textContent = '';
  const a = analyseBulk($('#f-bulk').value);
  if (!a.unique.length) {
    $('#f-bulk-err').textContent = 'Paste at least one username.';
    $('#f-bulk').focus();
    return;
  }

  const btn = $('#f-bulk-save');
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    const r = await api('/admin/users/bulk', {
      method: 'POST',
      body: JSON.stringify({ usernames: a.unique })
    });

    // Results render in the dialog and the textarea is left alone, so the
    // admin can still see what they pasted when something did not land.
    const box = $('#bulk-preview');
    clearChildren(box);
    const dl = document.createElement('dl');
    const add = (k, v) => {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = String(v);
      dl.append(dt, dd);
    };
    add('Sent', a.unique.length);
    add('Added', r.added);
    add('Already on the list', r.existing);
    add('Duplicates', r.duplicates);
    add('Rejected by the server', r.invalid);
    box.appendChild(dl);
    if (r.invalid) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Your list is still above — the server reports a count but not which names it rejected.';
      box.appendChild(p);
    }
    box.hidden = false;

    btn.disabled = false;
    btn.textContent = 'Add all';
    page = 0;
    await Promise.all([loadUsers(), loadStats()]);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Add all';
    if (err instanceof ApiError && err.kind === 'auth') {
      $('#bulk-dialog').close();
      handleError(err);
      return;
    }
    $('#f-bulk-err').textContent = err.message || 'Bulk add failed.';
  }
});

/* ---- themes ---- */
async function loadThemes() {
  const std = $('#theme-standard'), sea = $('#theme-seasonal');
  std.textContent = 'Loading…';
  sea.textContent = '';
  try {
    const data = await api('/admin/themes');

    const render = (el, list) => {
      clearChildren(el);
      if (!list.length) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.style.padding = '12px 13px';
        p.textContent = 'None.';
        el.appendChild(p);
        return;
      }
      for (const t of list) {
        const row = document.createElement('div');
        row.className = 'theme-row';

        // label wraps the control, so the theme name is the accessible name
        const enableLabel = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!t.enabled;
        const name = document.createElement('span');
        name.className = 'theme-name';
        name.textContent = t.label;
        enableLabel.append(checkbox, name);

        const spacer = document.createElement('span');
        spacer.className = 'spacer';

        const radioLabel = document.createElement('label');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'default-theme';
        radio.checked = data.defaultTheme === t.id;
        radio.setAttribute('aria-label', 'Make ' + t.label + ' the default theme');
        radioLabel.append(radio, document.createTextNode(' default'));

        checkbox.onchange = async (e) => {
          const desired = e.target.checked;
          try {
            await api('/admin/themes', { method: 'POST', body: JSON.stringify({ id: t.id, enabled: desired }) });
            showToast((desired ? 'Enabled ' : 'Disabled ') + t.label + '.');
            loadThemes();
          } catch (err) {
            // The server refuses to disable the last enabled theme (409).
            // Revert the checkbox instead of leaving it in a state the
            // server rejected, and say why.
            e.target.checked = !desired;
            handleError(err, 'Updating ' + t.label);
          }
        };
        radio.onchange = async () => {
          try {
            await api('/admin/themes', { method: 'POST', body: JSON.stringify({ defaultTheme: t.id }) });
            showToast(t.label + ' is now the default.');
          } catch (err) {
            // The API refuses a disabled theme as default (400) and also
            // returns 404 if the theme was deleted/renamed concurrently by
            // another admin — prefer the server's own message over the
            // hardcoded guess, falling back only when it has none.
            handleError(err, 'Setting default theme');
          }
          loadThemes();
        };

        row.append(enableLabel, spacer, radioLabel);
        el.appendChild(row);
      }
    };

    render(std, data.themes.filter((t) => !t.seasonal));
    render(sea, data.themes.filter((t) => t.seasonal));
    hideBanner();
  } catch (err) {
    std.textContent = '';
    handleError(err, 'Loading themes', () => loadThemes());
  }
}

/* ---- audit + stats ---- */
async function loadAudit() {
  const tbody = $('#audit-table tbody');
  stateRow(tbody, 4, 'Loading…', '');
  try {
    const data = await api('/admin/rejects?limit=200');
    clearChildren(tbody);
    if (!data.rejects.length) {
      stateRow(tbody, 4, 'Nothing refused', 'That is the state you want this table in.');
      return;
    }
    for (const r of data.rejects) {
      const tr = document.createElement('tr');
      const tdWhen = document.createElement('td');
      tdWhen.textContent = new Date(r.ts).toLocaleString();
      const tdUser = document.createElement('td');
      tdUser.textContent = r.username || '—';
      const tdReason = document.createElement('td');
      tdReason.textContent = r.reason;
      const tdDetail = document.createElement('td');
      tdDetail.textContent = r.detail || '';
      tr.append(tdWhen, tdUser, tdReason, tdDetail);
      tbody.appendChild(tr);
    }
    hideBanner();
  } catch (err) {
    stateRow(tbody, 4, 'Could not load the audit log', err.message || '');
    handleError(err, 'Loading audit log', () => loadAudit());
  }
}

async function loadStats() {
  const bar = $('#stats-bar');
  bar.dataset.loading = 'true';
  try {
    const s = await api('/admin/stats');
    const age = s.snapshotAgeMs === null ? 'never built' : Math.round(s.snapshotAgeMs / 60000) + ' min ago';
    bar.textContent =
      `${s.users.authorized} active · ${s.users.revoked} revoked · ${s.themes.enabled}/${s.themes.total} themes · board ${age}`;
  } catch (err) {
    bar.textContent = 'Stats unavailable';
    if (err instanceof ApiError && err.kind === 'auth') throw err;
  } finally {
    delete bar.dataset.loading;
  }
}

/* ---- wiring ---- */
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  const btn = $('#login-submit');
  err.hidden = true;
  if (!$('#password').value) {
    err.textContent = 'Enter the admin password.';
    err.hidden = false;
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  btn.setAttribute('aria-busy', 'true');
  try {
    await signIn($('#password').value);
    $('#password').value = '';
    await start();
  } catch (ex) {
    err.textContent = ex.message || 'Invalid password';
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
    btn.removeAttribute('aria-busy');
  }
};

$('#logout').onclick = () => signOut('');

/* tabs: a real tablist with roving tabindex */
const tabBtns = [].slice.call(document.querySelectorAll('#tabs button[role="tab"]'));

function selectTab(btn) {
  tabBtns.forEach((b) => {
    const on = b === btn;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + btn.dataset.tab; });

  // Every tab refetches on activation. Previously Users did not, so after
  // editing themes the table could be stale against another admin's writes.
  if (btn.dataset.tab === 'users') loadUsers();
  if (btn.dataset.tab === 'themes') loadThemes();
  if (btn.dataset.tab === 'audit') loadAudit();
}

tabBtns.forEach((btn, i) => {
  btn.addEventListener('click', () => selectTab(btn));
  btn.addEventListener('keydown', (e) => {
    let next = null;
    if (e.key === 'ArrowRight') next = tabBtns[(i + 1) % tabBtns.length];
    else if (e.key === 'ArrowLeft') next = tabBtns[(i - 1 + tabBtns.length) % tabBtns.length];
    else if (e.key === 'Home') next = tabBtns[0];
    else if (e.key === 'End') next = tabBtns[tabBtns.length - 1];
    if (next) { e.preventDefault(); next.focus(); selectTab(next); }
  });
});

let searchTimer = null;
$('#user-search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { page = 0; loadUsers(); }, 250);
};
$('#prev-page').onclick = () => { page = Math.max(0, page - 1); loadUsers(); };
$('#next-page').onclick = () => { page++; loadUsers(); };
$('#page-size').onchange = (e) => { PAGE_SIZE = parseInt(e.target.value, 10) || 50; page = 0; loadUsers(); };
$('#add-user-btn').onclick = () => openUserDialog(null);

document.querySelectorAll('[data-bulk]').forEach((b) => {
  b.onclick = async () => {
    b.disabled = true;
    try {
      await api('/admin/themes', { method: 'POST', body: JSON.stringify({ seasonal: true, enabled: b.dataset.bulk === 'on' }) });
      showToast(b.dataset.bulk === 'on' ? 'All seasonal themes enabled.' : 'All seasonal themes disabled.');
      loadThemes();
    } catch (err) {
      // Bulk-disabling every seasonal theme can zero out all enabled
      // themes, which the server also refuses with 409.
      handleError(err, 'Updating seasonal themes');
    } finally {
      b.disabled = false;
    }
  };
});

async function start() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  hideBanner();
  await Promise.all([loadUsers(), loadStats()]);
}

/* A failure during start no longer discards the session. Only a real 401
   signs the admin out, and it says so; anything else keeps them in the app
   with a retry. */
if (getToken()) {
  start().catch((err) => handleError(err, 'Loading the panel', () => start().catch(() => {})));
}
