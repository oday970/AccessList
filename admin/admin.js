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

/* ---- in-page dialogs ---------------------------------------------
   Every question the panel asks and every result it reports goes through
   these two. window.confirm/alert/prompt are not used anywhere, and the
   reason is not taste: after a couple of native dialogs in a row Chrome
   offers "prevent this page from creating additional dialogs", and once
   that is ticked every later confirm() returns FALSE with no error and no
   dialog. Every delete guard in this panel would start silently refusing
   to delete. A <dialog> cannot be switched off from under us.

   confirmDialog resolves { ok, value } rather than a bare boolean so a
   caller can carry something back out -- a typed name, a radio choice --
   without a second round of state. */
function confirmDialog(opts) {
  const o = opts || {};
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = o.title || 'Are you sure?';
  $('#confirm-body').textContent = o.body || '';

  const okBtn = $('#confirm-ok');
  okBtn.textContent = o.confirmText || 'Confirm';
  okBtn.className = o.danger ? 'danger' : 'primary';
  okBtn.disabled = false;

  const input = $('#confirm-input');
  $('#confirm-input-wrap').hidden = !o.input;
  input.value = o.input ? (o.input.value || '') : '';
  if (o.input) {
    $('#confirm-input-label').textContent = o.input.label || '';
    input.maxLength = o.input.maxLength || 200;
  }

  /* Type-to-confirm, the same guard the single-user delete dialog uses.
     Compared case-insensitively: the point is deliberate intent, not
     transcription accuracy. */
  const typeInput = $('#confirm-type');
  const want = o.typeToConfirm === undefined || o.typeToConfirm === null
    ? null : String(o.typeToConfirm);
  $('#confirm-type-wrap').hidden = !want;
  $('#confirm-type-want').textContent = want || '';
  typeInput.value = '';
  if (want) {
    okBtn.disabled = true;
    typeInput.oninput = () => {
      okBtn.disabled = typeInput.value.trim().toLowerCase() !== want.trim().toLowerCase();
    };
  } else {
    typeInput.oninput = null;
  }

  // Arbitrary extra controls, e.g. the bulk delete's keep/hide radios.
  const extra = $('#confirm-extra');
  clearChildren(extra);
  if (o.extra && o.extra.render) o.extra.render(extra);

  // Escape leaves returnValue untouched, so a stale 'ok' from the previous
  // confirmation would read as a fresh yes. Same trap as the user dialog.
  dlg.returnValue = '';
  dlg.showModal();

  return new Promise((resolve) => {
    dlg.addEventListener('close', function once() {
      dlg.removeEventListener('close', once);
      const ok = dlg.returnValue === 'ok';
      let value = true;
      if (ok && o.input) value = input.value.trim();
      else if (ok && o.extra && o.extra.read) value = o.extra.read(extra);
      resolve({ ok, value });
    });
  });
}

/* Reports a result. `rows` is a list of [label, value] pairs rendered as a
   small table -- readable, selectable and still on screen while you act on
   it, none of which is true of an alert(). */
function messageDialog(opts) {
  const o = opts || {};
  const dlg = $('#msg-dialog');
  $('#msg-title').textContent = o.title || '';
  $('#msg-body').textContent = o.body || '';

  const tbody = $('#msg-rows tbody');
  clearChildren(tbody);
  const rows = o.rows || [];
  $('#msg-rows-wrap').hidden = !rows.length;
  for (const pair of rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = pair[0];
    const td = document.createElement('td');
    td.textContent = String(pair[1]);
    tr.appendChild(th);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  // Optional named lists, e.g. which usernames a bulk add refused.
  const lists = $('#msg-lists');
  clearChildren(lists);
  for (const l of o.lists || []) {
    if (!l || !(l.items || []).length) continue;
    const h = document.createElement('h3');
    h.textContent = l.title;
    const ul = document.createElement('ul');
    ul.className = 'msg-list';
    for (const item of l.items) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
    lists.appendChild(h);
    lists.appendChild(ul);
  }

  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', function once() {
      dlg.removeEventListener('close', once);
      resolve();
    });
  });
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

/* ---- workgroups ----------------------------------------------
   The group list is needed by three surfaces at once (the per-row
   dropdown, the user dialog, the bulk dialog), so it is fetched once
   and cached here rather than per-render. loadUsers() would otherwise
   issue one groups request per page of the table. */
let groups = [];

async function refreshGroups() {
  const data = await api('/admin/workgroups');
  groups = data.workgroups || [];
  fillGroupFilter();
  fillBoardFilter();
  fillGroupSelect($('#bulk-move-group'), null);
  return groups;
}

const defaultGroup = () => groups.find((g) => g.is_default) || null;

// Fills a <select> with the cached groups and selects `selectedId`.
function fillGroupSelect(sel, selectedId) {
  clearChildren(sel);
  const fallback = defaultGroup();
  const target = selectedId || (fallback && fallback.id);
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = String(g.id);
    opt.textContent = g.name;
    if (String(g.id) === String(target)) opt.selected = true;
    sel.appendChild(opt);
  }
}

// The filter carries an extra "All workgroups" option and must survive a
// refresh: rebuilding it after a rename or a delete would otherwise reset
// the view to All underneath whoever was looking at one group. A filter
// pointing at a group that has since been deleted falls back to All.
function fillGroupFilter() {
  const sel = $('#user-group-filter');
  const keep = sel.value;
  clearChildren(sel);
  const all = document.createElement('option');
  all.value = '0';
  all.textContent = 'All workgroups';
  sel.appendChild(all);
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = String(g.id);
    opt.textContent = g.name + ' (' + g.members + ')';
    sel.appendChild(opt);
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '0';
}

async function loadGroups() {
  const tbody = $('#group-table tbody');
  try {
    await refreshGroups();
  } catch (err) {
    clearChildren(tbody);
    stateRow(tbody, 3, 'Could not load', 'The group list is unavailable, not empty.');
    handleError(err, 'Loading workgroups', () => loadGroups());
    return;
  }
  clearChildren(tbody);

  if (!groups.length) {
    stateRow(tbody, 3, 'No groups', 'Add the first workgroup.');
    return;
  }

  for (const g of groups) {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = g.name;
    if (g.is_default) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'default';
      tdName.appendChild(document.createTextNode(' '));
      tdName.appendChild(tag);
    }

    const tdCount = document.createElement('td');
    tdCount.textContent = String(g.members);

    const tdActions = document.createElement('td');
    tdActions.className = 'acts';

    const renameBtn = document.createElement('button');
    renameBtn.textContent = 'Rename';
    renameBtn.setAttribute('aria-label', 'Rename ' + g.name);
    renameBtn.onclick = async () => {
      const r = await confirmDialog({
        title: 'Rename workgroup',
        body: 'Members, standings and the leaderboard are unaffected.',
        confirmText: 'Rename',
        input: { label: 'New name for ' + g.name, value: g.name, maxLength: 120 }
      });
      if (!r.ok) return;
      const name = String(r.value || '').trim();
      if (!name || name === g.name) return;
      try {
        await api('/admin/workgroups', {
          method: 'POST', body: JSON.stringify({ id: g.id, name })
        });
        loadGroups();
        loadUsers();
      } catch (err) {
        handleError(err, 'Renaming ' + g.name);
      }
    };
    tdActions.appendChild(renameBtn);

    // The default group has no delete button because it is the
    // destination every other group's members are moved to. The API
    // refuses it too; this only spares you the round trip.
    if (!g.is_default) {
      const fallback = defaultGroup();
      const delBtn = document.createElement('button');
      delBtn.className = 'danger';
      delBtn.textContent = 'Delete';
      delBtn.setAttribute('aria-label', 'Delete ' + g.name);
      delBtn.onclick = async () => {
        const where = fallback ? fallback.name : 'the default group';
        const msg = g.members
          ? `Its ${g.members} member${g.members === 1 ? ' moves' : 's move'} to ${where}. Nobody is removed.`
          : 'It has no members.';
        const r = await confirmDialog({
          title: 'Delete ' + g.name + '?', body: msg, confirmText: 'Delete', danger: true
        });
        if (!r.ok) return;
        try {
          await api('/admin/workgroups/' + encodeURIComponent(g.id), { method: 'DELETE' });
          loadGroups();
          loadUsers();
        } catch (err) {
          handleError(err, 'Deleting ' + g.name);
        }
      };
      tdActions.appendChild(document.createTextNode(' '));
      tdActions.appendChild(delBtn);
    }

    tr.appendChild(tdName);
    tr.appendChild(tdCount);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }
}


