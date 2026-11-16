// SkyBridge Facility Lead Finder, single-file edition.
// Uses the same tested engine as the server version (src/core). Data is kept in this
// browser's storage; use Backup / Restore to move or share it.
import {
  CARE_LINE_LABEL, classifyJob, compareFacilities, extractFromHtml, normalizeState, orgNameGenericity, parseVivianJobUrl,
  type CareLine, type ExtractionResult, type MatchStrength,
} from '../src/core/index.ts';

// ---- data ------------------------------------------------------------------------------
interface Job {
  url: string; title: string; specialty: string | null; decision: string; careLine: CareLine | null; license: string | null; role: string | null;
  vms: string | null; advertiser: string | null; identityStatus: string; sourceField: string | null; originalValue: string | null;
  firstSeen: string; lastSeen: string; corrections: string[];
}
interface Facility {
  id: string; name: string; street: string; city: string; state: string; zip: string; parent: string; website: string; phone: string;
  status: string; owner: string; nextFollowUp: string; notes: string; existingClient: boolean; createdAt: string; jobs: Job[];
}
const KEY = 'skybridge-lead-finder-v1';
const STATUSES = ['New Lead', 'Research Needed', 'Qualified', 'Ready for Outreach', 'Contacted', 'Follow-Up Needed', 'Meeting Scheduled', 'Active Opportunity', 'Existing Client', 'Not a Fit'];
let db: Facility[] = load();

function load(): Facility[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch { alert('Could not save in this browser (storage blocked or full). Use Backup to keep a copy.'); }
  renderList();
}
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const today = () => new Date().toISOString().slice(0, 10);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const careOf = (f: Facility) => [...new Set(f.jobs.filter((j) => j.decision !== 'exclude' && j.careLine).map((j) => j.careLine!))];
const typeOf = (f: Facility) => { const c = careOf(f); return c.length > 1 ? `Hybrid: ${c.map((x) => CARE_LINE_LABEL[x]).join(' + ')}` : c[0] ? CARE_LINE_LABEL[c[0]] : ''; };
const lastSeen = (f: Facility) => f.jobs.map((j) => j.lastSeen).sort().pop() ?? '';

const BADGE: Record<string, [string, string]> = {
  confirmed: ['Confirmed facility', 'g'], possible: ['Possible facility', 'a'], agency_only: ['Staffing agency only', 'v'], generic: ['Generic description only', 'a'],
  not_found: ['Facility not identified', 'r'], error: ['Not a job page', 'r'], manual: ['Entered manually', 'b'],
  accept: ['In scope', 'g'], review: ['Needs review', 'a'], exclude: ['Out of scope', 'r'],
};
const badge = (k: string, text?: string) => { const [l, c] = BADGE[k] ?? [k, '']; return `<span class="badge ${c}">${esc(text ?? l)}</span>`; };

// ---- find facility ----------------------------------------------------------------------
let current: { result: ExtractionResult; url: string } | null = null;

function runExtraction(text: string) {
  const marker = text.match(/^<!--skybridge-url:(\S+?)-->/);
  if (marker) $<HTMLInputElement>('url').value = marker[1];
  const rawUrl = $<HTMLInputElement>('url').value.trim();
  const v = rawUrl ? parseVivianJobUrl(rawUrl) : null;
  if (v?.ok) $<HTMLInputElement>('url').value = v.url;
  current = { result: extractFromHtml(text, { url: v?.ok ? v.url : undefined }), url: v?.ok ? v.url : rawUrl };
  renderResult();
}

