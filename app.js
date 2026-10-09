'use strict';

const STATUSES = ['Draft', 'Submitted', 'Under Review', 'Approved', 'Rejected', 'Withdrawn'];
const PENDING = STATUSES.slice(0, 3);
const TYPES = ['Owner Request', 'Design Change', 'Site Condition', 'Scope Gap', 'Regulatory', 'Other'];
const RTYPES = ['Risk', 'Assumption', 'Issue', 'Dependency'];
const LEVELS = ['High', 'Medium', 'Low'];
const RSTATUS = ['Open', 'Mitigating', 'Closed'];
const DEFAULTS = { project: 'My Project', currency: 'THB', preparedBy: '', contract: 0, allowancePct: 5, markup: 10, agingDays: 21, amber: 75, red: 100 };
const MAX_PHOTOS = 4;

const state = { s: { ...DEFAULTS }, co: [], raid: [], notes: { done: '', next: '', decisions: '' }, tab: 'status', filter: 'All' };

// ---------- helpers
const $ = (sel, el = document) => el.querySelector(sel);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const money = n => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const cls = s => String(s).replace(/\s+/g, '-');
const pill = (text, c = text) => `<span class="pill ${esc(cls(c))}">${esc(text)}</span>`;
const opts = (list, sel, blank) => (blank ? '<option value=""></option>' : '') + list.map(o => `<option${o === sel ? ' selected' : ''}>${esc(o)}</option>`).join('');
const sum = (arr, fn) => arr.reduce((t, x) => t + fn(x), 0);

function banner(msg) { const b = $('#banner'); b.textContent = msg || ''; b.hidden = !msg; }

// ---------- storage (IndexedDB)
let db;
const dbOpen = () => new Promise((res, rej) => {
  const r = indexedDB.open('change-order-tracker', 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('kv'); d.createObjectStore('co', { keyPath: 'id' }); d.createObjectStore('raid', { keyPath: 'id' }); };
  r.onsuccess = () => { db = r.result; res(); };
  r.onerror = () => rej(r.error);
});
const dbRun = (store, mode, fn) => new Promise((res, rej) => {
  const t = db.transaction(store, mode); const req = fn(t.objectStore(store));
  t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
});
const dbAll = store => dbRun(store, 'readonly', s => s.getAll());
const dbPut = (store, obj, key) => dbRun(store, 'readwrite', s => s.put(obj, key));
const dbDel = (store, id) => dbRun(store, 'readwrite', s => s.delete(id));
const dbClear = store => dbRun(store, 'readwrite', s => s.clear());
const dbGet = (store, key) => dbRun(store, 'readonly', s => s.get(key));

async function saveSafe(fn) {
  try { await fn(); banner(''); } catch (e) { banner('Could not save on this device (storage full or blocked). Export a backup now.'); throw e; }
}
const saveSettings = () => saveSafe(() => dbPut('kv', state.s, 'settings'));
const saveNotes = () => saveSafe(() => dbPut('kv', state.notes, 'notes'));

// ---------- calculations (mirror the Excel toolkit)
const markupOf = c => (c.markup ?? state.s.markup) / 100;
const totalOf = c => (c.cost ?? 0) * (1 + markupOf(c));
const daysOpen = c => (c.dateRaised ? dayDiff(c.dateRaised, c.dateDecided || today()) : 0);
const isPending = c => PENDING.includes(c.status);
const isOverdue = c => isPending(c) && daysOpen(c) > state.s.agingDays;
const LV = { High: 3, Medium: 2, Low: 1 };
const score = r => (LV[r.prob] || 1) * (LV[r.impact] || 1);
const rOpen = r => r.status !== 'Closed';
const rOverdue = r => rOpen(r) && r.due && r.due < today();
const ragOf = pct => (pct == null ? 'NA' : pct <= state.s.amber ? 'GREEN' : pct <= state.s.red ? 'AMBER' : 'RED');
const ragCount = n => (n === 0 ? 'GREEN' : n <= 2 ? 'AMBER' : 'RED');