/* ---- Phase 4: last seen ------------------------------------------
   user_meta.updated_at is written on every push and was never surfaced.
   null means the reviewer has never pushed at all -- rendered as "never"
   rather than 0 (which formats as 1 Jan 1970) or today (which would hide
   exactly the dormant account this column exists to find). */
const DAY_MS = 86400000;
const INACTIVE_DAYS = 30;

function lastSeenCell(ts) {
  const td = document.createElement('td');
  if (!ts) {
    const s = document.createElement('span');
    s.className = 'flag no';
    s.textContent = 'never';
    td.appendChild(s);
    return td;
  }
  const days = Math.floor((Date.now() - ts) / DAY_MS);
  const label = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + 'd ago';
  const s = document.createElement('span');
  s.textContent = label;
  s.title = new Date(ts).toLocaleString();
  td.appendChild(s);
  if (days >= INACTIVE_DAYS) {
    td.appendChild(document.createTextNode(' '));
    const chip = document.createElement('span');
    chip.className = 'pill off';
    chip.textContent = 'Inactive ' + INACTIVE_DAYS + 'd+';
    td.appendChild(chip);
  }
  return td;
}

/* ---- Phase 5: bulk selection --------------------------------------
   Cleared on every reload, and deliberately not carried across pages: a
   selection you cannot see is a selection you cannot check before
   pressing Revoke. */
let selected = new Set();

function syncBulkBar() {
  const bar = $('#bulk-bar');
  bar.hidden = selected.size === 0;
  $('#bulk-count').textContent = selected.size + ' selected';
  const boxes = Array.from(document.querySelectorAll('.row-select'));
  const all = boxes.length > 0 && boxes.every((b) => b.checked);
  $('#select-all').checked = all;
  $('#select-all').indeterminate = !all && selected.size > 0;
}

async function runBulk(action, extra) {
  const usernames = Array.from(selected);
  if (!usernames.length) return;
  try {
    const r = await api('/admin/users/bulk-action', {
      method: 'POST', body: JSON.stringify({ usernames, action, ...(extra || {}) })
    });
    // Reported rather than assumed: the server skips names that no longer
    // exist, so "2 selected" and "2 changed" are not the same claim.
    messageDialog({
      title: 'Bulk ' + action + ' complete',
      body: r.affected === r.requested ? ''
        : 'Names the server no longer has are skipped, so these two can differ.',
      rows: [['Requested', r.requested], ['Changed', r.affected]]
    });
    selected = new Set();
    loadUsers();
    loadGroups().catch(() => {});
    loadStats();
  } catch (err) {
    handleError(err, 'Bulk ' + action);
  }
}

/* Two user loads can be in flight at once -- the search box debounces one
   while a filter change fires another immediately -- and nothing makes the
   responses come back in the order they were asked for. Without this the
   SLOWER, older answer paints last and the table ends up showing a result
   set the filters on screen no longer describe. Each load takes a ticket;
   a load that is no longer the newest throws its answer away. */
let usersLoadSeq = 0;

