// Runs only when the user clicks the extension. Reads the current tab (activeTab permission),
// sends its HTML to the SkyBridge server for extraction, and saves the lead on request.
const app = document.getElementById('app');
document.getElementById('opts').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IDENTITY = { confirmed: ['Confirmed facility', 'green'], possible: ['Possible facility', 'amber'], agency_only: ['Staffing agency only', 'violet'], generic: ['Generic description', 'amber'], not_found: ['Facility not identified', 'red'], error: ['Extraction error', 'red'] };
const DECISION = { accept: ['In scope', 'green'], review: ['Needs review', 'amber'], exclude: ['Out of scope', 'red'] };
const badge = (map, k) => { const [l, c] = map[k] ?? [k, '']; return `<span class="badge ${c}">${esc(l)}</span>`; };
const show = (html) => { app.innerHTML = html; };

async function call(cfg, path, body) {
  const res = await fetch(cfg.server + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
  return data;
}

async function main() {
  const cfg = await chrome.storage.local.get(['server', 'token']);
  if (!cfg.server || !cfg.token) return show('<div class="note warn">Set the server address and your access token first.</div><button id="go">Open settings</button>'), (document.getElementById('go').onclick = () => chrome.runtime.openOptionsPage());

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https:\/\/(www\.)?vivian\.com\/job\/[A-Za-z0-9-]+/.test(tab.url)) {
    return show('<div class="note">Open a Vivian job posting (vivian.com/job/…) and click the extension again.</div>');
  }

  // The rendered page keeps the embedded JSON. If that finds nothing, read the page source
  // the same way Ctrl+U does: one request from the tab itself, with the user's own session.
  const read = async (source) => (await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (src) => (src ? (await fetch(location.href, { credentials: 'include' })).text() : document.documentElement.outerHTML),
    args: [source],
  }))[0].result;

  let data;
  try {
    data = await call(cfg, '/api/extract/html', { html: await read(false), url: tab.url, method: 'extension' });
    if (['not_found', 'error'].includes(data.result.status)) {
      const again = await call(cfg, '/api/extract/html', { html: await read(true), url: tab.url, method: 'extension' });
      if (!['not_found', 'error'].includes(again.result.status)) data = again;
    }
  } catch (e) {
    return show(`<div class="note err">${esc(e.message)}</div><p class="muted">Check the server address and token in Settings, and that the server is running.</p>`);
  }
  render(cfg, data);
}

function render(cfg, data) {
  const r = data.result;
  const auto = data.matches.find((m) => m.strength === 'exact') ?? (data.matches.filter((m) => m.strength === 'likely').length === 1 ? data.matches.find((m) => m.strength === 'likely') : null);
  const vms = r.vms.fields.length || r.vms.mentions.length
    ? `<div class="note"><b>VMS${r.vms.name ? `: ${esc(r.vms.name)}` : ' mentioned'}</b><ul>${r.vms.fields.map((f) => `<li>${esc(f.field)} = ${esc(f.value)}</li>`).join('')}${r.vms.mentions.map((m) => `<li>“…${esc(m)}…”</li>`).join('')}</ul></div>` : '';
  show(`
    <div>${badge(IDENTITY, r.status)}${badge(DECISION, r.classification.decision)}${r.classification.specialty ? `<span class="badge">${esc(r.classification.specialty)}</span>` : ''}</div>
    ${r.facility.sourceField ? `<div class="muted">Facility from <code>${esc(r.facility.sourceField)}</code></div>` : ''}
    ${data.existingJob ? `<div class="note">Already saved${data.existingJob.facility_name ? ` under <b>${esc(data.existingJob.facility_name)}</b>` : ''}. Saving again records a new sighting.</div>` : ''}
    ${[...r.errors.map((x) => `<div class="note err">${esc(x)}</div>`), ...r.warnings.map((x) => `<div class="note warn">${esc(x)}</div>`)].join('')}
    ${r.advertiser ? `<div class="note">Advertised by <b>${esc(r.advertiser.name)}</b>${r.advertiser.looksLikeStaffingAgency ? ' (staffing agency, kept separate)' : ''}</div>` : ''}
    ${vms}
    <label>Facility name *</label><input id="name" value="${esc(r.facility.name)}">
    <label>Street</label><input id="street" value="${esc(r.facility.address.street)}">
    <div class="row"><div><label>City</label><input id="city" value="${esc(r.facility.address.city ?? r.job.city)}"></div><div><label>State</label><input id="state" value="${esc(r.facility.address.state ?? r.job.state)}"></div><div><label>ZIP</label><input id="zip" value="${esc(r.facility.address.zip)}"></div></div>
    <label>Job title *</label><input id="title" value="${esc(r.job.title)}">
    ${data.matches.length ? `<label>Save to</label><select id="choice">${data.matches.map((m) => `<option value="${m.facility.id}" ${auto?.facility.id === m.facility.id ? 'selected' : ''}>${esc(m.facility.name)} · ${esc([m.facility.city, m.facility.state].filter(Boolean).join(', '))} (${m.strength})</option>`).join('')}<option value="new" ${auto ? '' : 'selected'}>Create a new facility</option></select>` : ''}
    <ul class="muted">${r.classification.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <button id="save" ${r.classification.decision === 'exclude' ? 'disabled title="Out of scope; change it in the web app if wrong"' : ''}>Save Lead</button>
    <div id="out"></div>
    <p class="muted" style="margin-top:8px">Need to change the classification? <a href="${esc(cfg.server)}/#/find?extraction=${data.extractionId}" target="_blank">Review in the web app</a></p>`);

  const v = (id) => document.getElementById(id)?.value ?? '';
  document.getElementById('save').onclick = async (e) => {
    e.target.disabled = true;
    const out = document.getElementById('out');
    try {
      const res = await call(cfg, '/api/leads', {
        extractionId: data.extractionId, sourceUrl: data.url, facilityChoice: v('choice') || 'auto',
        facility: { name: v('name'), street: v('street'), city: v('city'), state: v('state'), zip: v('zip') },
        job: { title: v('title') },
      });
      out.innerHTML = `<div class="note ok">${res.existingJob ? 'Already saved; new sighting recorded.' : res.facilityCreated ? 'Saved as a new facility lead.' : 'Saved to the existing facility.'} <a href="${esc(cfg.server)}/#/facility/${res.facilityId}" target="_blank">Open facility record</a></div>`;
    } catch (err) {
      out.innerHTML = `<div class="note err">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  };
}

main().catch((e) => show(`<div class="note err">${esc(e.message)}</div>`));