function metrics() {
  const s = state.s, co = state.co;
  const approved = sum(co.filter(c => c.status === 'Approved'), totalOf);
  const pending = sum(co.filter(isPending), totalOf);
  const allowance = (s.contract * s.allowancePct) / 100;
  return {
    approved, pending, allowance,
    revised: s.contract + approved,
    ifAll: s.contract + approved + pending,
    approvedPct: s.contract ? (approved / s.contract) * 100 : null,
    exposure: allowance ? ((approved + pending) / allowance) * 100 : null,
    daysApproved: sum(co.filter(c => c.status === 'Approved'), c => c.days || 0),
    daysPending: sum(co.filter(isPending), c => c.days || 0),
    overdueCo: co.filter(isOverdue).length,
    highRaid: state.raid.filter(r => rOpen(r) && score(r) >= 6).length,
    overdueRaid: state.raid.filter(rOverdue).length,
  };
}

// ---------- views
function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === state.tab ? 'page' : 'false'));
  $('#title').textContent = state.s.project || 'Change Order Tracker';
  const v = { status: viewStatus, changes: viewChanges, raid: viewRaid, settings: viewSettings }[state.tab]();
  $('#view').innerHTML = v;
}

function viewStatus() {
  const s = state.s, m = metrics(), cur = esc(s.currency);
  const h = (label, val, rag) => `<div class="row"><span class="k">${label}</span><span class="v">${val} ${pill(rag)}</span></div>`;
  const r = (k, v, strong) => `<div class="row"><span class="k">${k}</span><span class="v">${strong ? '<strong>' : ''}${v}${strong ? '</strong>' : ''}</span></div>`;
  const byStatus = STATUSES.map(st => {
    const list = state.co.filter(c => c.status === st);
    return `<tr><td>${esc(st)}</td><td>${list.length}</td><td>${money(sum(list, totalOf))}</td><td>${sum(list, c => c.days || 0)}</td></tr>`;
  }).join('');
  const oldest = state.co.filter(isPending).sort((a, b) => daysOpen(b) - daysOpen(a)).slice(0, 5);
  const raidRows = RTYPES.map(t => {
    const l = state.raid.filter(x => x.type === t);
    return `<tr><td>${t}</td><td>${l.filter(rOpen).length}</td><td>${l.filter(x => !rOpen(x)).length}</td></tr>`;
  }).join('');
  const note = (k, label) => `<label for="n-${k}">${label}</label><textarea id="n-${k}" data-note="${k}">${esc(state.notes[k])}</textarea>`;
  return `
    <div class="print-head"><h1>${esc(s.project)} - Status Report</h1></div>
    <div class="card"><div class="row"><span class="k">Report date</span><span class="v">${today()}</span></div>
      ${s.preparedBy ? `<div class="row"><span class="k">Prepared by</span><span class="v">${esc(s.preparedBy)}</span></div>` : ''}</div>
    <h2>Health</h2><div class="card">
      ${h('Change exposure vs allowance', m.exposure == null ? 'n/a' : Math.round(m.exposure) + '%', ragOf(m.exposure))}
      ${h('Overdue open change orders', m.overdueCo, ragCount(m.overdueCo))}
      ${h('High-rated open RAID items', m.highRaid, ragCount(m.highRaid))}
      ${h('Overdue RAID actions', m.overdueRaid, ragCount(m.overdueRaid))}
    </div>
    <h2>Cost (${cur})</h2><div class="card">
      ${r('Original contract value', money(s.contract))}${r('Approved changes', money(m.approved))}
      ${r('Revised contract value', money(m.revised), true)}${r('Pending (draft / submitted / review)', money(m.pending))}
      ${r('Revised value if all pending approved', money(m.ifAll), true)}
      ${r('Approved as % of original', m.approvedPct == null ? 'n/a' : m.approvedPct.toFixed(1) + '%')}
      ${r('Change allowance', money(m.allowance))}
    </div>
    <h2>Schedule</h2><div class="card">${r('Days added (approved)', m.daysApproved)}${r('Days at risk (pending)', m.daysPending)}</div>
    <h2>Change orders by status</h2><div class="card"><table><tr><th>Status</th><th>#</th><th>${cur}</th><th>Days</th></tr>${byStatus}</table></div>
    <h2>Oldest open change orders</h2><div class="card">${oldest.length ? oldest.map(c => `<div class="row"><span><strong>${esc(c.no)}</strong> ${esc(c.desc)}</span><span class="v">${daysOpen(c)} d</span></div>`).join('') : '<div class="muted">None open.</div>'}</div>
    <h2>RAID summary</h2><div class="card"><table><tr><th>Type</th><th>Open</th><th>Closed</th></tr>${raidRows}</table></div>
    <h2>Commentary</h2>${note('done', 'Done this period')}${note('next', 'Planned next 14 days')}${note('decisions', 'Decisions / escalations needed')}
    <div class="btns no-print"><button class="btn primary" data-act="print">Print / save as PDF</button></div>`;
}

