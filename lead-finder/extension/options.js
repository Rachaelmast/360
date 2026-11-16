const $ = (id) => document.getElementById(id);
chrome.storage.local.get(['server', 'token']).then((c) => { $('server').value = c.server ?? ''; $('token').value = c.token ?? ''; });

$('save').onclick = async () => {
  const msg = $('msg');
  let origin;
  try { origin = new URL($('server').value.trim()).origin; } catch { msg.textContent = 'Enter a valid server address, e.g. https://leads.example.com'; return; }
  const token = $('token').value.trim();
  // Ask for access to this one server only.
  if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) { msg.textContent = 'Permission to reach the server was not granted.'; return; }
  await chrome.storage.local.set({ server: origin, token });
  try {
    const res = await fetch(`${origin}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    const data = await res.json();
    msg.textContent = res.ok ? `Connected as ${data.user.name} (${data.user.email}).` : `Saved, but the server said: ${data.error ?? res.status}`;
  } catch (e) {
    msg.textContent = `Saved, but the server could not be reached: ${e.message}`;
  }
};