async function loadUsers() {
  const seq = ++usersLoadSeq;
  const q = encodeURIComponent($('#user-search').value.trim());
  // '' (the "All workgroups" option) sends 0, which the server reads as
  // "every group" rather than as a group that happens to have id 0.
  const wg = encodeURIComponent($('#user-group-filter').value || '0');
  const status = encodeURIComponent($('#user-status-filter').value || 'all');
  const tbody = $('#user-table tbody');
  let data;
  try {
    data = await api(`/admin/users?q=${q}&workgroup_id=${wg}&status=${status}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`);
  } catch (err) {
    if (seq !== usersLoadSeq) return;
    clearChildren(tbody);
    stateRow(tbody, 10, 'Could not load', 'The list is unavailable, not empty.');
    handleError(err, 'Loading users', () => loadUsers());
    return;
  }
  if (seq !== usersLoadSeq) return;   // a newer load is already on its way
  clearChildren(tbody);
  selected = new Set();

  if (!data.users.length) {
    // A filtered empty result is not the same as an empty allow-list, and
    // saying "No users yet" while a filter is on reads as data loss.
    const filtered = ($('#user-group-filter').value || '0') !== '0';
    const byStatus = ($('#user-status-filter').value || 'all') !== 'all';
    if (q || filtered || byStatus) {
      const by = [
        q ? 'that search' : null,
        filtered ? 'that workgroup' : null,
        byStatus ? 'that access state' : null
      ].filter(Boolean).join(' and ');
      stateRow(tbody, 10, 'No match', 'Nobody matches ' + by + '.');
    } else {
      stateRow(tbody, 10, 'No users yet', 'Add the first user to the allow-list.');
    }
  }

  for (const u of data.users) {
    const tr = document.createElement('tr');

    const tdPick = document.createElement('td');
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'row-select';
    // The username travels as data, not as label prose. select-all used to
    // recover it by stripping "Select " off the aria-label, which quietly
    // tied bulk actions to the exact wording of a screen-reader string.
    pick.dataset.username = u.username;
    pick.setAttribute('aria-label', 'Select ' + u.username);
    pick.onchange = () => {
      if (pick.checked) selected.add(u.username); else selected.delete(u.username);
      syncBulkBar();
    };
    tdPick.appendChild(pick);

    const tdUser = document.createElement('td');
    tdUser.textContent = u.username;
    if (!u.authorized) tdUser.className = 'revoked';

    const tdAccess = document.createElement('td');
    tdAccess.appendChild(pill(u.authorized, 'Active', 'Revoked'));

    // Assigning a group writes immediately — no dialog, no Save. On
    // failure the select is put back to where it was, so the row never
    // shows a group the server did not accept.
    const tdGroup = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'group-select';
    sel.setAttribute('aria-label', 'Workgroup for ' + u.username);
    fillGroupSelect(sel, u.workgroup_id);
    let lastGroup = sel.value;
    sel.onchange = async () => {
      const chosen = sel.value;
      sel.disabled = true;
      try {
        await api('/admin/users', {
          method: 'POST',
          body: JSON.stringify({ username: u.username, workgroup_id: Number(chosen) })
        });
        lastGroup = chosen;
        u.workgroup_id = Number(chosen);
        loadGroups().catch(() => {});   // member counts moved
      } catch (err) {
        sel.value = lastGroup;
        handleError(err, 'Moving ' + u.username);
      } finally {
        sel.disabled = false;
      }
    };
    tdGroup.appendChild(sel);

    const tdRainbow = flagCell(u.rainbow);
    const tdThemes = flagCell(u.themes);
    const tdTemplates = flagCell(u.templates);
    const tdLastSeen = lastSeenCell(u.last_seen);

    const tdNote = document.createElement('td');
    tdNote.textContent = u.note || '';

    const tdActions = document.createElement('td');
    tdActions.className = 'acts';
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-label', 'Edit ' + u.username);
    editBtn.onclick = () => openUserDialog(u);
    // Revoke is reversible, so the row has to offer the way back. It used to
    // render an unconditional red "Revoke" — a no-op on an already-revoked
    // user — which left Edit → tick Authorized → Save as the only route back,
    // and nothing on the row hinted that it existed.
    const accessBtn = document.createElement('button');
    if (u.authorized) {
      accessBtn.className = 'danger';
      accessBtn.textContent = 'Revoke';
      accessBtn.setAttribute('aria-label', 'Revoke ' + u.username);
      accessBtn.onclick = async () => {
        const r = await confirmDialog({
          title: 'Revoke access?',
          body: `${u.username} loses access to the assistant. Their leaderboard history is kept, and Restore puts it back.`,
          confirmText: 'Revoke', danger: true
        });
        if (!r.ok) return;
        try {
          await api('/admin/users/' + encodeURIComponent(u.username), { method: 'DELETE' });
          loadUsers();
          loadStats();
        } catch (err) {
          handleError(err, 'Revoking ' + u.username);
        }
      };
    } else {
      // No confirm(): restoring access is the reversible direction, and a
      // dialog on the safe action trains people to click through the one on
      // the dangerous one.
      accessBtn.className = 'primary';
      accessBtn.textContent = 'Restore';
      accessBtn.setAttribute('aria-label', 'Restore access for ' + u.username);
      accessBtn.onclick = async () => {
        try {
          await api('/admin/users/' + encodeURIComponent(u.username) + '/restore', { method: 'POST' });
          loadUsers();
          loadStats();
        } catch (err) {
          handleError(err, 'Restoring ' + u.username);
        }
      };
    }
    // Revoke is reversible and keeps the row; Delete removes it and keeps
    // the history. Both are offered because they answer different
    // questions — "they left the team" versus "they should never have
    // been on this list".
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.setAttribute('aria-label', 'Delete ' + u.username);
    deleteBtn.onclick = () => openDeleteDialog(u);

    tdActions.appendChild(editBtn);
    tdActions.appendChild(document.createTextNode(' '));
    tdActions.appendChild(accessBtn);
    tdActions.appendChild(document.createTextNode(' '));
    tdActions.appendChild(deleteBtn);

    tr.appendChild(tdPick);
    tr.appendChild(tdUser);
    tr.appendChild(tdAccess);
    tr.appendChild(tdGroup);
    tr.appendChild(tdRainbow);
    tr.appendChild(tdThemes);
    tr.appendChild(tdTemplates);
    tr.appendChild(tdLastSeen);
    tr.appendChild(tdNote);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }

  syncBulkBar();

  const from = data.total ? page * PAGE_SIZE + 1 : 0;
  $('#page-info').textContent = `${from}–${Math.min(data.total, (page + 1) * PAGE_SIZE)} of ${data.total}`;
  $('#prev-page').disabled = page === 0;
  $('#next-page').disabled = (page + 1) * PAGE_SIZE >= data.total;
}

/* ---- delete + standings ---------------------------------------- */
let pendingDelete = null;
let pendingStats = null;

function openDeleteDialog(user) {
  pendingDelete = user;
  $('#delete-dialog-title').textContent = 'Delete ' + user.username;
  $('#f-board-hide').checked = true;
  // Reset every time: a dialog that opens already-confirmed from the last
  // delete is worse than no confirmation at all.
  $('#f-delete-name').textContent = user.username;
  $('#f-delete-confirm').value = '';
  $('#f-delete-save').disabled = true;
  $('#delete-dialog').returnValue = '';
  $('#delete-dialog').showModal();
}

function openStatsDialog(row) {
  pendingStats = row;
  $('#stats-dialog-title').textContent = 'Edit ' + row.username;
  const overridden = row.total_override !== null && row.total_override !== undefined;
  $('#f-stats-total').value = row.total;
  // Showing the real number matters when an override is hiding it —
  // otherwise there is no way to tell what clearing would restore.
  $('#stats-real').textContent = overridden
    ? '(overridden — their real count is ' + (row.raw_total || 0) + ')'
    : '(their real count)';
  $('#f-stats-clear').disabled = !overridden;
  $('#stats-dialog').returnValue = '';
  $('#stats-dialog').showModal();
}

/* ---- achievements ------------------------------------------------
   The catalog comes from the API rather than being restated here: the
   worker mirrors the client's list and has a test that fails if the two
   drift, so there is exactly one place a new achievement has to be
   registered for the panel to offer it. Fetched once and cached. */
let achCatalog = null;
let pendingAch = null;

async function loadAchCatalog() {
  if (achCatalog) return achCatalog;
  const data = await api('/admin/achievements');
  achCatalog = data.achievements || [];
  return achCatalog;
}

async function openAchDialog(row) {
  pendingAch = row;
  $('#ach-dialog-title').textContent = 'Achievements — ' + row.username;
  const list = $('#ach-list');
  clearChildren(list);

  let catalog, current;
  try {
    [catalog, current] = await Promise.all([
      loadAchCatalog(),
      api('/admin/users/' + encodeURIComponent(row.username) + '/achievements')
    ]);
  } catch (err) {
    pendingAch = null;
    handleError(err, 'Loading achievements for ' + row.username);
    return;
  }

  const unlocked = current.unlocked || {};
  for (const a of catalog) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = a.id;
    cb.checked = Object.prototype.hasOwnProperty.call(unlocked, a.id);
    const icon = document.createElement('span');
    icon.className = 'ach-icon';
    icon.textContent = a.icon || '';
    const text = document.createElement('span');
    // The unlock date is the thing an admin needs to see to judge whether
    // a tick is real or something they granted by hand a minute ago.
    text.textContent = a.name + (cb.checked && unlocked[a.id]
      ? ' · ' + new Date(unlocked[a.id]).toLocaleDateString()
      : '');
    label.appendChild(cb);
    label.appendChild(icon);
    label.appendChild(text);
    list.appendChild(label);
  }

  $('#ach-dialog').returnValue = '';
  $('#ach-dialog').showModal();
}