function viewChanges() {
  const f = state.filter;
  const filters = ['All', 'Open', 'Approved', 'Overdue'];
  const list = state.co.filter(c => f === 'All' || (f === 'Open' && isPending(c)) || (f === 'Approved' && c.status === 'Approved') || (f === 'Overdue' && isOverdue(c)))
    .sort((a, b) => (b.dateRaised || '').localeCompare(a.dateRaised || ''));
  const cards = list.map(c => `
    <button class="card item" data-act="editCo" data-id="${esc(c.id)}">
      <div class="top"><span class="no">${esc(c.no)}</span>${pill(c.status)}</div>
      <div class="desc">${esc(c.desc)}</div>
      <div class="meta"><span>${esc(state.s.currency)} ${money(totalOf(c))}</span><span>${daysOpen(c)} d open</span>${c.days ? `<span>+${c.days} d schedule</span>` : ''}
        ${isOverdue(c) ? pill('OVERDUE') : ''}${c.photos?.length ? `<span>${c.photos.length} photo${c.photos.length > 1 ? 's' : ''}</span>` : ''}</div>
    </button>`).join('');
  return `<div class="chips">${filters.map(x => `<button class="chip" aria-pressed="${x === f}" data-act="filter" data-f="${x}">${x}</button>`).join('')}</div>
    ${cards || '<div class="empty">No change orders here yet.<br>Tap + to log one.</div>'}
    <button class="fab" data-act="addCo" aria-label="Add change order">+ Change</button>`;
}

function viewRaid() {
  const list = [...state.raid].sort((a, b) => score(b) - score(a));
  const cards = list.map(r => `
    <button class="card item" data-act="editRaid" data-id="${esc(r.id)}">
      <div class="top"><span class="no">${esc(r.no)} - ${esc(r.type)}</span>${pill(r.status)}</div>
      <div class="desc">${esc(r.desc)}</div>
      <div class="meta"><span>Score ${score(r)}</span><span>${esc(r.owner || 'No owner')}</span>${r.due ? `<span>Due ${esc(r.due)}</span>` : ''}${rOverdue(r) ? pill('OVERDUE') : ''}</div>
    </button>`).join('');
  return `${cards || '<div class="empty">No RAID items yet.<br>Tap + to add a risk, assumption, issue or dependency.</div>'}
    <button class="fab" data-act="addRaid" aria-label="Add RAID item">+ RAID</button>`;
}

function viewSettings() {
  const s = state.s;
  const f = (k, label, type = 'text', extra = '') => `<label for="s-${k}">${label}</label><input id="s-${k}" data-set="${k}" type="${type}" value="${esc(s[k])}" ${extra}>`;
  return `<h2>Project</h2><div class="card">
      ${f('project', 'Project name')}${f('preparedBy', 'Prepared by')}${f('currency', 'Currency label')}
      ${f('contract', 'Original contract value', 'number', 'inputmode="decimal" min="0" step="any"')}
      <div class="grid2">${f('allowancePct', 'Change allowance (% of contract)', 'number', 'min="0" step="any"')}${f('markup', 'Default markup (%)', 'number', 'min="0" step="any"')}</div>
      <div class="grid2">${f('amber', 'Amber above (% of allowance)', 'number', 'min="0"')}${f('red', 'Red above (% of allowance)', 'number', 'min="0"')}</div>
      ${f('agingDays', 'Flag open change orders older than (days)', 'number', 'min="0" step="1"')}
    </div>
    <h2>Your data</h2><div class="card">
      <p class="muted">Everything is stored on this device only. Export a backup regularly - clearing browser data erases it.</p>
      <div class="btns">
        <button class="btn" data-act="exportCo">Export change orders (CSV)</button>
        <button class="btn" data-act="exportRaid">Export RAID (CSV)</button>
        <button class="btn" data-act="pickImport">Import change orders (CSV)</button>
        <button class="btn primary" data-act="backup">Backup everything (JSON)</button>
        <button class="btn" data-act="pickRestore">Restore backup</button>
      </div>
      <input type="file" id="f-import" data-file="import" accept=".csv,text/csv" hidden>
      <input type="file" id="f-restore" data-file="restore" accept=".json,application/json" hidden>
    </div>
    <div class="card"><div class="btns">
      <button class="btn" data-act="sample">Load sample data</button>
      <button class="btn danger" data-act="wipe">Delete all data</button>
      <button class="btn" data-act="install" id="installBtn" hidden>Install app</button>
    </div><p class="muted">CSV columns match the Excel toolkit, so you can move data between the two. Not accounting or contractual advice - check amounts against your contract.</p></div>`;
}

