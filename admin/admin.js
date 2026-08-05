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
async function loadUsers() {
  const q = encodeURIComponent($('#user-search').value.trim());
  const data = await api(`/admin/users?q=${q}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
  const tbody = $('#user-table tbody');
  clearChildren(tbody);

  for (const u of data.users) {
    const tr = document.createElement('tr');

    const tdUser = document.createElement('td');
    tdUser.textContent = u.username;
    if (!u.authorized) tdUser.className = 'revoked';

    const tdAccess = document.createElement('td');
    tdAccess.textContent = u.authorized ? 'Active' : 'Revoked';

    const tdRainbow = document.createElement('td');
    tdRainbow.textContent = u.rainbow ? '✓' : '';

    const tdThemes = document.createElement('td');
    tdThemes.textContent = u.themes ? '✓' : '';

    const tdNote = document.createElement('td');
    tdNote.textContent = u.note || '';

    const tdActions = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => openUserDialog(u);
    const revokeBtn = document.createElement('button');
    revokeBtn.textContent = 'Revoke';
    revokeBtn.onclick = async () => {
      if (!confirm(`Revoke access for ${u.username}? Their leaderboard history is kept.`)) return;
      try {
        await api('/admin/users/' + encodeURIComponent(u.username), { method: 'DELETE' });
        loadUsers();
        loadStats();
      } catch (err) {
        if (err.message !== 'unauthorized') alert(err.message || 'Could not revoke user.');
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
          if (err.message !== 'unauthorized') alert(err.message || 'Could not update theme.');
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
          if (err.message !== 'unauthorized') alert(err.message || 'Enable the theme before making it the default.');
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
  const data = await api('/admin/rejects?limit=200');
  const tbody = $('#audit-table tbody');
  clearChildren(tbody);
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
    await start();
  } catch (ex) {
    err.textContent = ex.message || 'Invalid password';
    err.hidden = false;
  }
};

$('#logout').onclick = signOut;

$('#tabs').onclick = (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== 'tab-' + btn.dataset.tab; });
  if (btn.dataset.tab === 'themes') loadThemes().catch((err) => { if (err.message !== 'unauthorized') alert(err.message); });
  if (btn.dataset.tab === 'audit') loadAudit().catch((err) => { if (err.message !== 'unauthorized') alert(err.message); });
};

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
    if (err.message !== 'unauthorized') alert(err.message || 'Could not save user.');
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
    if (err.message !== 'unauthorized') alert(err.message || 'Bulk add failed.');
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
      if (err.message !== 'unauthorized') alert(err.message || 'Could not update themes.');
    }
  };
});

async function start() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  await Promise.all([loadUsers(), loadStats()]);
}

if (getToken()) start().catch(signOut);
