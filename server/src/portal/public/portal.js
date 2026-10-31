// SupplyLink - supplier portal page (plain JavaScript, no build step).
// All API paths are relative ("api/..."), so the page works on its own port (http://localhost:3200/) and under
// /portal/ of the shop.
// Everything inside one function that runs at once, so no variable leaks into the global scope.
(() => {
  // Short helper: element by id.
  const $ = id => document.getElementById(id);
  // Key of the session token in sessionStorage (one login per browser tab).
  const KEY = 'supplylink.token';
  // Reads and writes the token.
  const store = {
    // The stored token, or null (also when storage is blocked).
    get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } },
    // Store the token, or remove it when t is null.
    set: t => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage blocked */ } },
  };
  // The logged-in user, supplier, format and FTP data (GET api/me).
  let me = null;
  // Timer that refreshes the deliveries.
  let timer = null;

  // fetch wrapper: JSON in/out, session token, errors as Error(message)
  async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
    // The current token.
    const token = store.get();
    // Relative URL: works on the portal's own port and under /portal/.
    const res = await fetch(`api/${path}`, {
      // HTTP method.
      method,
      // Token header; JSON content type for JSON bodies; extra headers of the caller.
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      // Raw body (a file) or JSON.
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    // 401 (session expired): forget the token and show the login.
    if (res.status === 401 && path !== 'login') { store.set(null); showLogin(); throw new Error('Please log in again.'); }
    // No content.
    if (res.status === 204) return null;
    // Type of the answer.
    const type = res.headers.get('content-type') || '';
    // JSON or plain text (reports).
    const data = type.includes('json') ? await res.json() : await res.text();
    // Error answer: throw with the server's message.
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    // The data.
    return data;
  }

  // Escapes text for innerHTML (file names and messages come from users: no HTML injection).
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // SQLite UTC "YYYY-MM-DD HH:MM:SS" -> local date/time
  // Date/time in the format of the browser's language.
  const when = s => (s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  // Labels of the canonical fields.
  const FIELD_LABELS = { productID: 'Product ID', name: 'Name', description: 'Description', price: 'Price', currency: 'Currency', stock: 'Stock' };
  // Labels of the delivery channels.
  const CHANNELS = { portal: 'Portal', ftp: 'FTP', folder: 'Folder' };

  // A VeloCity system that is done (written or nothing to write).
  const done = t => t.status === 'applied' || t.status === 'unchanged';
  // Per VeloCity system (e.g. local ERP and SAP BTP): "SAP BTP: 2 new, 1 updated" or "SAP BTP: waiting".
  // One text for all systems.
  const perSystem = targets => targets.map(t => `${t.name}: ${done(t) ? `${t.created || 0} new, ${t.updated || 0} updated` : t.status}`).join(' · ');

  // Result text of a delivery for the table and the upload box.
  function resultText(d) {
    // Summary from the server.
    const s = d.summary || {};
    // VeloCity systems (target ERPs) of the delivery.
    const targets = Object.values(s.targets || {});
    // '1 product' / '5 products'.
    const products = `${d.rows} product${d.rows === 1 ? '' : 's'}`;
    // Applied to several systems: per-system counters.
    if ((d.status === 'applied' || d.status === 'unchanged') && targets.length > 1) return `${products} · ${perSystem(targets)}`;
    // Applied to one system: counters.
    if (d.status === 'applied' || d.status === 'unchanged')
      // New, updated and unchanged; 'in the shop' when the shop was updated.
      return `${products}: ${s.created} new, ${s.updated} updated, ${s.unchanged} unchanged${s.shop ? ' · in the shop' : ''}`;
    // Rejected: number of problems.
    if (d.status === 'rejected') return `${d.errors.length} problem(s) – nothing was changed`;
    // Partly applied: problems and per-system result.
    if (d.status === 'partial') return `partly applied – ${d.errors.length} problem(s) · ${perSystem(targets)}`;
    // Waiting: the reason (and what is already done).
    if (d.status === 'waiting') return (d.errors[0] || 'waiting') + (targets.some(done) ? ` · ${perSystem(targets)}` : '');
    // Received, not processed yet.
    return 'being processed…';
  }

  /* ---------- login ---------- */
  // Shows the login view.
  function showLogin() {
    // Stop refreshing the deliveries.
    clearInterval(timer);
    // Hide the dashboard.
    $('app-view').hidden = true;
    // Hide the supplier in the top bar.
    $('who').hidden = true;
    // Show the login.
    $('login-view').hidden = false;
    // Load the demo suppliers (GET api/demo-accounts).
    api('demo-accounts').then(list => {
      // Hide the box when there are none.
      $('demo').hidden = !list.length;
      // One button per demo supplier; username and password in data attributes.
      $('demo-list').innerHTML = list.map(a =>
        `<button type="button" data-u="${esc(a.username)}" data-p="${esc(a.password)}"><span>${esc(a.username)}</span><small>${esc(a.name)}</small></button>`).join('');
    // Errors are ignored (no demo box).
    }).catch(() => {});
  }
  // Click on a demo supplier: fill the login form.
  $('demo-list').addEventListener('click', e => {
    // The clicked button (also when the click hit its inner text).
    const b = e.target.closest('button');
    // Click between the buttons.
    if (!b) return;
    // Username.
    $('username').value = b.dataset.u;
    // Password.
    $('password').value = b.dataset.p;
  });
  // Login form sent.
  $('login-form').addEventListener('submit', async e => {
    // No page reload.
    e.preventDefault();
    // Hide the old error.
    $('login-error').hidden = true;
    try {
      // POST api/login.
      const r = await api('login', { method: 'POST', body: { username: $('username').value.trim(), password: $('password').value } });
      // Remember the session token.
      store.set(r.token);
      // Clear the password field.
      $('password').value = '';
      // Show the dashboard.
      await showApp();
    } catch (err) {
      // Error text (same for wrong user and wrong password).
      $('login-error').textContent = err.message;
      // Show it.
      $('login-error').hidden = false;
    }
  });
  // Logout button.
  $('logout').addEventListener('click', async () => {
    // POST api/logout (errors are ignored).
    await api('logout', { method: 'POST' }).catch(() => {});
    // Forget the token.
    store.set(null);
    // Back to the login.
    showLogin();
  });

  /* ---------- dashboard ---------- */
  // Shows the dashboard of the logged-in supplier.
  async function showApp() {
    // GET api/me.
    me = await api('me');
    // Hide the login.
    $('login-view').hidden = true;
    // Show the dashboard.
    $('app-view').hidden = false;
    // Show the supplier in the top bar.
    $('who').hidden = false;
    // Supplier name.
    $('who-supplier').textContent = me.supplier.name;
    // Employee name and username.
    $('who-user').textContent = `${me.user.name} · ${me.user.username}`;
    // Greeting with the first name.
    $('greeting').textContent = `Hello ${me.user.name.split(' ')[0]}`;
    // Supplier and location.
    $('location').textContent = `${me.supplier.name}${me.supplier.location ? ` · ${me.supplier.location}` : ''}`;
    // Fill the 'agreed format' card.
    renderFormat(me.format);
    // Sample download only when a sample exists.
    $('sample').hidden = !me.sample;
    // FTP card only when FTP is on.
    $('ftp-card').hidden = !me.ftp;
    // FTP access data.
    if (me.ftp) {
      // Host, port, username, upload folder and mode.
      $('ftp').innerHTML = `<dt>Host</dt><dd><code>${esc(me.ftp.host)}</code></dd><dt>Port</dt><dd><code>${me.ftp.port}</code></dd>` +
        `<dt>Username</dt><dd><code>${esc(me.ftp.username)}</code></dd><dt>Upload into</dt><dd><code>${me.ftp.folder}</code></dd>` +
        `<dt>Mode</dt><dd>plain FTP, passive</dd>`;
    }
    // Load the deliveries.
    await loadDeliveries();
    // Restart the timer.
    clearInterval(timer);
    // Refresh the deliveries every 5 seconds.
    timer = setInterval(() => loadDeliveries().catch(() => {}), 5000);
  }

  // Fills the 'agreed format' card from the supplier's mapping profile.
  function renderFormat(f) {
    // Readable file format.
    const fmt = { auto: 'any (detected from the file)', csv: 'CSV / text', xlsx: 'Excel (.xlsx)', json: 'JSON', xml: 'XML' }[f.format] || f.format;
    // Rows of the fact list: [label, value].
    const rows = [
      // File format.
      ['File format', fmt],
      // Separator (only when agreed).
      ...(f.delimiter ? [['Separator', `<code>${esc(f.delimiter === '\t' || f.delimiter === '\\t' ? 'TAB' : f.delimiter)}</code>`]] : []),
      // Decimal sign.
      ['Decimal sign', f.decimal === ',' ? 'comma (12,90)' : f.decimal === '.' ? 'point (12.90)' : 'detected'],
      // JSON path / XML element (only when agreed).
      ...(f.recordPath ? [[f.format === 'xml' ? 'Product element' : 'Product list', `<code>${esc(f.recordPath)}</code>`]] : []),
      // Fields the supplier may change.
      ['You may update', f.update.length ? f.update.join(', ') : 'nothing (new products only)'],
      // Whether new products are allowed.
      ['New products', f.createProducts ? 'allowed (name and price required)' : 'not allowed'],
    ];
    // Render the fact list.
    $('format').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    // Fields without an agreed name are detected from the usual names - a few examples per field.
    // Examples of field names that are detected automatically.
    const EXAMPLES = { productID: 'SKU, Part Number, Artikelnummer', name: 'Name, Title, Item Name, Bezeichnung', description: 'Description, Long Description, Beschreibung',
                       price: 'Price, Unit Price, Preis', currency: 'Currency, Währung, or in the price (12,90 €)', stock: 'Stock, Qty Available, Bestand' };
    // One row per field: agreed name, or the hint that it is detected.
    $('mapping').innerHTML = Object.entries(FIELD_LABELS).map(([k, label]) =>
      `<tr><td>${label}</td><td>${f.fields?.[k] ? `<code>${esc(f.fields[k])}</code>` : `<span class="muted">detected – e.g. ${esc(EXAMPLES[k])}</span>`}</td></tr>`).join('');
  }

  // Loads and renders the supplier's deliveries.
  async function loadDeliveries() {
    // GET api/deliveries (only this supplier's deliveries).
    const list = await api('deliveries');
    // Empty state.
    $('no-deliveries').hidden = list.length > 0;
    // One table row per delivery: time, file, channel, status and result (with a report button for final statuses).
    $('deliveries').innerHTML = list.map(d => `
      <tr>
        <td class="nowrap">${when(d.receivedAt)}</td>
        <td class="file">${esc(d.originalName)}${d.username ? `<br><span class="muted small">${esc(d.username)}</span>` : ''}</td>
        <td>${CHANNELS[d.channel] || d.channel}</td>
        <td><span class="badge ${d.status}">${d.status}</span></td>
        <td>${esc(resultText(d))}${['applied', 'unchanged', 'rejected', 'partial'].includes(d.status) ? `<br><button class="link" data-report="${d.id}">acknowledgement</button>` : ''}</td>
      </tr>`).join('');
  }
  // Click on a report button in the table.
  $('deliveries').addEventListener('click', async e => {
    // Delivery id of the button.
    const id = e.target.dataset?.report;
    // Click elsewhere in the table.
    if (!id) return;
    try {
      // GET the report text.
      $('report-text').textContent = await api(`deliveries/${id}/report`);
      // Open the dialog.
      $('report').showModal();
    // Error message.
    } catch (err) { alert(err.message); }
  });
  // Close button of the dialog.
  $('report-close').addEventListener('click', () => $('report').close());

  /* ---------- upload ---------- */
  // Uploads one file and shows the result.
  async function upload(file) {
    // Result box.
    const box = $('upload-result');
    // Show it.
    box.hidden = false;
    // Neutral color while uploading.
    box.className = 'result';
    // Progress text.
    box.textContent = `Uploading ${file.name} …`;
    try {
      // POST api/upload with the file as body; the server answers when the file is processed.
      const d = await api(`upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file, headers: { 'Content-Type': 'application/octet-stream' } });
      // Box color: rejected red, applied green, otherwise orange.
      const kind = d.status === 'rejected' ? 'bad' : done(d) ? 'ok' : 'wait';
      // Set the color.
      box.className = `result ${kind}`;
      // Summary.
      const s = d.summary || {};
      // First eight changes.
      const changes = (s.changes || []).slice(0, 8);
      // Status and result text, then the problems (rejected / partial) and the changes.
      box.innerHTML = `<strong>${esc(file.name)}: ${d.status}</strong> – ${esc(resultText(d))}` +
        (d.errors.length && (d.status === 'rejected' || d.status === 'partial') ? `<ul>${d.errors.slice(0, 8).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '') +
        (changes.length ? `<ul>${changes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
    } catch (err) {
      // Upload failed: red box.
      box.className = 'result bad';
      // Error text.
      box.textContent = err.message;
    }
    // Refresh the table.
    loadDeliveries().catch(() => {});
  }
  // File chosen with the file dialog: upload it (and reset the input so the same file can be chosen again).
  $('file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) upload(f); });
  // The drop zone.
  const drop = $('drop');
  // Dragging over the zone: allow the drop and highlight the zone.
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  // Dragging out or dropped: remove the highlight.
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  // File dropped: upload it.
  drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) upload(f); });

  // sample download (fetch with the token, then save)
  // Sample download link.
  $('sample').addEventListener('click', async e => {
    // No navigation (the link has href="#").
    e.preventDefault();
    try {
      // GET api/sample with the token.
      const res = await fetch('api/sample', { headers: { Authorization: `Bearer ${store.get()}` } });
      // No sample.
      if (!res.ok) throw new Error('No sample file.');
      // File name from the Content-Disposition header.
      const name = /filename="?([^";]+)/.exec(res.headers.get('content-disposition') || '')?.[1] || 'sample';
      // Temporary URL for the bytes.
      const url = URL.createObjectURL(await res.blob());
      // Click an invisible download link.
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      // Free the URL a moment later.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    // Error message.
    } catch (err) { alert(err.message); }
  });

  // start: logged in already (session in this tab)?
  // A stored token: try to show the dashboard (back to the login if the session expired).
  if (store.get()) showApp().catch(() => showLogin());
  // No token: login.
  else showLogin();
})();
