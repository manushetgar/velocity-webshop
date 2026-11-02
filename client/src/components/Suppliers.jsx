import { useEffect, useRef, useState } from 'react';
import { api, dateTime } from '../api.js';
import { useToast } from './Toast.jsx';
import Modal from './Modal.jsx';

const FIELDS = [['productID', 'Product ID'], ['name', 'Name'], ['description', 'Description'], ['price', 'Price'], ['currency', 'Currency'], ['stock', 'Stock']];
const UPDATABLE = ['name', 'description', 'price', 'stock'];
const FORMAT_LABEL = { auto: 'Detect automatically', csv: 'CSV / delimited text', xlsx: 'Excel (.xlsx)', json: 'JSON', xml: 'XML' };
const CHANNEL_LABEL = { portal: 'Portal', ftp: 'FTP', folder: 'Folder' };
const STATUS_CLASS = { applied: 'ok', unchanged: '', rejected: 'bad', partial: 'warn', waiting: 'warn', received: 'warn', pending: 'warn' };
const FINAL = ['applied', 'unchanged', 'rejected', 'partial'];
const done = t => t.status === 'applied' || t.status === 'unchanged';
const KIND_LABEL = { local: 'Local', cloud: 'Cloud' };

function TargetList({ targets }) {
  const list = Object.entries(targets || {});
  if (!list.length) return null;
  return (
    <span className="target-list">
      {list.map(([id, t]) => (
        <span key={id} className={`tag ${STATUS_CLASS[t.status] ?? ''}`} title={t.error || (t.shop ? `shop: ${t.shop}` : '')}>
          {t.name}: {done(t) ? `${t.created || 0} new, ${t.updated || 0} updated` : t.status}
        </span>
      ))}
    </span>
  );
}