/* ---- the admin's view of the board ------------------------------ */
function fillBoardFilter() {
  const sel = $('#board-group-filter');
  const keep = sel.value;
  clearChildren(sel);
  const all = document.createElement('option');
  all.value = '0';
  all.textContent = 'All workgroups';
  sel.appendChild(all);
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = String(g.id);
    opt.textContent = g.name;
    sel.appendChild(opt);
  }
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '0';
}

async function loadBoard() {
  const tbody = $('#board-table tbody');
  const wg = $('#board-group-filter').value || '0';
  let data;
  try {
    data = await api('/admin/leaderboard?workgroup_id=' + encodeURIComponent(wg));
  } catch (err) {
    clearChildren(tbody);
    stateRow(tbody, 6, 'Could not load', 'The board is unavailable, not empty.');
    handleError(err, 'Loading the leaderboard', () => loadBoard());
    return;
  }
  clearChildren(tbody);

  if (!data.rows.length) {
    stateRow(tbody, 6, 'Nobody here', wg === '0'
      ? 'No users on the allow-list yet.'
      : 'This workgroup has no members.');
    return;
  }

  data.rows.forEach((r, i) => {
    const tr = document.createElement('tr');

    const tdRank = document.createElement('td');
    tdRank.textContent = String(i + 1);

    const tdUser = document.createElement('td');
    tdUser.textContent = r.username;
    if (!r.authorized) tdUser.className = 'revoked';

    const tdGroup = document.createElement('td');
    tdGroup.textContent = r.workgroup || '—';

    const tdTotal = document.createElement('td');
    tdTotal.textContent = String(r.total);
    if (r.total_override !== null && r.total_override !== undefined) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'edited';
      tag.title = 'Real count: ' + (r.raw_total || 0);
      tdTotal.appendChild(document.createTextNode(' '));
      tdTotal.appendChild(tag);
    }

    const tdAcc = document.createElement('td');
    tdAcc.textContent = String(r.acc);

    const tdActions = document.createElement('td');
    tdActions.className = 'acts';
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.setAttribute('aria-label', 'Edit standing for ' + r.username);
    editBtn.onclick = () => openStatsDialog(r);
    const achBtn = document.createElement('button');
    achBtn.textContent = 'Achievements';
    achBtn.setAttribute('aria-label', 'Edit achievements for ' + r.username);
    achBtn.onclick = () => openAchDialog(r);
    tdActions.appendChild(editBtn);
    tdActions.appendChild(document.createTextNode(' '));
    tdActions.appendChild(achBtn);

    tr.appendChild(tdRank);
    tr.appendChild(tdUser);
    tr.appendChild(tdGroup);
    tr.appendChild(tdTotal);
    tr.appendChild(tdAcc);
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  });
}

function openUserDialog(user) {
  $('#user-dialog-title').textContent = user ? 'Edit ' + user.username : 'Add user';
  $('#f-username').value = user ? user.username : '';
  $('#f-username').readOnly = !!user;
  fillGroupSelect($('#f-workgroup'), user ? user.workgroup_id : null);
  $('#f-authorized').checked = user ? !!user.authorized : true;
  $('#f-rainbow').checked = user ? !!user.rainbow : false;
  $('#f-themes').checked = user ? !!user.themes : false;
  // Defaults to ticked for a new user: the capability is on for everyone and
  // revoked case by case, unlike rainbow and themes above.
  $('#f-templates').checked = user ? !!user.templates : true;
  $('#f-note').value = user ? (user.note || '') : '';
  // returnValue is NOT reset by the dialog itself on an Escape-dismiss
  // (Escape fires 'cancel' then 'close' but leaves returnValue untouched),
  // so a stale 'save' from a previous successful save would otherwise
  // cause the next Escape-dismiss to silently re-submit. Reset it here.
  $('#user-dialog').returnValue = '';
  $('#user-dialog').showModal();
}

/* ---- status templates -------------------------------------------
   Every template body is written with textContent, never innerHTML. These
   strings come from reviewers, and one of them typing "<b>" must render as
   those four characters in this table exactly as it does in the assistant's
   dropdown. That is the whole reason the client stores them verbatim rather
   than sanitising on the way in. */
/* Which field's list this tab is showing. Read from the selector on every
   call rather than cached, so a write and the reload that follows it can
   never disagree about which list they meant. */
const tplField = () => $('#tpl-field').value;

const TPL_FIELD_HINTS = {
  currentStatus: 'Picking one of these REPLACES the Current Status box in the assistant.',
  actionsRequired: 'Picking one of these APPENDS a line to Actions Required, keeping what is already there. ' +
                   'Include the bullet character you want (e.g. "- " or "* ") — the assistant adds none.'
};

/* The row being dragged, shared between the handle that started the drag
   and the rows it passes over. */
let dragRow = null;

/* Persist the order the table is currently in.

   Sends the WHOLE list of ids, which is what the endpoint requires: a
   partial list is refused rather than half-applied, so a tab left open
   while somebody else added a wording fails loudly and reloads instead of
   quietly dropping that wording out of the order. */
async function saveTemplateOrder(tbody) {
  const ids = [...tbody.querySelectorAll('tr[data-id]')].map((tr) => Number(tr.dataset.id));
  if (!ids.length) return;
  try {
    await api('/admin/templates/reorder', {
      method: 'POST', body: JSON.stringify({ field: tplField(), ids })
    });
    // Reload rather than trust the DOM: the server is the authority on the
    // order, and a refused reorder must not leave the table showing one.
    loadTemplates();
  } catch (err) {
    handleError(err, 'Saving the template order');
    loadTemplates();
  }
}