// ---------- forms
let draftPhotos = [];
const dlg = () => $('#dlg');
const closeDlg = () => dlg().close();

function coForm(c) {
  const isNew = !c; c = c || { id: uid(), no: nextNo('CO', state.co), dateRaised: today(), status: 'Draft', type: TYPES[0], photos: [] };
  draftPhotos = [...(c.photos || [])];
  dlg().innerHTML = `<form method="dialog" data-form="co" data-id="${esc(c.id)}" data-new="${isNew}">
    <h3>${isNew ? 'New change order' : 'Edit ' + esc(c.no)}</h3>
    <div class="grid2"><div><label for="c-no">CO #</label><input id="c-no" name="no" required value="${esc(c.no)}"></div>
      <div><label for="c-date">Date raised</label><input id="c-date" name="dateRaised" type="date" required value="${esc(c.dateRaised)}"></div></div>
    <label for="c-desc">Description</label><textarea id="c-desc" name="desc" required>${esc(c.desc)}</textarea>
    <div class="grid2"><div><label for="c-by">Raised by</label><input id="c-by" name="by" value="${esc(c.by)}"></div>
      <div><label for="c-type">Type</label><select id="c-type" name="type">${opts(TYPES, c.type)}</select></div></div>
    <div class="grid2"><div><label for="c-status">Status</label><select id="c-status" name="status">${opts(STATUSES, c.status)}</select></div>
      <div><label for="c-dd">Date decided</label><input id="c-dd" name="dateDecided" type="date" value="${esc(c.dateDecided)}"></div></div>
    <div class="grid2"><div><label for="c-cost">Direct cost (${esc(state.s.currency)})</label><input id="c-cost" name="cost" type="number" inputmode="decimal" min="0" step="any" value="${esc(c.cost)}"></div>
      <div><label for="c-mk">Markup % (blank = ${esc(state.s.markup)})</label><input id="c-mk" name="markup" type="number" inputmode="decimal" min="0" step="any" value="${esc(c.markup)}"></div></div>
    <label for="c-days">Schedule impact (days)</label><input id="c-days" name="days" type="number" inputmode="numeric" step="1" value="${esc(c.days)}">
    <label for="c-notes">Notes</label><textarea id="c-notes" name="notes">${esc(c.notes)}</textarea>
    <label for="c-photo">Photos (max ${MAX_PHOTOS})</label>
    <input id="c-photo" type="file" accept="image/*" capture="environment" data-photo>
    <div class="thumbs" id="thumbs"></div>
    <div class="btns"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="closeDlg">Cancel</button>
      ${isNew ? '' : '<button class="btn danger" type="button" data-act="delCo">Delete</button>'}</div></form>`;
  paintThumbs(); dlg().showModal();
}

function paintThumbs() {
  const t = $('#thumbs'); if (!t) return;
  t.innerHTML = draftPhotos.map((b, i) => `<figure><img alt="Photo ${i + 1}" src="${URL.createObjectURL(b)}"><button type="button" data-act="rmPhoto" data-i="${i}" aria-label="Remove photo ${i + 1}">x</button></figure>`).join('');
}