function renderResult() {
  if (!current) { $('result').innerHTML = ''; return; }
  const r = current.result;
  const c = r.classification;
  const already = db.find((f) => f.jobs.some((j) => j.url === current!.url));
  const opt = (vals: [string, string][], sel: string | null) => vals.map(([v, l]) => `<option value="${esc(v)}" ${v === (sel ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
  $('result').innerHTML = `
    <div class="card">
      <div class="row">${badge(r.status)}${badge(c.decision)}${c.specialty ? badge('x', c.specialty) : ''}
        ${r.facility.sourceField ? `<span class="muted">from <code>${esc(r.facility.sourceField)}</code></span>` : ''}</div>
      ${r.errors.map((e) => `<div class="note r">${esc(e)}</div>`).join('')}
      ${r.warnings.map((w) => `<div class="note a">${esc(w)}</div>`).join('')}
      ${already ? `<div class="note b">This job URL is already saved under <b>${esc(already.name)}</b>. Saving again just updates "last seen".</div>` : ''}
      ${r.advertiser ? `<div class="note b">Advertised by <b>${esc(r.advertiser.name)}</b>${r.advertiser.looksLikeStaffingAgency ? ' (a staffing agency, kept separate from the facility)' : '. This differs from the facility name; check which is the end client.'}</div>` : ''}
      ${r.vms.fields.length || r.vms.mentions.length ? `<div class="note b"><b>VMS${r.vms.name ? `: ${esc(r.vms.name)}` : ' mentioned on this page'}</b><ul>${r.vms.fields.map((f) => `<li><code>${esc(f.field)}</code> = ${esc(f.value)}</li>`).join('')}${r.vms.mentions.map((m) => `<li>“…${esc(m)}…”</li>`).join('')}</ul></div>` : ''}
      <div class="grid">
        <label class="span2">Facility name *<input id="f-name" value="${esc(r.facility.name)}" placeholder="${r.facility.name ? '' : 'Not identified on the page. Enter only a verified name.'}"></label>
        <label class="span2">Street<input id="f-street" value="${esc(r.facility.address.street)}"></label>
        <label>City<input id="f-city" value="${esc(r.facility.address.city ?? r.job.city)}"></label>
        <label>State<input id="f-state" value="${esc(r.facility.address.state ?? r.job.state)}"></label>
        <label>ZIP<input id="f-zip" value="${esc(r.facility.address.zip)}"></label>
        <label>Parent organization<input id="f-parent" value="${esc(r.facility.systemName)}"></label>
        <label class="span2">Job title *<input id="f-title" value="${esc(r.job.title)}"></label>
        <label>Decision<select id="f-decision">${opt([['accept', 'In scope'], ['review', 'Needs review'], ['exclude', 'Out of scope']], c.decision)}</select></label>
        <label>Care line<select id="f-care"><option value="">—</option>${opt(Object.entries(CARE_LINE_LABEL), c.careLine)}</select></label>
        <label>License<select id="f-license"><option value="">Not stated</option>${opt([['RN', 'RN'], ['LPN', 'LPN'], ['LVN', 'LVN'], ['LPN/LVN', 'LPN/LVN']], c.license)}</select></label>
        <label>Role<select id="f-role">${opt([['', 'Staff nurse'], ['Case Manager', 'Case Manager'], ['Admissions', 'Admissions'], ['On-Call', 'On-Call'], ['Triage', 'Triage'], ['After-Hours', 'After-Hours'], ['Weekend', 'Weekend'], ['Visit', 'Visit']], c.role)}</select></label>
      </div>
      <ul class="muted small">${c.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <div id="matches"></div>
      <div class="row"><button class="primary" id="save">Save lead</button><span id="save-msg"></span></div>
      <details><summary>Evidence (${r.evidence.length} fields found)</summary>
        <table class="small"><tr><th>Field</th><th>Value</th><th>Judged as</th><th>Where</th></tr>
        ${r.evidence.map((e) => `<tr><td><code>${esc(e.field)}</code></td><td>${esc(e.value)}</td><td>${esc(e.assessment ?? '')}</td><td class="muted"><code>${esc(e.path)}</code></td></tr>`).join('')}</table>
      </details>
    </div>`;
  const refreshMatches = () => {
    const name = $<HTMLInputElement>('f-name').value.trim();
    if (!name) { $('matches').innerHTML = ''; return; }
    const me = { name, street: $<HTMLInputElement>('f-street').value, city: $<HTMLInputElement>('f-city').value, state: $<HTMLInputElement>('f-state').value, parentName: $<HTMLInputElement>('f-parent').value };
    const order: MatchStrength[] = ['exact', 'likely', 'possible', 'related'];
    const ms = db.map((f) => ({ f, m: compareFacilities(me, { name: f.name, street: f.street, city: f.city, state: f.state, website: f.website, parentName: f.parent }) }))
      .filter((x) => x.m).sort((a, b) => order.indexOf(a.m!.strength) - order.indexOf(b.m!.strength));
    const pre = ms.find((x) => x.m!.strength === 'exact') ?? (ms.filter((x) => x.m!.strength === 'likely').length === 1 ? ms[0] : null);
    $('matches').innerHTML = ms.length ? `<p class="small"><b>Similar saved facilities.</b> Pick one to add this job to it, or create a new facility. Nothing is merged automatically.</p>
      ${ms.map((x) => `<label class="match"><input type="radio" name="dest" value="${x.f.id}" ${pre?.f.id === x.f.id ? 'checked' : ''}> <b>${esc(x.f.name)}</b> ${badge('x', x.m!.strength)} <span class="muted small">${esc([x.f.street, x.f.city, x.f.state].filter(Boolean).join(', '))} · ${x.f.jobs.length} job(s). ${esc(x.m!.reasons.join(' '))}</span></label>`).join('')}
      <label class="match"><input type="radio" name="dest" value="new" ${pre ? '' : 'checked'}> <b>Create a new facility</b></label>` : '';
  };
  refreshMatches();
  for (const id of ['f-name', 'f-street', 'f-city', 'f-state']) $(id).addEventListener('change', refreshMatches);
  $('save').onclick = saveLead;
}

function saveLead() {
  if (!current) return;
  const val = (id: string) => ($<HTMLInputElement>(id).value ?? '').trim();
  const msg = (t: string, ok = false) => { $('save-msg').innerHTML = `<span class="${ok ? 'ok' : 'err'}">${t}</span>`; };
  const v = parseVivianJobUrl($<HTMLInputElement>('url').value);
  if (!v.ok) return msg(`Job URL: ${esc(v.error)}`);
  const name = val('f-name'), title = val('f-title');
  if (!name) return msg('Enter the facility name.');
  if (orgNameGenericity(name) === 'generic') return msg(`“${esc(name)}” is a generic description, not an organization name.`);
  if (!title) return msg('Enter the job title.');
  const decision = val('f-decision');
  if (decision === 'exclude') return msg('Out-of-scope jobs are not saved. Change the decision if the classification is wrong.');

  const r = current.result;
  const now = new Date().toISOString();
  for (const f of db) {
    const j = f.jobs.find((x) => x.url === v.url);
    if (j) { j.lastSeen = now; persist(); return msg(`Already saved under ${esc(f.name)}; last-seen date updated.`, true); }
  }
  const careLine = (val('f-care') || null) as CareLine | null;
  const license = val('f-license') || null, role = val('f-role') || null;
  const auto = classifyJob({ title, context: [r.job.specialtyHint, name].join(' ') });
  const manual = decision !== auto.decision || careLine !== auto.careLine || license !== auto.license || role !== auto.role;
  const specialty = careLine ? `${CARE_LINE_LABEL[careLine]} ${role && role !== 'Case Manager' && role !== 'Visit' ? `${role} ` : ''}${license ?? 'Nurse'}${role === 'Case Manager' ? ' Case Manager' : ''}` : null;
  const corrections: string[] = [];
  if ((r.facility.name ?? '') !== name) corrections.push(`facility name “${r.facility.name ?? ''}” → “${name}”`);
  if ((r.job.title ?? '') !== title) corrections.push(`title “${r.job.title ?? ''}” → “${title}”`);
  if (manual) corrections.push('classification set manually');
  const job: Job = {
    url: v.url, title, specialty, decision, careLine, license, role, vms: r.vms.name, advertiser: r.advertiser?.name ?? null,
    identityStatus: r.facility.name && r.facility.name === name ? r.status : 'manual', sourceField: r.facility.sourceField, originalValue: r.facility.name,
    firstSeen: now, lastSeen: now, corrections,
  };
  const dest = (document.querySelector('input[name=dest]:checked') as HTMLInputElement | null)?.value ?? 'new';
  const existing = db.find((f) => f.id === dest);
  if (existing) {
    existing.jobs.push(job);
    for (const [k, id] of [['street', 'f-street'], ['city', 'f-city'], ['zip', 'f-zip'], ['parent', 'f-parent']] as const) if (!existing[k] && val(id)) existing[k] = val(id);
    if (!existing.state && val('f-state')) existing.state = normalizeState(val('f-state'));
  } else {
    db.push({ id: uid(), name, street: val('f-street'), city: val('f-city'), state: val('f-state') ? normalizeState(val('f-state')) : '', zip: val('f-zip'), parent: val('f-parent'),
      website: '', phone: '', status: 'New Lead', owner: '', nextFollowUp: '', notes: '', existingClient: false, createdAt: now, jobs: [job] });
  }
  persist();
  msg(existing ? `Added to ${esc(existing.name)}.` : 'Saved as a new facility.', true);
  $<HTMLButtonElement>('save').disabled = true;
}

// ---- saved facilities -------------------------------------------------------------------
function filtered(): Facility[] {
  const q = $<HTMLInputElement>('q').value.trim().toLowerCase();
  const st = $<HTMLSelectElement>('fs').value, cl = $<HTMLSelectElement>('fc').value, ss = $<HTMLSelectElement>('fst').value;
  return db.filter((f) => (!q || [f.name, f.parent, f.city, f.owner, ...f.jobs.map((j) => j.title), ...f.jobs.map((j) => j.vms)].some((x) => x?.toLowerCase().includes(q)))
    && (!st || f.state === st) && (!cl || careOf(f).includes(cl as CareLine)) && (!ss || f.status === ss))
    .sort((a, b) => lastSeen(b).localeCompare(lastSeen(a)));
}

function renderList() {
  const states = [...new Set(db.map((f) => f.state).filter(Boolean))].sort();
  const fs = $<HTMLSelectElement>('fs'), keep = fs.value;
  fs.innerHTML = `<option value="">All states</option>${states.map((s) => `<option ${s === keep ? 'selected' : ''}>${esc(s)}</option>`).join('')}`;
  const rows = filtered();
  const due = db.filter((f) => f.nextFollowUp && f.nextFollowUp <= today() && !['Not a Fit', 'Existing Client'].includes(f.status)).length;
  $('stats').textContent = `${db.length} facilities · ${db.reduce((n, f) => n + f.jobs.length, 0)} jobs · ${due} follow-ups due`;
  $('list').innerHTML = rows.length ? `<table><tr><th>Facility</th><th>City</th><th>State</th><th>Type</th><th>Specialties</th><th>Jobs</th><th>VMS</th><th>Status</th><th>Owner</th><th>Follow-up</th><th>Last seen</th></tr>
    ${rows.map((f) => `<tr data-id="${f.id}" class="click"><td><b>${esc(f.name)}</b>${f.existingClient ? ' ' + badge('x', 'Existing client') : ''}${f.parent ? `<div class="muted small">${esc(f.parent)}</div>` : ''}</td>
      <td>${esc(f.city)}</td><td>${esc(f.state)}</td><td>${esc(typeOf(f))}</td><td class="small">${esc([...new Set(f.jobs.map((j) => j.specialty).filter(Boolean))].join(', '))}</td>
      <td>${f.jobs.length}</td><td>${esc([...new Set(f.jobs.map((j) => j.vms).filter(Boolean))].join(', '))}</td><td>${esc(f.status)}</td><td>${esc(f.owner)}</td>
      <td class="${f.nextFollowUp && f.nextFollowUp <= today() ? 'err' : ''}">${esc(f.nextFollowUp)}</td><td>${esc(lastSeen(f).slice(0, 10))}</td></tr>`).join('')}</table>`
    : `<p class="muted">${db.length ? 'No facilities match.' : 'No facilities saved yet.'}</p>`;
  for (const tr of $('list').querySelectorAll<HTMLElement>('tr[data-id]')) tr.onclick = () => openDetail(tr.dataset.id!);
}

function openDetail(id: string) {
  const f = db.find((x) => x.id === id);
  if (!f) return;
  const d = $<HTMLDialogElement>('detail');
  const input = (k: keyof Facility, label: string, type = 'text') => `<label>${label}<input data-k="${k}" type="${type}" value="${esc(f[k])}"></label>`;
  d.innerHTML = `<form method="dialog">
    <div class="row spread"><h2>${esc(f.name)}</h2><button value="close">Close</button></div>
    <div class="grid">
      ${input('name', 'Facility name')}${input('parent', 'Parent organization')}${input('street', 'Street')}${input('city', 'City')}${input('state', 'State')}${input('zip', 'ZIP')}
      ${input('website', 'Official website (verified)')}${input('phone', 'Public phone (verified)')}
      <label>Lead status<select data-k="status">${STATUSES.map((s) => `<option ${s === f.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      ${input('owner', 'Assigned owner')}${input('nextFollowUp', 'Next follow-up', 'date')}
      <label class="check"><input type="checkbox" data-k="existingClient" ${f.existingClient ? 'checked' : ''}> Existing SkyBridge client</label>
      <label class="span2">Notes (contacts, outreach, research sources)<textarea data-k="notes" rows="4">${esc(f.notes)}</textarea></label>
    </div>
    <h3>Jobs (${f.jobs.length})</h3>
    <table class="small"><tr><th>Title</th><th>Specialty</th><th>Found as</th><th>VMS / advertiser</th><th>First / last seen</th><th></th></tr>
    ${f.jobs.map((j, i) => `<tr><td><a href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">${esc(j.title)}</a></td><td>${esc(j.specialty)} ${badge(j.decision)}</td>
      <td>${badge(j.identityStatus)}<div class="muted">${j.sourceField ? `<code>${esc(j.sourceField)}</code> = “${esc(j.originalValue)}”` : ''}${j.corrections.length ? `<br>Corrected: ${esc(j.corrections.join('; '))}` : ''}</div></td>
      <td>${esc(j.vms ?? '')}${j.advertiser ? `<div class="muted">${esc(j.advertiser)}</div>` : ''}</td><td>${esc(j.firstSeen.slice(0, 10))}<br>${esc(j.lastSeen.slice(0, 10))}</td>
      <td><button type="button" data-rm="${i}" class="link">Remove</button></td></tr>`).join('')}</table>
    <div class="row spread" style="margin-top:12px">
      <span>Merge into: <select id="merge-into"><option value="">Choose a facility…</option>${db.filter((x) => x.id !== f.id).sort((a, b) => a.name.localeCompare(b.name)).map((x) => `<option value="${x.id}">${esc(x.name)} (${esc([x.city, x.state].filter(Boolean).join(', '))})</option>`).join('')}</select>
        <button type="button" id="merge">Merge</button></span>
      <button type="button" id="del" class="danger">Delete facility</button>
    </div></form>`;
  d.querySelectorAll<HTMLInputElement>('[data-k]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.k as keyof Facility;
    (f as unknown as Record<string, unknown>)[k] = el.type === 'checkbox' ? el.checked : k === 'state' ? normalizeState(el.value) : el.value.trim();
    if (k === 'status' && el.value === 'Existing Client') f.existingClient = true;
    persist();
  }));
  d.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) => b.onclick = () => {
    if (!confirm('Remove this job from the facility?')) return;
    f.jobs.splice(Number(b.dataset.rm), 1); persist(); openDetail(f.id);
  });
  $('merge').onclick = () => {
    const target = db.find((x) => x.id === $<HTMLSelectElement>('merge-into').value);
    if (!target || !confirm(`Move all ${f.jobs.length} job(s) and notes from “${f.name}” into “${target.name}” and delete “${f.name}”? Make a Backup first if unsure.`)) return;
    target.jobs.push(...f.jobs.filter((j) => !target.jobs.some((t) => t.url === j.url)));
    if (f.notes) target.notes = [target.notes, `[Merged from ${f.name}] ${f.notes}`].filter(Boolean).join('\n');
    db = db.filter((x) => x !== f); persist(); openDetail(target.id);
  };
  $('del').onclick = () => { if (confirm(`Delete “${f.name}” and its ${f.jobs.length} job(s)?`)) { db = db.filter((x) => x !== f); persist(); d.close(); } };
  if (!d.open) d.showModal();
}

