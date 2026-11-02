(() => {
  const $ = id => document.getElementById(id);
  const KEY = 'supplylink.token';
  const store = {
    get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } },
    set: t => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch {} },
  };
  let me = null;
  let timer = null;

  async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
    const token = store.get();
    const res = await fetch(`api/${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    if (res.status === 401 && path !== 'login') { store.set(null); showLogin(); throw new Error('Please log in again.'); }
    if (res.status === 204) return null;
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = s => (s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const FIELD_LABELS = { productID: 'Product ID', name: 'Name', description: 'Description', price: 'Price', currency: 'Currency', stock: 'Stock' };
  const CHANNELS = { portal: 'Portal', ftp: 'FTP', folder: 'Folder' };

  const done = t => t.status === 'applied' || t.status === 'unchanged';
  const perSystem = targets => targets.map(t => `${t.name}: ${done(t) ? `${t.created || 0} new, ${t.updated || 0} updated` : t.status}`).join(' · ');

  function resultText(d) {
    const s = d.summary || {};
    const targets = Object.values(s.targets || {});
    const products = `${d.rows} product${d.rows === 1 ? '' : 's'}`;
    if ((d.status === 'applied' || d.status === 'unchanged') && targets.length > 1) return `${products} · ${perSystem(targets)}`;
    if (d.status === 'applied' || d.status === 'unchanged')
      return `${products}: ${s.created} new, ${s.updated} updated, ${s.unchanged} unchanged${s.shop ? ' · in the shop' : ''}`;
    if (d.status === 'rejected') return `${d.errors.length} problem(s) – nothing was changed`;
    if (d.status === 'partial') return `partly applied – ${d.errors.length} problem(s) · ${perSystem(targets)}`;
    if (d.status === 'waiting') return (d.errors[0] || 'waiting') + (targets.some(done) ? ` · ${perSystem(targets)}` : '');
    return 'being processed…';
  }

  function showLogin() {
    clearInterval(timer);
    $('app-view').hidden = true;
    $('who').hidden = true;
    $('login-view').hidden = false;
    api('demo-accounts').then(list => {
      $('demo').hidden = !list.length;
      $('demo-list').innerHTML = list.map(a =>
        `<button type="button" data-u="${esc(a.username)}" data-p="${esc(a.password)}"><span>${esc(a.username)}</span><small>${esc(a.name)}</small></button>`).join('');
    }).catch(() => {});
  }
  $('demo-list').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    $('username').value = b.dataset.u;
    $('password').value = b.dataset.p;
  });
  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    $('login-error').hidden = true;
    try {
      const r = await api('login', { method: 'POST', body: { username: $('username').value.trim(), password: $('password').value } });
      store.set(r.token);
      $('password').value = '';
      await showApp();
    } catch (err) {
      $('login-error').textContent = err.message;
      $('login-error').hidden = false;
    }
  });
  $('logout').addEventListener('click', async () => {
    await api('logout', { method: 'POST' }).catch(() => {});
    store.set(null);
    showLogin();
  });

  async function showApp() {
    me = await api('me');
    $('login-view').hidden = true;
    $('app-view').hidden = false;
    $('who').hidden = false;
    $('who-supplier').textContent = me.supplier.name;
    $('who-user').textContent = `${me.user.name} · ${me.user.username}`;
    $('greeting').textContent = `Hello ${me.user.name.split(' ')[0]}`;
    $('location').textContent = `${me.supplier.name}${me.supplier.location ? ` · ${me.supplier.location}` : ''}`;
    renderFormat(me.format);
    $('sample').hidden = !me.sample;
    $('ftp-card').hidden = !me.ftp;
    if (me.ftp) {
      $('ftp').innerHTML = `<dt>Host</dt><dd><code>${esc(me.ftp.host)}</code></dd><dt>Port</dt><dd><code>${me.ftp.port}</code></dd>` +
        `<dt>Username</dt><dd><code>${esc(me.ftp.username)}</code></dd><dt>Upload into</dt><dd><code>${me.ftp.folder}</code></dd>` +
        `<dt>Mode</dt><dd>plain FTP, passive</dd>`;
    }
    await loadDeliveries();
    clearInterval(timer);
    timer = setInterval(() => loadDeliveries().catch(() => {}), 5000);
  }

  function renderFormat(f) {
    const fmt = { auto: 'any (detected from the file)', csv: 'CSV / text', xlsx: 'Excel (.xlsx)', json: 'JSON', xml: 'XML' }[f.format] || f.format;
    const rows = [
      ['File format', fmt],
      ...(f.delimiter ? [['Separator', `<code>${esc(f.delimiter === '\t' || f.delimiter === '\\t' ? 'TAB' : f.delimiter)}</code>`]] : []),
      ['Decimal sign', f.decimal === ',' ? 'comma (12,90)' : f.decimal === '.' ? 'point (12.90)' : 'detected'],
      ...(f.recordPath ? [[f.format === 'xml' ? 'Product element' : 'Product list', `<code>${esc(f.recordPath)}</code>`]] : []),
      ['You may update', f.update.length ? f.update.join(', ') : 'nothing (new products only)'],
      ['New products', f.createProducts ? 'allowed (name and price required)' : 'not allowed'],
    ];
    $('format').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    const EXAMPLES = { productID: 'SKU, Part Number, Artikelnummer', name: 'Name, Title, Item Name, Bezeichnung', description: 'Description, Long Description, Beschreibung',
                       price: 'Price, Unit Price, Preis', currency: 'Currency, Währung, or in the price (12,90 €)', stock: 'Stock, Qty Available, Bestand' };
    $('mapping').innerHTML = Object.entries(FIELD_LABELS).map(([k, label]) =>
      `<tr><td>${label}</td><td>${f.fields?.[k] ? `<code>${esc(f.fields[k])}</code>` : `<span class="muted">detected – e.g. ${esc(EXAMPLES[k])}</span>`}</td></tr>`).join('');
  }

  async function loadDeliveries() {
    const list = await api('deliveries');
    $('no-deliveries').hidden = list.length > 0;
    $('deliveries').innerHTML = list.map(d => `
      <tr>
        <td class="nowrap">${when(d.receivedAt)}</td>
        <td class="file">${esc(d.originalName)}${d.username ? `<br><span class="muted small">${esc(d.username)}</span>` : ''}</td>
        <td>${CHANNELS[d.channel] || d.channel}</td>
        <td><span class="badge ${d.status}">${d.status}</span></td>
        <td>${esc(resultText(d))}${['applied', 'unchanged', 'rejected', 'partial'].includes(d.status) ? `<br><button class="link" data-report="${d.id}">acknowledgement</button>` : ''}</td>
      </tr>`).join('');
  }
  $('deliveries').addEventListener('click', async e => {
    const id = e.target.dataset?.report;
    if (!id) return;
    try {
      $('report-text').textContent = await api(`deliveries/${id}/report`);
      $('report').showModal();
    } catch (err) { alert(err.message); }
  });
  $('report-close').addEventListener('click', () => $('report').close());

  async function upload(file) {
    const box = $('upload-result');
    box.hidden = false;
    box.className = 'result';
    box.textContent = `Uploading ${file.name} …`;
    try {
      const d = await api(`upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', raw: file, headers: { 'Content-Type': 'application/octet-stream' } });
      const kind = d.status === 'rejected' ? 'bad' : done(d) ? 'ok' : 'wait';
      box.className = `result ${kind}`;
      const s = d.summary || {};
      const changes = (s.changes || []).slice(0, 8);
      box.innerHTML = `<strong>${esc(file.name)}: ${d.status}</strong> – ${esc(resultText(d))}` +
        (d.errors.length && (d.status === 'rejected' || d.status === 'partial') ? `<ul>${d.errors.slice(0, 8).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '') +
        (changes.length ? `<ul>${changes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
    } catch (err) {
      box.className = 'result bad';
      box.textContent = err.message;
    }
    loadDeliveries().catch(() => {});
  }
  $('file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) upload(f); });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) upload(f); });

  $('sample').addEventListener('click', async e => {
    e.preventDefault();
    try {
      const res = await fetch('api/sample', { headers: { Authorization: `Bearer ${store.get()}` } });
      if (!res.ok) throw new Error('No sample file.');
      const name = /filename="?([^";]+)/.exec(res.headers.get('content-disposition') || '')?.[1] || 'sample';
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { alert(err.message); }
  });

  if (store.get()) showApp().catch(() => showLogin());
  else showLogin();
})();