async function loadTemplates() {
  const filter = encodeURIComponent($('#tpl-user-filter').value.trim());
  const field = tplField();
  $('#tpl-field-hint').textContent = TPL_FIELD_HINTS[field] || '';
  const data = await api('/admin/templates?field=' + encodeURIComponent(field) + '&username=' + filter);

  const globalBody = $('#tpl-global-table tbody');
  clearChildren(globalBody);
  if (!(data.globalRows || []).length) {
    stateRow(globalBody, 3, 'No global templates', 'Everyone falls back to the built-in list.');
  }
  for (const t of data.globalRows || []) {
    const tr = document.createElement('tr');
    tr.dataset.id = String(t.id);

    /* The handle is draggable, not the row. Dragging the row itself would
       fight the text input inside it -- you could not select a wording to
       edit it without starting a drag. */
    const tdGrip = document.createElement('td');
    tdGrip.className = 'grip-cell';
    const grip = document.createElement('span');
    grip.className = 'grip';
    grip.draggable = true;
    grip.textContent = '☰';
    grip.title = 'Drag to reorder';
    grip.setAttribute('aria-label', 'Drag to reorder this template');
    grip.ondragstart = (e) => {
      dragRow = tr;
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox ignores a drag that sets no data.
      e.dataTransfer.setData('text/plain', String(t.id));
    };
    grip.ondragend = () => {
      tr.classList.remove('dragging');
      dragRow = null;
    };
    tdGrip.appendChild(grip);
    tr.appendChild(tdGrip);

    /* Drop targeting lives on the ROW: the pointer is over a row, not over
       the two-pixel handle, for almost the whole gesture. */
    tr.ondragover = (e) => {
      if (!dragRow || dragRow === tr) return;
      e.preventDefault();
      const box = tr.getBoundingClientRect();
      const below = (e.clientY - box.top) > box.height / 2;
      globalBody.insertBefore(dragRow, below ? tr.nextSibling : tr);
    };
    tr.ondrop = (e) => {
      e.preventDefault();
      saveTemplateOrder(globalBody);
    };

    // Editable in place: a typo in a wording everyone sees should not need a
    // dialog, and the field already carries the current text.
    const tdBody = document.createElement('td');
    const input = document.createElement('input');
    input.value = t.body;
    input.maxLength = 300;
    input.className = 'tpl-edit';
    input.setAttribute('aria-label', 'Global template');
    let last = t.body;
    input.onchange = async () => {
      const next = input.value.trim();
      if (!next || next === last) { input.value = last; return; }
      input.disabled = true;
      try {
        await api('/admin/templates', { method: 'POST', body: JSON.stringify({ id: t.id, body: next }) });
        last = next;
      } catch (err) {
        input.value = last;
        handleError(err, 'Saving the template');
      } finally {
        input.disabled = false;
      }
    };
    tdBody.appendChild(input);

    const tdActs = document.createElement('td');
    tdActs.className = 'acts';
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', 'Delete global template');
    del.onclick = async () => {
      const r = await confirmDialog({
        title: 'Delete global template?',
        body: 'Reviewers lose it from their dropdown. Anything already written into a case is untouched.',
        confirmText: 'Delete', danger: true
      });
      if (!r.ok) return;
      try {
        await api('/admin/templates/' + t.id, { method: 'DELETE' });
        loadTemplates();
      } catch (err) { handleError(err, 'Deleting the template'); }
    };
    tdActs.appendChild(del);

    tr.appendChild(tdBody);
    tr.appendChild(tdActs);
    globalBody.appendChild(tr);
  }

  const ownedBody = $('#tpl-owned-table tbody');
  clearChildren(ownedBody);
  if (!(data.owned || []).length) {
    const f = $('#tpl-user-filter').value.trim();
    stateRow(ownedBody, 3, f ? 'No match' : 'Nothing saved yet',
      f ? 'Nobody matching that filter has saved a template.'
        : 'Reviewers have not saved any templates of their own.');
  }
  for (const t of data.owned || []) {
    const tr = document.createElement('tr');

    const tdUser = document.createElement('td');
    tdUser.textContent = t.username;

    const tdBody = document.createElement('td');
    tdBody.textContent = t.body;

    const tdActs = document.createElement('td');
    tdActs.className = 'acts';

    // Promotion copies into the global list and leaves the reviewer's own
    // copy alone -- taking it away would punish them for writing something
    // good enough to share.
    const promote = document.createElement('button');
    promote.textContent = 'Promote';
    promote.setAttribute('aria-label', 'Promote ' + t.username + '’s template to global');
    promote.onclick = async () => {
      try {
        await api('/admin/templates', { method: 'POST', body: JSON.stringify({ promote: t.id }) });
        loadTemplates();
      } catch (err) { handleError(err, 'Promoting the template'); }
    };

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', 'Delete ' + t.username + '’s template');
    del.onclick = async () => {
      const r = await confirmDialog({
        title: 'Delete this template?',
        body: `Saved by ${t.username}. It disappears from their dropdown.`,
        confirmText: 'Delete', danger: true
      });
      if (!r.ok) return;
      try {
        await api('/admin/templates/' + t.id, { method: 'DELETE' });
        loadTemplates();
      } catch (err) { handleError(err, 'Deleting the template'); }
    };

    tdActs.appendChild(promote);
    tdActs.appendChild(document.createTextNode(' '));
    tdActs.appendChild(del);

    tr.appendChild(tdUser);
    tr.appendChild(tdBody);
    tr.appendChild(tdActs);
    ownedBody.appendChild(tr);
  }
}

/* ---- login greetings --------------------------------------------
   Windows are minutes past LOCAL midnight, and the <input type="time">
   pair is just a friendlier face on those two numbers. 24:00 is spelled
   1440 and cannot be typed into a time input, so it round-trips through
   '24:00' explicitly -- without that, "all day" saves as 0-0 and the
   greeting never shows. */
/* 1440 means "end of day" and has no spelling an <input type="time"> will
   accept: the control's range is 00:00-23:59, so assigning '24:00' is
   rejected and the field renders EMPTY -- which is how an "all day"
   greeting ended up showing a blank end time.

   So 1440 is shown as 23:59 and read back as 1440. The cost is that
   end_min 1439 cannot be expressed through this control, which is a
   distinction without a difference: a greeting that stops one minute
   before midnight versus at midnight is the same greeting. Storing 1440
   rather than 1439 is what keeps the final minute of the day covered. */
const END_OF_DAY = 1440;
const minToTime = (m) => {
  const n = Math.max(0, Math.min(END_OF_DAY, Number(m) || 0));
  const shown = n === END_OF_DAY ? 1439 : n;
  return String(Math.floor(shown / 60)).padStart(2, '0') + ':' + String(shown % 60).padStart(2, '0');
};
const timeToMin = (v) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  if (mins < 0 || mins > END_OF_DAY) return null;
  return mins === 1439 ? END_OF_DAY : mins;
};

async function loadGreetings() {
  const data = await api('/admin/greetings');
  const tbody = $('#greet-table tbody');
  clearChildren(tbody);

  if (!(data.greetings || []).length) {
    stateRow(tbody, 5, 'No greetings', 'The assistant falls back to its built-in messages.');
    return;
  }

  for (const g of data.greetings) {
    const tr = document.createElement('tr');
    if (!g.enabled) tr.className = 'revoked';

    // One saver for the whole row: the API takes a row at a time, and
    // sending only the changed field would blank the others.
    const save = async (patch, revert) => {
      try {
        await api('/admin/greetings', {
          method: 'POST',
          body: JSON.stringify({ greetings: [{
            id: g.id, body: g.body, start_min: g.start_min,
            end_min: g.end_min, enabled: g.enabled, sort: g.sort, ...patch
          }] })
        });
        Object.assign(g, patch);
      } catch (err) {
        if (revert) revert();
        handleError(err, 'Saving the greeting');
      }
    };

    const tdBody = document.createElement('td');
    const bodyInput = document.createElement('input');
    bodyInput.value = g.body;
    bodyInput.maxLength = 200;
    bodyInput.className = 'tpl-edit';
    bodyInput.setAttribute('aria-label', 'Greeting message');
    bodyInput.onchange = () => {
      const next = bodyInput.value.trim();
      if (!next || next === g.body) { bodyInput.value = g.body; return; }
      save({ body: next }, () => { bodyInput.value = g.body; });
    };
    tdBody.appendChild(bodyInput);

    const timeCell = (key) => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'time';
      input.value = minToTime(g[key]);
      input.setAttribute('aria-label', key === 'start_min' ? 'Window start' : 'Window end');
      input.onchange = () => {
        const mins = timeToMin(input.value);
        if (mins === null) { input.value = minToTime(g[key]); return; }
        save({ [key]: mins }, () => { input.value = minToTime(g[key]); });
      };
      td.appendChild(input);
      return td;
    };

    const tdOn = document.createElement('td');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = !!g.enabled;
    toggle.setAttribute('aria-label', 'Enabled');
    toggle.onchange = async () => {
      const want = toggle.checked ? 1 : 0;
      await save({ enabled: want }, () => { toggle.checked = !toggle.checked; });
      tr.className = g.enabled ? '' : 'revoked';
    };
    tdOn.appendChild(toggle);

    const tdActs = document.createElement('td');
    tdActs.className = 'acts';
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', 'Delete this greeting');
    del.onclick = async () => {
      const r = await confirmDialog({
        title: 'Delete this greeting?', body: g.body, confirmText: 'Delete', danger: true
      });
      if (!r.ok) return;
      try {
        await api('/admin/greetings/' + g.id, { method: 'DELETE' });
        loadGreetings();
      } catch (err) { handleError(err, 'Deleting the greeting'); }
    };
    tdActs.appendChild(del);

    tr.appendChild(tdBody);
    tr.appendChild(timeCell('start_min'));
    tr.appendChild(timeCell('end_min'));
    tr.appendChild(tdOn);
    tr.appendChild(tdActs);
    tbody.appendChild(tr);
  }
}