function raidForm(r) {
  const isNew = !r; r = r || { id: uid(), no: nextNo('R', state.raid), type: 'Risk', prob: 'Medium', impact: 'Medium', status: 'Open', raised: today() };
  dlg().innerHTML = `<form method="dialog" data-form="raid" data-id="${esc(r.id)}" data-new="${isNew}">
    <h3>${isNew ? 'New RAID item' : 'Edit ' + esc(r.no)}</h3>
    <div class="grid2"><div><label for="r-no">ID</label><input id="r-no" name="no" required value="${esc(r.no)}"></div>
      <div><label for="r-type">Type</label><select id="r-type" name="type">${opts(RTYPES, r.type)}</select></div></div>
    <label for="r-desc">Description</label><textarea id="r-desc" name="desc" required>${esc(r.desc)}</textarea>
    <div class="grid2"><div><label for="r-owner">Owner</label><input id="r-owner" name="owner" value="${esc(r.owner)}"></div>
      <div><label for="r-status">Status</label><select id="r-status" name="status">${opts(RSTATUS, r.status)}</select></div></div>
    <div class="grid2"><div><label for="r-prob">Probability</label><select id="r-prob" name="prob">${opts(LEVELS, r.prob)}</select></div>
      <div><label for="r-imp">Impact</label><select id="r-imp" name="impact">${opts(LEVELS, r.impact)}</select></div></div>
    <div class="grid2"><div><label for="r-raised">Date raised</label><input id="r-raised" name="raised" type="date" value="${esc(r.raised)}"></div>
      <div><label for="r-due">Due date</label><input id="r-due" name="due" type="date" value="${esc(r.due)}"></div></div>
    <label for="r-action">Response / next action</label><textarea id="r-action" name="action">${esc(r.action)}</textarea>
    <div class="btns"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="closeDlg">Cancel</button>
      ${isNew ? '' : '<button class="btn danger" type="button" data-act="delRaid">Delete</button>'}</div></form>`;
  dlg().showModal();
}

function nextNo(prefix, list) {
  const n = Math.max(0, ...list.map(x => parseInt(String(x.no).replace(/\D+/g, ''), 10) || 0)) + 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

async function shrink(file, max = 1280) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.75));
}

async function submitForm(form) {
  const d = Object.fromEntries(new FormData(form)); const id = form.dataset.id;
  if (form.dataset.form === 'co') {
    const prev = state.co.find(c => c.id === id) || {};
    const rec = { ...prev, id, no: d.no.trim(), dateRaised: d.dateRaised, desc: d.desc.trim(), by: d.by.trim(), type: d.type, status: d.status,
      dateDecided: d.dateDecided || '', cost: num(d.cost), markup: num(d.markup), days: num(d.days), notes: d.notes.trim(), photos: draftPhotos };
    if (rec.dateDecided && rec.dateRaised && rec.dateDecided < rec.dateRaised) { banner('Date decided is before date raised.'); return; }
    await saveSafe(() => dbPut('co', rec));
    state.co = upsert(state.co, rec);
  } else {
    const prev = state.raid.find(r => r.id === id) || {};
    const rec = { ...prev, id, no: d.no.trim(), type: d.type, desc: d.desc.trim(), owner: d.owner.trim(), status: d.status, prob: d.prob, impact: d.impact, raised: d.raised, due: d.due, action: d.action.trim() };
    await saveSafe(() => dbPut('raid', rec));
    state.raid = upsert(state.raid, rec);
  }
  banner(''); closeDlg(); render();
}
const upsert = (list, rec) => (list.some(x => x.id === rec.id) ? list.map(x => (x.id === rec.id ? rec : x)) : [...list, rec]);