// ---- export / backup ---------------------------------------------------------------------
function download(name: string, text: string, type: string) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function exportCsv() {
  const head = ['Facility', 'Parent', 'Street', 'City', 'State', 'ZIP', 'Website', 'Phone', 'Facility Type', 'Lead Status', 'Owner', 'Existing Client', 'Next Follow-Up', 'Notes',
    'Job Title', 'Specialty', 'Classification', 'License', 'VMS', 'Advertiser', 'Found As', 'Source Field', 'Original Value', 'First Seen', 'Last Seen', 'Source URL'];
  const lines = [head.join(',')];
  for (const f of filtered()) for (const j of f.jobs) {
    lines.push([f.name, f.parent, f.street, f.city, f.state, f.zip, f.website, f.phone, typeOf(f), f.status, f.owner, f.existingClient ? 'Yes' : 'No', f.nextFollowUp, f.notes,
      j.title, j.specialty, j.decision, j.license, j.vms, j.advertiser, j.identityStatus, j.sourceField, j.originalValue, j.firstSeen.slice(0, 10), j.lastSeen.slice(0, 10), j.url].map(cell).join(','));
  }
  download(`skybridge-facility-leads-${today()}.csv`, `﻿${lines.join('\r\n')}`, 'text/csv');
}

async function restore(file: File) {
  let incoming: Facility[];
  try { incoming = JSON.parse(await file.text()); if (!Array.isArray(incoming) || incoming.some((f) => !f.id || !f.name || !Array.isArray(f.jobs))) throw new Error(); }
  catch { return alert('That file is not a Lead Finder backup.'); }
  let added = 0, merged = 0;
  for (const inc of incoming) {
    const same = db.find((f) => f.id === inc.id);
    if (same) { for (const j of inc.jobs) if (!same.jobs.some((x) => x.url === j.url)) { same.jobs.push(j); merged++; } }
    else { db.push(inc); added++; }
  }
  persist();
  alert(`Restored: ${added} new facilities, ${merged} jobs added to existing ones.`);
}