/* ---- Phase 6: admin action log -----------------------------------
   Records WHAT was done, not WHO -- there is a single admin password.
   The UI says so next to the table rather than letting the column
   headings imply an accountability trail this cannot provide. */
function renderActions(tbody, rows, colspan) {
  clearChildren(tbody);
  if (!rows.length) {
    stateRow(tbody, colspan, 'Nothing yet', 'Admin changes will appear here.');
    return;
  }
  for (const a of rows) {
    const tr = document.createElement('tr');
    const when = document.createElement('td');
    when.textContent = new Date(a.ts).toLocaleString();
    const what = document.createElement('td');
    what.textContent = a.action;
    const target = document.createElement('td');
    target.textContent = a.target || '';
    const detail = document.createElement('td');
    detail.textContent = a.detail || '';
    tr.appendChild(when); tr.appendChild(what);
    tr.appendChild(target); tr.appendChild(detail);
    tbody.appendChild(tr);
  }
}

async function loadAdminActions() {
  const data = await api('/admin/actions?limit=200');
  renderActions($('#admin-actions-table tbody'), data.actions || [], 4);
}

/* ---- Phase 7: overview -------------------------------------------
   Reads /admin/stats and the action log. The reviews-per-day trend comes
   from the stats endpoint, which reads the cron-built snapshot -- a live
   scan of `daily` would cost ~24,500 row reads per view. */
function statCard(label, value, sub) {
  const card = document.createElement('div');
  card.className = 'ov-card';
  const v = document.createElement('div');
  v.className = 'ov-value';
  v.textContent = String(value);
  const l = document.createElement('div');
  l.className = 'ov-label';
  l.textContent = label;
  card.appendChild(v);
  card.appendChild(l);
  if (sub) {
    const sm = document.createElement('div');
    sm.className = 'ov-sub';
    sm.textContent = sub;
    card.appendChild(sm);
  }
  return card;
}

/* The header bar and the Overview cards are two readers of one answer,
   and start() loads them together -- which used to mean two /admin/stats
   round trips per boot for identical data. Callers in the same tick share
   the in-flight request; the next tick gets a fresh one, so nothing here
   caches a stale number. D1 allows 50 queries per invocation, and paying
   twice for one answer is the cheapest waste in the panel to remove. */
let statsInFlight = null;
function fetchStats() {
  if (!statsInFlight) {
    statsInFlight = api('/admin/stats');
    statsInFlight.catch(() => {}).then(() => { statsInFlight = null; });
  }
  return statsInFlight;
}

async function loadOverview() {
  const [stats, actions] = await Promise.all([
    fetchStats(),
    api('/admin/actions?limit=15').catch(() => ({ actions: [] }))
  ]);

  const cards = $('#ov-cards');
  clearChildren(cards);
  cards.appendChild(statCard('Users', stats.users.total,
    stats.users.authorized + ' active · ' + stats.users.revoked + ' revoked'));
  cards.appendChild(statCard('Workgroups', (stats.workgroups && stats.workgroups.total) || 0));
  cards.appendChild(statCard('Themes enabled', stats.themes.enabled + '/' + stats.themes.total));
  const age = stats.snapshotAgeMs === null || stats.snapshotAgeMs === undefined
    ? 'never built'
    : Math.round(stats.snapshotAgeMs / 60000) + ' min old';
  cards.appendChild(statCard('Leaderboard', 'snapshot', age));

  // The trend is drawn as plain bars rather than a chart library: the
  // panel loads no external scripts, and 14 numbers do not need one.
  const trend = $('#ov-trend');
  clearChildren(trend);
  const days = (stats.daily && stats.daily.length) ? stats.daily : [];
  if (!days.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'No review activity recorded yet.';
    trend.appendChild(empty);
  } else {
    const max = Math.max(...days.map((d) => d.count), 1);
    for (const d of days) {
      const col = document.createElement('div');
      col.className = 'ov-bar';
      col.title = d.day + ': ' + d.count + ' reviews';
      const fill = document.createElement('div');
      fill.className = 'ov-bar-fill';
      // Floor at 2% so a day with a single review is still visibly
      // different from a day with none.
      fill.style.height = (d.count ? Math.max(2, (d.count / max) * 100) : 0) + '%';
      const lab = document.createElement('span');
      lab.textContent = String(d.count);
      col.appendChild(fill);
      col.appendChild(lab);
      trend.appendChild(col);
    }
  }

  renderActions($('#ov-actions tbody'), actions.actions || [], 4);
}

/* ---- Phase 8: settings -------------------------------------------
   /admin/settings has existed as a full GET/POST endpoint with no UI at
   all; the only setting reachable before this was defaultTheme, tucked
   inside the Themes tab. */