// ---------- CSV / backup
const CO_HEAD = ['CO #', 'Date raised', 'Description', 'Raised by', 'Type', 'Status', 'Direct cost', 'Markup %', 'Total cost impact', 'Schedule impact (days)', 'Date decided', 'Days open', 'Notes'];
const RAID_HEAD = ['ID', 'Type', 'Description', 'Owner', 'Probability', 'Impact', 'Score', 'Status', 'Date raised', 'Due date', 'Response / next action'];
const safeCell = v => { const t = String(v ?? ''); return /^[=+\-@\t\r]/.test(t) && isNaN(Number(t)) ? "'" + t : t; };
const csvCell = v => { const t = safeCell(v); return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
const toCsv = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.append(a); a.click(); a.remove();
}
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false; text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}
function normDate(v) {
  v = String(v || '').trim(); if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = Date.parse(v); return Number.isNaN(t) ? '' : new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const pick = (v, list, fallback) => list.find(x => x.toLowerCase() === String(v || '').trim().toLowerCase()) || fallback;

async function importCo(file) {
  const rows = parseCsv(await file.text()); if (rows.length < 2) { banner('That CSV has no data rows.'); return; }
  const head = rows[0].map(h => h.trim().toLowerCase()); const col = n => head.indexOf(n.toLowerCase());
  const idx = Object.fromEntries(['CO #', 'Date raised', 'Description', 'Raised by', 'Type', 'Status', 'Direct cost', 'Markup %', 'Schedule impact (days)', 'Date decided', 'Notes'].map(n => [n, col(n)]));
  if (idx['CO #'] < 0 || idx['Description'] < 0) { banner('CSV needs "CO #" and "Description" columns (export one first to see the format).'); return; }
  let added = 0;
  for (const r of rows.slice(1)) {
    const g = n => (idx[n] >= 0 ? (r[idx[n]] ?? '').trim() : '');
    if (!g('CO #') && !g('Description')) continue;
    let mk = g('Markup %'); const pct = mk.includes('%'); mk = num(mk.replace('%', ''));
    if (mk != null && !pct && mk <= 1) mk = mk * 100;
    const rec = { id: uid(), no: g('CO #') || nextNo('CO', state.co), dateRaised: normDate(g('Date raised')) || today(), desc: g('Description'), by: g('Raised by'),
      type: pick(g('Type'), TYPES, 'Other'), status: pick(g('Status'), STATUSES, 'Draft'), cost: num(g('Direct cost').replace(/,/g, '')), markup: mk,
      days: num(g('Schedule impact (days)')), dateDecided: normDate(g('Date decided')), notes: g('Notes'), photos: [] };
    await saveSafe(() => dbPut('co', rec)); state.co.push(rec); added++;
  }
  banner(''); render(); alert(`Imported ${added} change order${added === 1 ? '' : 's'}.`);
}

const blobToUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
async function backup() {
  const co = await Promise.all(state.co.map(async c => ({ ...c, photos: await Promise.all((c.photos || []).map(blobToUrl)) })));
  download(`change-order-backup-${today()}.json`, JSON.stringify({ app: 'change-order-tracker', v: 1, settings: state.s, notes: state.notes, co, raid: state.raid }), 'application/json');
}
async function restore(file) {
  let data; try { data = JSON.parse(await file.text()); } catch { banner('That file is not a valid backup.'); return; }
  if (data.app !== 'change-order-tracker' || !Array.isArray(data.co) || !Array.isArray(data.raid)) { banner('That file is not a backup from this app.'); return; }
  if (!confirm('Replace everything on this device with the backup?')) return;
  const co = await Promise.all(data.co.map(async c => ({ ...c, photos: await Promise.all((c.photos || []).map(u => fetch(u).then(r => r.blob()))) })));
  await dbClear('co'); await dbClear('raid');
  for (const c of co) await dbPut('co', c); for (const r of data.raid) await dbPut('raid', r);
  state.s = { ...DEFAULTS, ...data.settings }; state.notes = { ...state.notes, ...data.notes }; state.co = co; state.raid = data.raid;
  await saveSettings(); await saveNotes(); banner(''); render();
}

async function loadSample() {
  if ((state.co.length || state.raid.length) && !confirm('Add sample data to your existing data?')) return;
  const d = n => { const t = new Date(); t.setDate(t.getDate() - n); return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  state.s = { ...state.s, project: 'Example Tower - Block A', contract: 50000000, preparedBy: state.s.preparedBy || 'Your Name' };
  const co = [
    { no: 'CO-001', dateRaised: d(40), desc: 'Additional waterproofing to basement slab per revised geotech report', by: 'Site Engineer', type: 'Site Condition', status: 'Approved', cost: 420000, markup: null, days: 6, dateDecided: d(25) },
    { no: 'CO-002', dateRaised: d(30), desc: 'Change tile spec in lobby (owner request)', by: 'Owner Rep', type: 'Owner Request', status: 'Under Review', cost: 310000, markup: 12, days: 3, dateDecided: '' },
    { no: 'CO-003', dateRaised: d(9), desc: 'Relocate MEP riser due to clash with beam', by: 'MEP Coordinator', type: 'Design Change', status: 'Submitted', cost: 185000, markup: null, days: 4, dateDecided: '' },
  ].map(c => ({ id: uid(), notes: '', photos: [], ...c }));
  const raid = [
    { no: 'R-001', type: 'Risk', desc: 'Late delivery of curtain wall panels could delay facade close-in', owner: 'Procurement Lead', prob: 'Medium', impact: 'High', status: 'Mitigating', raised: d(20), due: d(-7), action: 'Expedite order, confirm ship date weekly' },
    { no: 'I-001', type: 'Issue', desc: 'Owner has not signed off tile spec; blocks CO-002', owner: 'Project Manager', prob: 'High', impact: 'Medium', status: 'Open', raised: d(12), due: d(2), action: 'Escalate at Friday meeting' },
  ].map(r => ({ id: uid(), ...r }));
  for (const c of co) await dbPut('co', c); for (const r of raid) await dbPut('raid', r);
  state.co.push(...co); state.raid.push(...raid); await saveSettings(); render();
}

// ---------- events
let installEvt;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; const b = $('#installBtn'); if (b) b.hidden = false; });