function TargetSetting({ targets, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const opts = targets.options;
  const ofKind = k => opts.filter(o => o.kind === k);
  const active = opts.find(o => o.active);
  const label = o => (ofKind(o.kind).length === 1 ? KIND_LABEL[o.kind] : o.name);
  const choices = [
    { key: 'active', mode: 'active', ids: [], label: 'Active connector', hint: `follows the shop · ${active?.name || 'none active'}` },
    ...opts.map(o => ({ key: `list:${o.id}`, mode: 'list', ids: [o.id], label: label(o), hint: o.name })),
    ...(opts.length > 1 ? [{
      key: 'all', mode: 'all', ids: [],
      label: ofKind('local').length && ofKind('cloud').length ? 'Both (local + cloud)' : 'All connectors',
      hint: opts.map(o => o.name).join(' + '),
    }] : []),
  ];
  const current = targets.mode === 'list' ? (targets.ids.length === 1 ? `list:${targets.ids[0]}` : '') : targets.mode;
  const names = targets.resolved.map(id => opts.find(o => o.id === id)?.name || id);

  const choose = async c => {
    if (c.key === current) return;
    setBusy(true);
    try {
      await api.setSupplierTargets({ mode: c.mode, ids: c.ids });
      toast(`Supplier data is now written to: ${c.label}`, 'success');
      onChanged();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <section className="card">
      <div className="section-head">
        <h3>Write supplier data to</h3>
        <span className="muted small">new files: <strong>{names.join(' + ') || 'none – files wait'}</strong></span>
      </div>
      <div className="target-choices">
        {choices.map(c => (
          <button key={c.key} className={`target-choice ${current === c.key ? 'active' : ''}`} aria-pressed={current === c.key}
                  disabled={busy} onClick={() => choose(c)}>
            <strong>{c.label}</strong><span>{c.hint}</span>
          </button>
        ))}
      </div>
      <ul className="target-notes muted small">
        <li><strong>Local</strong> = the Mini-ERP on this computer (cds watch) · <strong>Cloud</strong> = the Mini-ERP on SAP BTP (HANA Cloud).</li>
        <li>This shop updates itself right away from its active connector ({active?.name || 'none'}); the cloud shop on SAP BTP picks up changes in SAP BTP with its own ERP sync (every 60 s).</li>
        <li>Both: if one ERP is not reachable, the other one is written at once and the file waits only for the missing one – it is completed automatically. A file keeps the systems it started with.</li>
      </ul>
    </section>
  );
}

function formatSummary(p) {
  const parts = [FORMAT_LABEL[p.format] || p.format];
  if (p.delimiter) parts.push(`separator ${p.delimiter === '\t' || p.delimiter === '\\t' ? 'TAB' : p.delimiter}`);
  if (p.decimal === ',') parts.push('decimal comma');
  if (p.recordPath) parts.push(`${p.format === 'xml' ? 'element' : 'path'} ${p.recordPath}`);
  return parts.join(' · ');
}

function ProfileForm({ supplier, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: supplier.name, location: supplier.location || '', active: supplier.active,
    profile: { format: 'auto', delimiter: '', decimal: 'auto', recordPath: '', defaultCurrency: 'EUR', fields: {}, update: [...UPDATABLE], createProducts: true, ...supplier.profile },
  });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef(null);
  const setP = (k, v) => setForm(f => ({ ...f, profile: { ...f.profile, [k]: v } }));
  const setField = (k, v) => setForm(f => ({ ...f, profile: { ...f.profile, fields: { ...f.profile.fields, [k]: v } } }));
  const toggleUpdate = k => setP('update', form.profile.update.includes(k) ? form.profile.update.filter(x => x !== k) : [...form.profile.update, k]);

  const runPreview = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy('preview');
    try { setPreview({ name: file.name, ...(await api.previewSupplierFile(supplier.id, file, form.profile)) }); } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(''); }
  };
  const save = async () => {
    setBusy('save');
    setError('');
    try {
      await api.updateSupplier(supplier.id, form);
      toast(`${form.name} saved`, 'success');
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  };
  const p = form.profile;

  return (
    <Modal wide title={`Mapping profile · ${supplier.name}`} onClose={onClose}
           footer={<>
             <button disabled={!!busy} onClick={() => fileInput.current.click()}>{busy === 'preview' ? 'Reading…' : 'Test with a file…'}</button>
             <input ref={fileInput} type="file" hidden accept=".csv,.txt,.tsv,.xlsx,.json,.ndjson,.xml" onChange={runPreview} />
             <span className="spacer" />
             <button onClick={onClose}>Cancel</button>
             <button className="primary" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
           </>}>
      <div className="form-grid">
        <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <label>Location<input value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} /></label>
        <label>File format
          <select value={p.format} onChange={e => setP('format', e.target.value)}>
            {Object.entries(FORMAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Decimal sign
          <select value={p.decimal} onChange={e => setP('decimal', e.target.value)}>
            <option value="auto">Detect (12.90 or 12,90)</option><option value=".">Point – 1,299.90</option><option value=",">Comma – 1.299,90</option>
          </select>
        </label>
        <label>Separator (CSV)
          <select value={p.delimiter} onChange={e => setP('delimiter', e.target.value)}>
            <option value="">Detect</option><option value=",">,</option><option value=";">;</option><option value="\t">TAB</option><option value="|">|</option>
          </select>
        </label>
        <label>Product list (JSON path / XML element)<input value={p.recordPath} placeholder="detect, e.g. data.items or Article" onChange={e => setP('recordPath', e.target.value)} /></label>
      </div>

      <h4 className="subhead">Field mapping <span className="muted small">– empty = detected from usual names (SKU, Part Number, Artikelnummer, …)</span></h4>
      <div className="mapping-grid">
        {FIELDS.map(([k, label]) => (
          <label key={k}><span>{label} <span className="muted">←</span></span>
            <input value={p.fields[k] || ''} placeholder="auto" onChange={e => setField(k, e.target.value)} className="mono" />
          </label>
        ))}
      </div>

      <h4 className="subhead">Rights</h4>
      <div className="check-row">
        <span className="muted small">May update:</span>
        {UPDATABLE.map(k => (
          <label key={k} className="check"><input type="checkbox" checked={p.update.includes(k)} onChange={() => toggleUpdate(k)} /> {k}</label>
        ))}
      </div>
      <div className="check-row">
        <label className="check"><input type="checkbox" checked={p.createProducts} onChange={e => setP('createProducts', e.target.checked)} /> May create new products</label>
        <label className="check"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /> Active (portal + FTP login allowed)</label>
      </div>

      {preview && (
        <div className="preview">
          <h4 className="subhead">Test: {preview.name}</h4>
          {preview.format && <p className="small muted">{FORMAT_LABEL[preview.format]} · {Object.entries(preview.info || {}).map(([k, v]) => `${k} ${v}`).join(' · ')} · {preview.records} record(s)</p>}
          {preview.fields && (
            <p className="small"><span className="muted">Fields in the file:</span> {preview.fields.map(f => (
              <code key={f} className={Object.values(preview.mapping || {}).includes(f) ? 'used' : ''}>{f}</code>))}</p>
          )}
          {preview.mapping && (
            <div className="table-wrap">
              <table className="table compact">
                <thead><tr>{FIELDS.map(([k, l]) => <th key={k}>{l}<br /><span className="mono muted">{preview.mapping[k] || '–'}</span></th>)}</tr></thead>
                <tbody>
                  {(preview.products || []).slice(0, 5).map((r, i) => (
                    <tr key={i}>{FIELDS.map(([k]) => <td key={k}>{r[k] ?? <span className="muted">–</span>}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.errors?.length > 0
            ? <ul className="error small">{preview.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}</ul>
            : <p className="test-result ok">The file can be read with this profile – nothing has been imported.</p>}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </Modal>
  );
}

function UsersForm({ supplier, onClose, onChanged }) {
  const toast = useToast();
  const [form, setForm] = useState({ username: '', name: '', password: '' });
  const [error, setError] = useState('');
  const add = async () => {
    setError('');
    try {
      await api.createSupplierUser(supplier.id, form);
      toast(`Login ${form.username} created`, 'success');
      setForm({ username: '', name: '', password: '' });
      onChanged();
    } catch (e) { setError(e.message); }
  };
  const reset = async u => {
    const pw = prompt(`New password for ${u.username} (min. 8 characters):`);
    if (!pw) return;
    try { await api.resetSupplierPassword(u.id, pw); toast(`Password of ${u.username} changed`, 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  const remove = async u => {
    if (!confirm(`Delete the login ${u.username}?`)) return;
    try { await api.deleteSupplierUser(u.id); toast(`${u.username} deleted`, 'info'); onChanged(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={`Logins · ${supplier.name}`} onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      <p className="muted small">The same login works for the supplier portal and for FTP.</p>
      <ul className="simple-list">
        {supplier.users.map(u => (
          <li key={u.id}>
            <span><strong className="mono">{u.username}</strong> <span className="muted small">{u.name}</span></span>
            <span className="nowrap"><button className="link" onClick={() => reset(u)}>New password</button><button className="link danger" onClick={() => remove(u)}>Delete</button></span>
          </li>
        ))}
      </ul>
      <div className="form-grid three">
        <label>Username<input value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} autoComplete="off" /></label>
        <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <label>Password<input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></label>
      </div>
      {error && <p className="error small">{error}</p>}
      <button className="primary" onClick={add} disabled={!form.username || !form.password}>Add login</button>
    </Modal>
  );
}

function Deliveries({ rows, suppliers, onReport }) {
  const [open, setOpen] = useState(null);
  const names = Object.fromEntries(suppliers.map(s => [s.id, s.name]));
  if (!rows.length) return <p className="muted small">No deliveries yet – upload a file in the supplier portal or by FTP.</p>;
  return (
    <div className="table-wrap">
      <table className="table transfer-log">
        <thead><tr><th>Received</th><th>Supplier</th><th>File</th><th>Status</th><th>Result</th></tr></thead>
        <tbody>
          {rows.map(d => {
            const s = d.summary || {};
            const targets = Object.values(s.targets || {});
            const multi = targets.length > 1;
            const shop = s.shop || targets[0]?.shop;
            const details = d.errors.length || d.warnings.length || s.changes?.length || (multi && targets.some(t => t.shop));
            return (
              <tr key={d.id}>
                <td className="nowrap">{dateTime(d.receivedAt)}</td>
                <td>{names[d.supplierId] || d.supplierId}<span className="source-note">{CHANNEL_LABEL[d.channel]}{d.username ? ` · ${d.username}` : ''}</span></td>
                <td className="file-cell"><span className="break">{d.originalName}</span>{d.format && <span className="source-note">{d.format.toUpperCase()}</span>}</td>
                <td><span className={`tag ${STATUS_CLASS[d.status] ?? ''}`}>{d.status}</span></td>
                <td>
                  {d.status === 'applied' || d.status === 'unchanged'
                    ? (multi
                      ? <>{d.rows} product{d.rows === 1 ? '' : 's'} in {targets.length} ERPs</>
                      : <>{d.rows} product{d.rows === 1 ? '' : 's'}: {s.created} new, {s.updated} updated in {targets[0]?.name || 'the ERP'}{shop && <span className="source-note">shop via {shop}</span>}</>)
                    : d.status === 'rejected' ? <span className="error">{d.errors.length} problem(s) – nothing changed</span>
                      : d.status === 'partial' ? <span className="error">partly applied – {d.errors.length} problem(s)</span>
                        : <span className="muted">{d.errors[0] || 'being processed…'}</span>}
                  {(multi || d.status === 'partial') && d.status !== 'rejected' && <TargetList targets={s.targets} />}
                  <span className="nowrap">
                    {details ? <button className="link small" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? 'hide' : 'details'}</button> : null}
                    {FINAL.includes(d.status) && <button className="link small" onClick={() => onReport(d)}>acknowledgement</button>}
                  </span>
                  {open === d.id && (
                    <div className="transfer-details">
                      {d.errors.length > 0 && <ul className="error">{d.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
                      {s.changes?.length > 0 && <ul>{s.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                      {multi && <ul className="muted">{targets.filter(t => t.shop).map((t, i) => <li key={i}>{t.name} → shop: {t.shop}</li>)}</ul>}
                      {d.warnings.length > 0 && <ul className="muted">{d.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Suppliers() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const [users, setUsers] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => Promise.all([api.suppliers(), api.supplierDeliveries(filter)])
    .then(([s, d]) => { setData(s); setDeliveries(d); })
    .catch(e => toast(e.message, 'error'));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [filter]);

  const processNow = async () => {
    setBusy(true);
    try {
      const r = await api.processSuppliers();
      toast(r.length ? r.map(x => `${x.supplier}/${x.originalName}: ${x.status}`).join(' · ') : 'All inboxes are empty', r.some(x => x.status === 'rejected' || x.status === 'partial') ? 'error' : 'success');
      load();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const showReport = async d => {
    try { setReport({ title: d.originalName, text: await api.deliveryReport(d.id) }); } catch (e) { toast(e.message, 'error'); }
  };

  if (!data) return <p className="muted">Loading…</p>;
  const portalUrl = data.portal.port ? `${location.protocol}//${location.hostname}:${data.portal.port}/` : '/portal/';
  const userSupplier = users && data.suppliers.find(s => s.id === users);

  return (
    <div className="stack">
      <section className="card">
        <div className="section-head">
          <h3>Suppliers (supply chain partners)</h3>
          <div className="toolbar">
            <a className="button primary" href={portalUrl} target="_blank" rel="noreferrer">Open supplier portal</a>
            <button disabled={busy} onClick={processNow}>{busy ? 'Processing…' : 'Process inboxes now'}</button>
          </div>
        </div>
        <div className="flow">
          <div className="flow-split">
            <div className="flow-step erp"><strong>Supplier portal</strong><span className="muted small">employees upload in the browser · <code className="break">{portalUrl}</code></span></div>
            <div className="flow-step erp"><strong>FTP</strong><span className="muted small">supplier systems · {data.ftp ? <code>ftp://{data.ftp.host}:{data.ftp.port}</code> : 'off'}</span></div>
          </div>
          <div className="flow-arrow"><span>file in the supplier's format</span></div>
          <div className="flow-step"><strong>suppliers/&lt;id&gt;/inbox</strong><span className="muted small">one folder per supplier – the folder identifies the sender</span></div>
          <div className="flow-arrow"><span>mapping profile, all or nothing</span></div>
          <div className="flow-step"><strong>Translate + check</strong><span className="muted small">CSV · Excel · JSON · XML → product ID, name, price, stock</span></div>
          <div className="flow-arrow"><span>OData POST / PATCH</span></div>
          <div className="flow-step ok"><strong>SAP ERP (master)</strong><span className="muted small">{data.targets.resolved.map(id => data.targets.options.find(o => o.id === id)?.name || id).join(' + ') || 'no target – files wait'} · then the shop: API sync or ERP export file · acknowledgement to the supplier</span></div>
        </div>
      </section>

      <TargetSetting targets={data.targets} onChanged={load} />

      <div className="connector-grid">
        {data.suppliers.map(s => (
          <article key={s.id} className="connector">
            <div className="connector-head">
              <div className="connector-title">
                <strong>{s.name}</strong>
                <span className="muted small">{s.location || s.id}</span>
              </div>
              {!s.active && <span className="tag">inactive</span>}
            </div>
            <dl className="facts compact">
              <dt>Format</dt><dd>{formatSummary(s.profile)}</dd>
              <dt>Mapping</dt><dd>{Object.keys(s.profile.fields || {}).length ? Object.entries(s.profile.fields).map(([k, v]) => `${k} ← ${v}`).join(', ') : 'automatic (usual names)'}</dd>
              <dt>May update</dt><dd>{s.profile.update?.length ? s.profile.update.join(', ') : '–'}{s.profile.createProducts !== false ? ' · new products' : ''}</dd>
              <dt>Logins</dt><dd className="mono">{s.users.map(u => u.username).join(', ') || '–'}</dd>
              <dt>Inbox</dt><dd>{s.inbox.length ? `${s.inbox.length} file(s) waiting` : 'empty'}</dd>
              <dt>Last delivery</dt><dd>{s.lastDelivery ? <>{dateTime(s.lastDelivery.receivedAt)} · <span className={`tag ${STATUS_CLASS[s.lastDelivery.status] ?? ''}`}>{s.lastDelivery.status}</span></> : '–'}</dd>
            </dl>
            <div className="connector-actions">
              <button onClick={() => setEditing(s)}>Mapping profile</button>
              <button className="link" onClick={() => setUsers(s.id)}>Logins</button>
            </div>
          </article>
        ))}
      </div>

      <section className="card">
        <div className="section-head">
          <h3>Deliveries <span className="muted">({deliveries.length})</span></h3>
          <div className="chips flat">
            <button className={`chip ${filter === '' ? 'active' : ''}`} onClick={() => setFilter('')}>All</button>
            {data.suppliers.map(s => <button key={s.id} className={`chip ${filter === s.id ? 'active' : ''}`} onClick={() => setFilter(s.id)}>{s.name.split(' ')[0]}</button>)}
          </div>
        </div>
        <Deliveries rows={deliveries} suppliers={data.suppliers} onReport={showReport} />
      </section>

      {editing && <ProfileForm supplier={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {userSupplier && <UsersForm supplier={userSupplier} onClose={() => setUsers(null)} onChanged={load} />}
      {report && (
        <Modal wide title={`Acknowledgement · ${report.title}`} onClose={() => setReport(null)} footer={<button onClick={() => setReport(null)}>Close</button>}>
          <pre className="report">{report.text}</pre>
        </Modal>
      )}
    </div>
  );
}