async function loadSettings() {
  const data = await api('/admin/settings');
  const tbody = $('#settings-table tbody');
  clearChildren(tbody);

  const entries = Object.entries(data.settings || {});
  if (!entries.length) {
    stateRow(tbody, 3, 'No settings', 'Nothing has been set yet.');
    return;
  }

  for (const [key, value] of entries) {
    const tr = document.createElement('tr');
    const tdKey = document.createElement('td');
    tdKey.textContent = key;

    const tdVal = document.createElement('td');
    const input = document.createElement('input');
    input.value = value;
    input.maxLength = 200;
    input.className = 'tpl-edit';
    input.setAttribute('aria-label', 'Value for ' + key);
    let last = value;
    input.onchange = async () => {
      const next = input.value;
      if (next === last) return;
      try {
        await api('/admin/settings', { method: 'POST', body: JSON.stringify({ settings: { [key]: next } }) });
        last = next;
      } catch (err) {
        input.value = last;
        handleError(err, 'Saving ' + key);
      }
    };
    tdVal.appendChild(input);

    const tdActs = document.createElement('td');
    tdActs.className = 'acts';
    tr.appendChild(tdKey); tr.appendChild(tdVal); tr.appendChild(tdActs);
    tbody.appendChild(tr);
  }
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

/* ---- audit export ---------------------------------------------
   Built from a fresh fetch rather than by scraping the rendered table,
   so the file matches the server rather than whatever the tab happened
   to be showing. Deliberately fetches a much higher limit than the
   view does: exporting only the 200 rows on screen would quietly
   produce a partial file with no sign that anything was missing. */
function toCsvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  // A leading =, +, - or @ makes Excel treat the cell as a formula. The
  // detail column carries attacker-supplied text, so prefix those with a
  // quote rather than handing someone a spreadsheet that executes it.
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return '"' + safe.replace(/"/g, '""') + '"';
}

async function exportAudit() {
  const btn = $('#export-audit-btn');
  btn.disabled = true;
  try {
    const data = await api('/admin/rejects?limit=500');
    const rows = data.rejects || [];
    if (!rows.length) {
      await messageDialog({ title: 'Nothing to export', body: 'The audit log is empty.' });
      return;
    }

    const csv = [['when', 'timestamp_ms', 'username', 'reason', 'detail'].join(',')]
      .concat(rows.map((r) => [
        toCsvCell(new Date(r.ts).toISOString()),
        toCsvCell(r.ts),
        toCsvCell(r.username),
        toCsvCell(r.reason),
        toCsvCell(r.detail)
      ].join(',')))
      .join('\r\n');

    // BOM so Excel reads it as UTF-8 rather than the system codepage.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cra-audit-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a later turn of the event loop: revoking synchronously
    // races the download in some browsers and yields an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    handleError(err, 'Exporting the audit log');
  } finally {
    btn.disabled = false;
  }
}

async function loadStats() {
  const s = await fetchStats();
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
  if (btn.dataset.tab === 'overview') loadOverview().catch((err) => handleError(err, 'Loading the overview', () => loadOverview().catch(() => {})));
  if (btn.dataset.tab === 'settings') loadSettings().catch((err) => handleError(err, 'Loading settings'));
  if (btn.dataset.tab === 'groups') loadGroups();
  if (btn.dataset.tab === 'board') loadBoard();
  if (btn.dataset.tab === 'content') {
    loadTemplates().catch((err) => handleError(err, 'Loading templates', () => loadTemplates().catch(() => {})));
    loadGreetings().catch((err) => handleError(err, 'Loading greetings'));
  }
  if (btn.dataset.tab === 'themes') loadThemes().catch((err) => handleError(err, 'Loading themes', () => loadThemes().catch(() => {})));
  if (btn.dataset.tab === 'audit') {
    loadAudit().catch((err) => handleError(err, 'Loading the audit log'));
    loadAdminActions().catch((err) => handleError(err, 'Loading admin actions'));
  }
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

// Both reset to page 0: staying on page 3 of an unfiltered list after
// narrowing to a five-person group shows an empty table that reads as
// data loss.
$('#user-group-filter').onchange = () => { page = 0; loadUsers(); };
$('#user-status-filter').onchange = () => { page = 0; loadUsers(); };


/* ---- Phase 5: bulk bar -------------------------------------------- */
$('#select-all').onchange = () => {
  const on = $('#select-all').checked;
  for (const box of document.querySelectorAll('.row-select')) {
    box.checked = on;
    const name = box.dataset.username;
    if (on) selected.add(name); else selected.delete(name);
  }
  syncBulkBar();
};
$('#bulk-clear-btn').onclick = () => {
  selected = new Set();
  for (const box of document.querySelectorAll('.row-select')) box.checked = false;
  syncBulkBar();
};
$('#bulk-revoke-btn').onclick = async () => {
  const n = selected.size;
  const r = await confirmDialog({
    title: `Revoke ${n} user${n === 1 ? '' : 's'}?`,
    body: 'They lose access to the assistant. Their leaderboard history is kept, and Restore puts it back.',
    confirmText: 'Revoke', danger: true
  });
  if (!r.ok) return;
  runBulk('revoke');
};
$('#bulk-restore-btn').onclick = () => runBulk('restore');
$('#bulk-move-btn').onclick = () => {
  const id = Number($('#bulk-move-group').value);
  if (!id) return;
  runBulk('move', { workgroup_id: id });
};
$('#bulk-delete-btn').onclick = async () => {
  // Typing the count is the same guard the single-user delete uses, scaled
  // to a batch: the destructive path should cost a deliberate keystroke.
  const n = selected.size;
  const r = await confirmDialog({
    title: `Delete ${n} user${n === 1 ? '' : 's'}?`,
    body: 'This removes them from the allow-list and hides them from the leaderboard. Their review history is kept, so re-adding the same username restores everything.',
    confirmText: 'Delete', danger: true,
    typeToConfirm: String(n)
  });
  if (!r.ok) return;
  runBulk('delete');
};

/* ---- Phase 9: type-to-confirm delete -------------------------------
   Delete and Revoke are adjacent and both red, and only one is
   reversible. Requiring the username removes the misclick. */
$('#f-delete-confirm').oninput = () => {
  const want = $('#f-delete-name').textContent.trim().toLowerCase();
  const got = $('#f-delete-confirm').value.trim().toLowerCase();
  $('#f-delete-save').disabled = !want || got !== want;
};

/* ---- Content tab ---- */
const addGlobalTemplate = async () => {
  const input = $('#tpl-new');
  const body = input.value.trim();
  if (!body) return;
  try {
    await api('/admin/templates', { method: 'POST', body: JSON.stringify({ body, field: tplField() }) });
    input.value = '';
    loadTemplates();
  } catch (err) {
    // The field keeps its text on failure, so a rejected 301-character
    // template is still there to shorten rather than retyped from memory.
    handleError(err, 'Adding the template');
  }
};
$('#tpl-add-btn').onclick = addGlobalTemplate;
$('#tpl-new').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addGlobalTemplate(); }
});
$('#tpl-refresh-btn').onclick = () => {
  loadTemplates().catch((err) => handleError(err, 'Refreshing templates'));
  loadGreetings().catch((err) => handleError(err, 'Refreshing greetings'));
};

// Live preview of {name} substitution, so an admin can see the result
// before saving rather than discovering the token did not take.
const renderGreetPreview = () => {
  const raw = $('#greet-new').value.trim();
  $('#greet-preview').textContent = raw
    ? 'Preview: ' + raw.split('{name}').join('odemar')
    : '';
};
$('#greet-new').oninput = renderGreetPreview;