const actions = {
  tab: t => { state.tab = t.dataset.tab; render(); window.scrollTo(0, 0); },
  filter: t => { state.filter = t.dataset.f; render(); },
  addCo: () => coForm(), editCo: t => coForm(state.co.find(c => c.id === t.dataset.id)),
  addRaid: () => raidForm(), editRaid: t => raidForm(state.raid.find(r => r.id === t.dataset.id)),
  closeDlg,
  rmPhoto: t => { draftPhotos.splice(+t.dataset.i, 1); paintThumbs(); },
  delCo: async t => { const id = t.closest('form').dataset.id; if (!confirm('Delete this change order?')) return; await dbDel('co', id); state.co = state.co.filter(c => c.id !== id); closeDlg(); render(); },
  delRaid: async t => { const id = t.closest('form').dataset.id; if (!confirm('Delete this RAID item?')) return; await dbDel('raid', id); state.raid = state.raid.filter(r => r.id !== id); closeDlg(); render(); },
  print: () => window.print(),
  exportCo: () => download(`change-orders-${today()}.csv`, toCsv([CO_HEAD, ...state.co.map(c => [c.no, c.dateRaised, c.desc, c.by, c.type, c.status, c.cost ?? '', c.markup ?? '', Math.round(totalOf(c)), c.days ?? '', c.dateDecided, daysOpen(c), c.notes])]), 'text/csv'),
  exportRaid: () => download(`raid-${today()}.csv`, toCsv([RAID_HEAD, ...state.raid.map(r => [r.no, r.type, r.desc, r.owner, r.prob, r.impact, score(r), r.status, r.raised, r.due, r.action])]), 'text/csv'),
  pickImport: () => $('#f-import').click(), pickRestore: () => $('#f-restore').click(),
  backup, sample: loadSample,
  wipe: async () => { if (!confirm('Delete ALL change orders, RAID items and settings on this device? Export a backup first.')) return; if (!confirm('This cannot be undone. Delete everything?')) return;
    await dbClear('co'); await dbClear('raid'); state.co = []; state.raid = []; state.s = { ...DEFAULTS }; state.notes = { done: '', next: '', decisions: '' }; await saveSettings(); await saveNotes(); render(); },
  install: async () => { if (installEvt) { installEvt.prompt(); installEvt = null; } },
};

document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (t) actions[t.dataset.act]?.(t, e); });
document.addEventListener('submit', e => { const f = e.target.closest('form[data-form]'); if (f) { e.preventDefault(); submitForm(f); } });
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.set) {
    const k = t.dataset.set; state.s[k] = typeof DEFAULTS[k] === 'number' ? (num(t.value) ?? 0) : t.value;
    if (k === 'project') $('#title').textContent = state.s.project || 'Change Order Tracker';
    saveSettings();
  } else if (t.dataset.note) { state.notes[t.dataset.note] = t.value; saveNotes(); }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.photo !== undefined && t.files[0]) {
    if (draftPhotos.length >= MAX_PHOTOS) { alert(`Up to ${MAX_PHOTOS} photos per change order.`); t.value = ''; return; }
    try { draftPhotos.push(await shrink(t.files[0])); paintThumbs(); } catch { alert('Could not read that image.'); }
    t.value = '';
  } else if (t.dataset.file === 'import' && t.files[0]) { await importCo(t.files[0]); t.value = ''; }
  else if (t.dataset.file === 'restore' && t.files[0]) { await restore(t.files[0]); t.value = ''; }
});
dlg().addEventListener('click', e => { if (e.target === dlg()) closeDlg(); });

// ---------- boot
(async function init() {
  try {
    await dbOpen();
    state.s = { ...DEFAULTS, ...(await dbGet('kv', 'settings')) };
    state.notes = { ...state.notes, ...(await dbGet('kv', 'notes')) };
    state.co = await dbAll('co'); state.raid = await dbAll('raid');
  } catch { banner('Storage is unavailable (private browsing?). Data will not be saved.'); }
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
