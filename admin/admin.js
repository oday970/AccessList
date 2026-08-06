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
const PAGE_SIZE = 50;

async function api(path, options = {}) {
  const resp = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + getToken(),
      ...(options.headers || {})
    }
  });
  if (resp.status === 401) { signOut(); throw new Error('unauthorized'); }
  if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || String(resp.status));
  return resp.json();
}

function signOut() {
  sessionStorage.removeItem(TOKEN_KEY);
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

/* A failed request is not the same thing as an expired session. Only a 401
   signs the admin out; everything else raises this banner and leaves the
   panel where it was, so a network blip stops looking like a logout. */
let bannerRetry = null;
function showBanner(message, retryFn) {
  $('#banner-text').textContent = message;
  bannerRetry = retryFn || null;
  $('#banner-retry').hidden = !retryFn;
  $('#banner').hidden = false;
}
function hideBanner() { $('#banner').hidden = true; bannerRetry = null; }
$('#banner-dismiss').onclick = hideBanner;
$('#banner-retry').onclick = () => { const fn = bannerRetry; hideBanner(); if (fn) fn(); };

function handleError(err, context, retryFn) {
  if (err && err.message === 'unauthorized') return;   // signOut already ran
  showBanner(context + ' failed: ' + ((err && err.message) || 'unknown error'), retryFn);
}

async function signIn(password) {
  const resp = await fetch(API + '/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
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

/* ---- users ---- */
function stateRow(tbody, colspan, big, small) {
  const tr = document.createElement('tr');
  tr.className = 'state-row';
  const td = document.createElement('td');
  td.colSpan = colspan;
  const b = document.createElement('b');
  b.textContent = big;
  const s = document.createElement('span');
  s.textContent = small;
  td.appendChild(b);
  td.appendChild(s);
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function pill(on, onText, offText) {
  const el = document.createElement('span');
  el.className = 'pill ' + (on ? 'on' : 'off');
  el.textContent = on ? onText : offText;
  return el;
}

function flagCell(on) {
  const td = document.createElement('td');
  const s = document.createElement('span');
  s.className = 'flag' + (on ? '' : ' no');
  s.textContent = on ? 'YES' : '—';
  td.appendChild(s);
  return td;
}

async function loadUsers() {
  const q = encodeURIComponent($('#user-search').value.trim());
  const tbody = $('#user-table tbody');
  let data;
  try {
    data = await api(`/admin/users?q=${q}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
  } catch (err) {
    clearChildren(tbody);
    stateRow(tbody, 6, 'Could not load', 'The list is unavailable, not empty.');
    handleError(err, 'Loading users', () => loadUsers());
    return;
  }
  clearChildren(tbody);

  if (!data.users.length) {
    stateRow(tbody, 6, q ? 'No match' : 'No users yet',
      q ? 'No username matches that search.' : 'Add the first user to the allow-list.');
  }

  for (const u of data.users) {
    const tr = document.createElement('tr');

    const tdUser = document.createElement('td');
    tdUser.textContent = u.username;
    if (!u.authorized) tdUser.className = 'revoked';

    const tdAccess = document.createElement('td');
    tdAccess.appendChild(pill(u.authorized, 'Active', 'Revoked'));

    const tdRainbow = flagCell(u.rainbow);
    const tdThemes = flagCell(u.themes);

    const tdNote = document.createElement('td');
    tdNote.textContent = u.note || '';

    const tdActions = document.createElement('td');
    tdActions.className = 'acts';
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-label', 'Edit ' + u.username);
    editBtn.onclick = () => openUserDialog(u);
    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'danger';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.setAttribute('aria-label', 'Revoke ' + u.username);
    revokeBtn.onclick = async () => {
      if (!confirm(`Revoke access for ${u.username}? Their leaderboard history is kept.`)) return;
      try {
        await api('/admin/users/' + encodeURIComponent(u.username), { method: 'DELETE' });
        loadUsers();
        loadStats();
      } catch (err) {
        handleError(err, 'Revoking ' + u.username);
      }
    };
    tdActions.appendChild(editBtn);
    tdActions.appendChild(document.createTextNode(' '));
    tdActions.appendChild(revokeBtn);

    tr.appendChild(tdUser);
    tr.appendChild(tdAccess);
    tr.appendChild(tdRainbow);
    tr.appendChild(tdThemes);
    tr.appendChild(tdNote);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }

  const from = data.total ? page * PAGE_SIZE + 1 : 0;
  $('#page-info').textContent = `${from}–${Math.min(data.total, (page + 1) * PAGE_SIZE)} of ${data.total}`;
  $('#prev-page').disabled = page === 0;
  $('#next-page').disabled = (page + 1) * PAGE_SIZE >= data.total;
}

function openUserDialog(user) {
  $('#user-dialog-title').textContent = user ? 'Edit ' + user.username : 'Add user';
  $('#f-username').value = user ? user.username : '';
  $('#f-username').readOnly = !!user;
  $('#f-authorized').checked = user ? !!user.authorized : true;
  $('#f-rainbow').checked = user ? !!user.rainbow : false;
  $('#f-themes').checked = user ? !!user.themes : false;
  $('#f-note').value = user ? (user.note || '') : '';
  // returnValue is NOT reset by the dialog itself on an Escape-dismiss
  // (Escape fires 'cancel' then 'close' but leaves returnValue untouched),
  // so a stale 'save' from a previous successful save would otherwise
  // cause the next Escape-dismiss to silently re-submit. Reset it here.
  $('#user-dialog').returnValue = '';
  $('#user-dialog').showModal();
}

/* ---- themes ---- */
async function loadThemes() {
  const data = await api('/admin/themes');

  const render = (target, list) => {
    const el = $(target);
    clearChildren(el);
    for (const t of list) {
      const row = document.createElement('div');
      row.className = 'theme-row';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !!t.enabled;

      const label = document.createElement('span');
      label.className = 'nm';
      label.textContent = (t.emoji || '') + ' ' + t.label;

      const spacer = document.createElement('span');
      spacer.className = 'spacer';

      const radioLabel = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'default-theme';
      radio.checked = data.defaultTheme === t.id;
      radioLabel.appendChild(radio);
      radioLabel.appendChild(document.createTextNode(' default'));

      checkbox.onchange = async (e) => {
        const desired = e.target.checked;
        try {
          await api('/admin/themes', { method: 'POST', body: JSON.stringify({ id: t.id, enabled: desired }) });
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
        } catch (err) {
          // The API refuses a disabled theme as default (400) and also
          // returns 404 if the theme was deleted/renamed concurrently by
          // another admin — prefer the server's own message over the
          // hardcoded guess, falling back only when it has none.
          handleError(err, 'Setting ' + t.label + ' as default');
        }
        loadThemes();
      };

      row.appendChild(checkbox);
      row.appendChild(label);
      row.appendChild(spacer);
      row.appendChild(radioLabel);
      el.appendChild(row);
    }
  };

  render('#theme-standard', data.themes.filter((t) => !t.seasonal));
  render('#theme-seasonal', data.themes.filter((t) => t.seasonal));
}

/* ---- audit + stats ---- */
async function loadAudit() {
  const tbody = $('#audit-table tbody');
  let data;
  try {
    data = await api('/admin/rejects?limit=200');
  } catch (err) {
    clearChildren(tbody);
    stateRow(tbody, 4, 'Could not load', 'The audit log is unavailable, not empty.');
    handleError(err, 'Loading the audit log', () => loadAudit());
    return;
  }
  clearChildren(tbody);
  if (!data.rejects.length) {
    stateRow(tbody, 4, 'Nothing refused', 'This is the state you want it in.');
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

    tr.appendChild(tdWhen);
    tr.appendChild(tdUser);
    tr.appendChild(tdReason);
    tr.appendChild(tdDetail);
    tbody.appendChild(tr);
  }
}

async function loadStats() {
  const s = await api('/admin/stats');
  const age = s.snapshotAgeMs === null ? 'never built' : Math.round(s.snapshotAgeMs / 60000) + ' min ago';
  $('#stats-bar').textContent =
    `${s.users.authorized} active · ${s.users.revoked} revoked · ${s.themes.enabled}/${s.themes.total} themes · board ${age}`;
}

/* ---- wiring ---- */
$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    await signIn($('#password').value);
    $('#password').value = '';
    // start() failing is not a bad password — it raises its own banner
    // rather than telling the admin their credentials were wrong.
    start().catch((e2) => handleError(e2, 'Loading the panel', () => start().catch(() => {})));
  } catch (ex) {
    err.textContent = ex.message || 'Invalid password';
    err.hidden = false;
  }
};

$('#logout').onclick = signOut;

/* A real tablist: aria-selected carries the state the CSS paints, and a
   roving tabindex means one Tab stop for the strip with arrows inside it. */
const tabBtns = Array.from(document.querySelectorAll('#tabs button[data-tab]'));

function selectTab(btn) {
  tabBtns.forEach((b) => {
    const on = b === btn;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + btn.dataset.tab; });
  if (btn.dataset.tab === 'themes') loadThemes().catch((err) => handleError(err, 'Loading themes', () => loadThemes().catch(() => {})));
  if (btn.dataset.tab === 'audit') loadAudit().catch((err) => handleError(err, 'Loading the audit log'));
}

tabBtns.forEach((btn, i) => {
  btn.addEventListener('click', () => selectTab(btn));
  btn.addEventListener('keydown', (e) => {
    let next = null;
    if (e.key === 'ArrowRight') next = tabBtns[(i + 1) % tabBtns.length];
    else if (e.key === 'ArrowLeft') next = tabBtns[(i - 1 + tabBtns.length) % tabBtns.length];
    else if (e.key === 'Home') next = tabBtns[0];
    else if (e.key === 'End') next = tabBtns[tabBtns.length - 1];
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    next.focus();
  });
});

let searchTimer = null;
$('#user-search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { page = 0; loadUsers(); }, 250);
};
$('#prev-page').onclick = () => { page = Math.max(0, page - 1); loadUsers(); };
$('#next-page').onclick = () => { page++; loadUsers(); };
$('#add-user-btn').onclick = () => openUserDialog(null);
$('#bulk-btn').onclick = () => {
  $('#f-bulk').value = '';
  // See the comment in openUserDialog: Escape does not reset returnValue.
  $('#bulk-dialog').returnValue = '';
  $('#bulk-dialog').showModal();
};

$('#user-dialog').addEventListener('close', async () => {
  if ($('#user-dialog').returnValue !== 'save') return;
  try {
    await api('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#f-username').value,
        authorized: $('#f-authorized').checked,
        rainbow: $('#f-rainbow').checked,
        themes: $('#f-themes').checked,
        note: $('#f-note').value
      })
    });
    loadUsers();
    loadStats();
  } catch (err) {
    handleError(err, 'Saving the user');
  }
});

$('#bulk-dialog').addEventListener('close', async () => {
  if ($('#bulk-dialog').returnValue !== 'save') return;
  const usernames = $('#f-bulk').value.split(/[\s,;]+/).filter(Boolean);
  if (!usernames.length) return;
  try {
    const r = await api('/admin/users/bulk', { method: 'POST', body: JSON.stringify({ usernames }) });
    alert(
      `Submitted ${usernames.length}.\n` +
      `Added: ${r.added}\n` +
      `Already existing: ${r.existing}\n` +
      `Duplicates in list: ${r.duplicates}\n` +
      `Invalid: ${r.invalid}`
    );
    $('#f-bulk').value = '';
    page = 0;
    loadUsers();
    loadStats();
  } catch (err) {
    handleError(err, 'Bulk add');
  }
});

document.querySelectorAll('[data-bulk]').forEach((b) => {
  b.onclick = async () => {
    try {
      await api('/admin/themes', { method: 'POST', body: JSON.stringify({ seasonal: true, enabled: b.dataset.bulk === 'on' }) });
      loadThemes();
    } catch (err) {
      // Bulk-disabling every seasonal theme can zero out all enabled
      // themes, which the server also refuses with 409.
      handleError(err, 'Updating seasonal themes');
    }
  };
});

async function start() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  hideBanner();
  await Promise.all([loadUsers(), loadStats()]);
}

/* Previously any startup failure called signOut, so one flaky request on
   load discarded a perfectly good token and looked like a session expiry.
   api() already signs out on a real 401; anything else is retryable. */
if (getToken()) {
  start().catch((err) => handleError(err, 'Loading the panel', () => start().catch(() => {})));
}