$('#greet-add-btn').onclick = async () => {
  const input = $('#greet-new');
  const body = input.value.trim();
  if (!body) return;
  const [start, end] = $('#greet-preset').value.split('-').map(Number);
  try {
    await api('/admin/greetings', {
      method: 'POST',
      body: JSON.stringify({ greetings: [{ body, start_min: start, end_min: end, enabled: 1 }] })
    });
    input.value = '';
    renderGreetPreview();
    loadGreetings();
  } catch (err) {
    // Text is kept on failure so an over-length greeting can be shortened
    // rather than retyped.
    handleError(err, 'Adding the greeting');
  }
};
// Same 250ms settle as #user-search above, and its own timer so typing in
// one filter cannot cancel the other's pending load.
let tplFilterTimer = null;
$('#tpl-user-filter').oninput = () => {
  clearTimeout(tplFilterTimer);
  tplFilterTimer = setTimeout(() => loadTemplates().catch((err) => handleError(err, 'Filtering templates')), 250);
};

// Switching fields reloads both tables. No debounce: this is a deliberate
// click, not typing, and the two lists must never be shown together.
$('#tpl-field').onchange = () => {
  loadTemplates().catch((err) => handleError(err, 'Loading templates'));
};

$('#refresh-users-btn').onclick = async () => {
  const btn = $('#refresh-users-btn');
  btn.disabled = true;
  try {
    // Groups first and awaited, for the same reason start() does it: the
    // rows build their dropdowns from that list.
    await refreshGroups();
    await Promise.all([loadUsers(), loadStats()]);
  } catch (err) {
    handleError(err, 'Refreshing', () => $('#refresh-users-btn').click());
  } finally {
    btn.disabled = false;
  }
};

$('#board-group-filter').onchange = () => loadBoard();
$('#refresh-board-btn').onclick = async () => {
  const btn = $('#refresh-board-btn');
  btn.disabled = true;
  try { await refreshGroups(); await loadBoard(); }
  catch (err) { handleError(err, 'Refreshing the leaderboard'); }
  finally { btn.disabled = false; }
};

$('#delete-dialog').addEventListener('close', async () => {
  const dlg = $('#delete-dialog');
  const user = pendingDelete;
  pendingDelete = null;
  if (dlg.returnValue !== 'save' || !user) return;
  const board = $('#f-board-keep').checked ? 'keep' : 'hide';
  try {
    await api('/admin/users/' + encodeURIComponent(user.username) + '?mode=delete&board=' + board,
      { method: 'DELETE' });
    loadUsers();
    loadGroups().catch(() => {});   // member counts changed
    loadStats();
  } catch (err) {
    handleError(err, 'Deleting ' + user.username);
  }
});

$('#stats-dialog').addEventListener('close', async () => {
  const dlg = $('#stats-dialog');
  const row = pendingStats;
  pendingStats = null;
  if (!row || (dlg.returnValue !== 'save' && dlg.returnValue !== 'clear')) return;
  // 'clear' sends null, which the server reads as "drop the override".
  const total = dlg.returnValue === 'clear' ? null : Number($('#f-stats-total').value);
  if (total !== null && (!Number.isInteger(total) || total < 0)) {
    showBanner('Cases reviewed must be a whole number, zero or more.');
    return;
  }
  try {
    await api('/admin/users/' + encodeURIComponent(row.username) + '/stats',
      { method: 'POST', body: JSON.stringify({ total }) });
    loadBoard();
  } catch (err) {
    handleError(err, 'Saving the standing for ' + row.username);
  }
});

$('#ach-dialog').addEventListener('close', async () => {
  const dlg = $('#ach-dialog');
  const row = pendingAch;
  pendingAch = null;
  if (dlg.returnValue !== 'save' || !row) return;
  const unlocked = [...$('#ach-list').querySelectorAll('input:checked')].map((cb) => cb.value);
  try {
    await api('/admin/users/' + encodeURIComponent(row.username) + '/achievements',
      { method: 'POST', body: JSON.stringify({ unlocked }) });
    loadBoard();
  } catch (err) {
    handleError(err, 'Saving achievements for ' + row.username);
  }
});

$('#refresh-audit-btn').onclick = () => loadAudit().catch((err) => handleError(err, 'Refreshing the audit log'));
$('#export-audit-btn').onclick = () => exportAudit();

$('#clear-audit-btn').onclick = async () => {
  const r0 = await confirmDialog({
    title: 'Clear the audit log?',
    body: 'Export it first if you want a copy — this cannot be undone. The clearing itself is recorded.',
    confirmText: 'Clear log', danger: true
  });
  if (!r0.ok) return;
  const btn = $('#clear-audit-btn');
  btn.disabled = true;
  try {
    const r = await api('/admin/rejects', { method: 'DELETE' });
    loadAudit();
    await messageDialog({
      title: 'Audit log cleared',
      body: r.cleared
        ? `Removed ${r.cleared} ${r.cleared === 1 ? 'entry' : 'entries'}.`
        : 'The log was already empty.'
    });
  } catch (err) {
    handleError(err, 'Clearing the audit log');
  } finally {
    btn.disabled = false;
  }
};
$('#add-user-btn').onclick = () => openUserDialog(null);

$('#add-group-btn').onclick = async () => {
  const input = $('#group-name');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  try {
    await api('/admin/workgroups', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    loadGroups();
  } catch (err) {
    handleError(err, 'Adding ' + name);
  }
};
$('#group-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#add-group-btn').click(); }
});
$('#bulk-btn').onclick = () => {
  $('#f-bulk').value = '';
  fillGroupSelect($('#f-bulk-workgroup'), null);
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
        templates: $('#f-templates').checked,
        note: $('#f-note').value,
        workgroup_id: Number($('#f-workgroup').value)
      })
    });
    loadUsers();
    loadGroups().catch(() => {});
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
    const groupId = Number($('#f-bulk-workgroup').value);
    const groupName = ($('#f-bulk-workgroup').selectedOptions[0] || {}).textContent || '';
    const r = await api('/admin/users/bulk', {
      method: 'POST', body: JSON.stringify({ usernames, workgroup_id: groupId })
    });
    await messageDialog({
      title: 'Bulk add complete',
      body: `Submitted ${usernames.length} name${usernames.length === 1 ? '' : 's'} into ${groupName}.`,
      rows: [
        ['Added', r.added],
        ['Already existing', r.existing],
        ['Duplicates in list', r.duplicates],
        ['Invalid', r.invalid]
      ]
    });
    $('#f-bulk').value = '';
    page = 0;
    loadUsers();
    loadGroups().catch(() => {});
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
  // Groups first, and awaited: every row of the user table renders a
  // <select> from this list, so loading it in parallel would race and
  // paint the first page with empty dropdowns.
  await refreshGroups();
  // Overview is the landing tab now, so it has to be loaded on boot --
  // selectTab() only fires when a tab is clicked, and the panel would
  // otherwise open on an empty page. loadUsers still runs because the
  // Users tab is one click away and its data is the most-wanted.
  await Promise.all([
    loadUsers(),
    loadStats(),
    loadOverview().catch((err) => handleError(err, 'Loading the overview'))
  ]);
}

/* Previously any startup failure called signOut, so one flaky request on
   load discarded a perfectly good token and looked like a session expiry.
   api() already signs out on a real 401; anything else is retryable. */
if (getToken()) {
  start().catch((err) => handleError(err, 'Loading the panel', () => start().catch(() => {})));
}