// ---- wire up ------------------------------------------------------------------------------
const area = $<HTMLTextAreaElement>('src');
area.addEventListener('paste', () => setTimeout(() => runExtraction(area.value), 0));
$('go').onclick = () => area.value.trim() ? runExtraction(area.value) : alert('Paste the job page source first.');
$('clip').onclick = async () => {
  try { area.value = await navigator.clipboard.readText(); runExtraction(area.value); }
  catch { area.focus(); alert('The browser blocked clipboard access. Click in the box and press Ctrl+V instead.'); }
};
$('clear').onclick = () => { area.value = ''; $<HTMLInputElement>('url').value = ''; current = null; renderResult(); area.focus(); };
for (const id of ['q', 'fs', 'fc', 'fst']) $(id).addEventListener('input', renderList);
$<HTMLSelectElement>('fst').innerHTML = `<option value="">All statuses</option>${STATUSES.map((s) => `<option>${s}</option>`).join('')}`;
$<HTMLSelectElement>('fc').innerHTML = `<option value="">All care lines</option>${Object.entries(CARE_LINE_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}`;
$('csv').onclick = exportCsv;
$('backup').onclick = () => download(`skybridge-lead-finder-backup-${today()}.json`, JSON.stringify(db, null, 1), 'application/json');
$<HTMLInputElement>('restore').onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) restore(f); (e.target as HTMLInputElement).value = ''; };
window.addEventListener('storage', (e) => { if (e.key === KEY) { db = load(); renderList(); } });
renderList();
