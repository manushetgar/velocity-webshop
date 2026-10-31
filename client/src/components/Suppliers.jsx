// Suppliers.jsx - the tab Admin > Suppliers (Lab 2 extension, header comment below).
//
// React hooks: effect (loading + timer), ref (hidden file input), state.
import { useEffect, useRef, useState } from 'react';
// API calls and date formatting.
import { api, dateTime } from '../api.js';
// Notifications.
import { useToast } from './Toast.jsx';
// Dialog window.
import Modal from './Modal.jsx';

/*
 * Admin > Suppliers (Lab 2 extension): supply chain partners deliver product data in THEIR formats,
 * through the supplier portal (separate site) or FTP. The shop translates every file with the supplier's
 * mapping profile, writes it into the SAP ERP (master) and then updates itself from the ERP.
 */

// The canonical product fields of the shop and their labels (mapping profile and preview table).
const FIELDS = [['productID', 'Product ID'], ['name', 'Name'], ['description', 'Description'], ['price', 'Price'], ['currency', 'Currency'], ['stock', 'Stock']];
// Fields a supplier may be allowed to change on existing products.
const UPDATABLE = ['name', 'description', 'price', 'stock'];
// Labels of the file formats.
const FORMAT_LABEL = { auto: 'Detect automatically', csv: 'CSV / delimited text', xlsx: 'Excel (.xlsx)', json: 'JSON', xml: 'XML' };
// Labels of the delivery channels.
const CHANNEL_LABEL = { portal: 'Portal', ftp: 'FTP', folder: 'Folder' };
// Color class per delivery / target status.
const STATUS_CLASS = { applied: 'ok', unchanged: '', rejected: 'bad', partial: 'warn', waiting: 'warn', received: 'warn', pending: 'warn' };
// Final statuses: an acknowledgement exists.
const FINAL = ['applied', 'unchanged', 'rejected', 'partial'];
// A target ERP that is done (written or nothing to write).
const done = t => t.status === 'applied' || t.status === 'unchanged';
// Labels of the connector kinds.
const KIND_LABEL = { local: 'Local', cloud: 'Cloud' };

/* Result per target ERP of a delivery, e.g. "Local SAP: 1 new, 1 updated" / "SAP BTP: waiting". */
// Props: summary.targets of a delivery ({ connectorId: { name, kind, status, created, updated, error, shop } }).
function TargetList({ targets }) {
  // [id, target] pairs.
  const list = Object.entries(targets || {});
  // No targets (e.g. rejected before the ERP step): nothing to show.
  if (!list.length) return null;
  // The labels.
  return (
    // Row of labels.
    <span className="target-list">
      {/* One label per target ERP. */}
      {list.map(([id, t]) => (
        // Label colored by status; the tooltip shows the error or how the shop got the change.
        <span key={id} className={`tag ${STATUS_CLASS[t.status] ?? ''}`} title={t.error || (t.shop ? `shop: ${t.shop}` : '')}>
          {/* ERP name and counters, or the status. */}
          {t.name}: {done(t) ? `${t.created || 0} new, ${t.updated || 0} updated` : t.status}
        </span>
      ))}
    </span>
  );
}

/* ---------- where supplier data is written (Local / Cloud / both) ---------- */
// Card 'Write supplier data to': where new supplier files are written (active connector, one connector, or all).
function TargetSetting({ targets, onChanged }) {
  // Notifications.
  const toast = useToast();
  // true while the setting is saved.
  const [busy, setBusy] = useState(false);
  // All connectors as choices ({ id, name, kind: local | cloud, active }).
  const opts = targets.options;
  // Connectors of one kind.
  const ofKind = k => opts.filter(o => o.kind === k);
  // The shop's active connector.
  const active = opts.find(o => o.active);
  // "Local" / "Cloud" if it is the only connector of its kind, otherwise its name
  // Short label of a connector.
  const label = o => (ofKind(o.kind).length === 1 ? KIND_LABEL[o.kind] : o.name);
  // The buttons: active connector, one per connector, and all (if there is more than one).
  const choices = [
    // Follow the shop's active connector.
    { key: 'active', mode: 'active', ids: [], label: 'Active connector', hint: `follows the shop · ${active?.name || 'none active'}` },
    // Exactly this connector (e.g. only Local or only Cloud).
    ...opts.map(o => ({ key: `list:${o.id}`, mode: 'list', ids: [o.id], label: label(o), hint: o.name })),
    // All connectors (Both when there is a local and a cloud one).
    ...(opts.length > 1 ? [{
      key: 'all', mode: 'all', ids: [],
      label: ofKind('local').length && ofKind('cloud').length ? 'Both (local + cloud)' : 'All connectors',
      hint: opts.map(o => o.name).join(' + '),
    }] : []),
  ];
  // Key of the current setting (a list with several ids has no button of its own).
  const current = targets.mode === 'list' ? (targets.ids.length === 1 ? `list:${targets.ids[0]}` : '') : targets.mode;
  // Names of the ERPs new files go to now.
  const names = targets.resolved.map(id => opts.find(o => o.id === id)?.name || id);

  // Saves another choice.
  const choose = async c => {
    // Already selected: nothing to do.
    if (c.key === current) return;
    // Disable the buttons.
    setBusy(true);
    try {
      // PUT /api/suppliers/targets.
      await api.setSupplierTargets({ mode: c.mode, ids: c.ids });
      // Confirmation.
      toast(`Supplier data is now written to: ${c.label}`, 'success');
      // Reload the tab (the flow diagram shows the new targets).
      onChanged();
    // Error message; enable the buttons again.
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  // The card markup.
  return (
    // Card.
    <section className="card">
      {/* Head: title and the current targets. */}
      <div className="section-head">
        {/* Title. */}
        <h3>Write supplier data to</h3>
        {/* ERPs new files go to. */}
        <span className="muted small">new files: <strong>{names.join(' + ') || 'none – files wait'}</strong></span>
      </div>
      {/* Choice buttons. */}
      <div className="target-choices">
        {/* One button per choice. */}
        {choices.map(c => (
          // Button (highlighted when selected).
          <button key={c.key} className={`target-choice ${current === c.key ? 'active' : ''}`} aria-pressed={current === c.key}
                  disabled={busy} onClick={() => choose(c)}>
            {/* Label and connector name(s). */}
            <strong>{c.label}</strong><span>{c.hint}</span>
          </button>
        ))}
      </div>
      {/* Explanations. */}
      <ul className="target-notes muted small">
        {/* What Local and Cloud mean. */}
        <li><strong>Local</strong> = the Mini-ERP on this computer (cds watch) · <strong>Cloud</strong> = the Mini-ERP on SAP BTP (HANA Cloud).</li>
        {/* How the shops receive the change. */}
        <li>This shop updates itself right away from its active connector ({active?.name || 'none'}); the cloud shop on SAP BTP picks up changes in SAP BTP with its own ERP sync (every 60 s).</li>
        {/* Behavior of Both when one ERP is down. */}
        <li>Both: if one ERP is not reachable, the other one is written at once and the file waits only for the missing one – it is completed automatically. A file keeps the systems it started with.</li>
      </ul>
    </section>
  );
}

// Short description of a mapping profile's format, e.g. 'CSV / delimited text · separator ; · decimal comma'.
function formatSummary(p) {
  // Format label.
  const parts = [FORMAT_LABEL[p.format] || p.format];
  // Separator (TAB written out).
  if (p.delimiter) parts.push(`separator ${p.delimiter === '\t' || p.delimiter === '\\t' ? 'TAB' : p.delimiter}`);
  // Decimal comma.
  if (p.decimal === ',') parts.push('decimal comma');
  // JSON path or XML element of the product list.
  if (p.recordPath) parts.push(`${p.format === 'xml' ? 'element' : 'path'} ${p.recordPath}`);
  // Joined with dots.
  return parts.join(' · ');
}

/* ---------- profile editor with file preview ---------- */
// Dialog for a supplier's master data and mapping profile, with a test of the profile against a file.
function ProfileForm({ supplier, onClose, onSaved }) {
  // Notifications.
  const toast = useToast();
  // Form values: name, location, active flag and the profile (defaults for missing profile settings).
  const [form, setForm] = useState({
    // Master data.
    name: supplier.name, location: supplier.location || '', active: supplier.active,
    // Profile with defaults.
    profile: { format: 'auto', delimiter: '', decimal: 'auto', recordPath: '', defaultCurrency: 'EUR', fields: {}, update: [...UPDATABLE], createProducts: true, ...supplier.profile },
  });
  // Result of the last file test.
  const [preview, setPreview] = useState(null);
  // Which button is running.
  const [busy, setBusy] = useState('');
  // Error message of saving.
  const [error, setError] = useState('');
  // Hidden file input for the test.
  const fileInput = useRef(null);
  // Changes one profile setting.
  const setP = (k, v) => setForm(f => ({ ...f, profile: { ...f.profile, [k]: v } }));
  // Changes the agreed field name of one canonical field.
  const setField = (k, v) => setForm(f => ({ ...f, profile: { ...f.profile, fields: { ...f.profile.fields, [k]: v } } }));
  // Adds or removes a field from the 'may update' rights.
  const toggleUpdate = k => setP('update', form.profile.update.includes(k) ? form.profile.update.filter(x => x !== k) : [...form.profile.update, k]);

  // Tests the (unsaved) profile with a file: shows how it is read, nothing is imported.
  const runPreview = async e => {
    // The chosen file.
    const file = e.target.files[0];
    // The same file can be chosen again.
    e.target.value = '';
    // Dialog cancelled.
    if (!file) return;
    // Test button busy.
    setBusy('preview');
    // POST /api/suppliers/:id/preview with the profile of the form.
    try { setPreview({ name: file.name, ...(await api.previewSupplierFile(supplier.id, file, form.profile)) }); } catch (err) { toast(err.message, 'error'); }
    // Not busy any more.
    finally { setBusy(''); }
  };
  // Saves the supplier.
  const save = async () => {
    // Save button busy.
    setBusy('save');
    // Clear the old error.
    setError('');
    try {
      // PUT /api/suppliers/:id.
      await api.updateSupplier(supplier.id, form);
      // Confirmation.
      toast(`${form.name} saved`, 'success');
      // Tell the parent (closes the dialog, reloads the tab).
      onSaved();
    // Error in the dialog; not busy any more.
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  };
  // Short name for the profile.
  const p = form.profile;

  // The dialog markup.
  return (
    // Wide dialog; footer with test, cancel and save.
    <Modal wide title={`Mapping profile · ${supplier.name}`} onClose={onClose}
           footer={<>
             {/* Test with a file. */}
             <button disabled={!!busy} onClick={() => fileInput.current.click()}>{busy === 'preview' ? 'Reading…' : 'Test with a file…'}</button>
             {/* Hidden file input (all supported formats). */}
             <input ref={fileInput} type="file" hidden accept=".csv,.txt,.tsv,.xlsx,.json,.ndjson,.xml" onChange={runPreview} />
             {/* Space. */}
             <span className="spacer" />
             {/* Cancel. */}
             <button onClick={onClose}>Cancel</button>
             {/* Save. */}
             <button className="primary" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
           </>}>
      {/* Master data and format settings. */}
      <div className="form-grid">
        {/* Name. */}
        <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        {/* Location. */}
        <label>Location<input value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} /></label>
        {/* File format. */}
        <label>File format
          {/* Select box. */}
          <select value={p.format} onChange={e => setP('format', e.target.value)}>
            {/* One option per format. */}
            {Object.entries(FORMAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {/* Decimal sign. */}
        <label>Decimal sign
          {/* Select box. */}
          <select value={p.decimal} onChange={e => setP('decimal', e.target.value)}>
            {/* Detect, point or comma. */}
            <option value="auto">Detect (12.90 or 12,90)</option><option value=".">Point – 1,299.90</option><option value=",">Comma – 1.299,90</option>
          </select>
        </label>
        {/* Separator of delimited text. */}
        <label>Separator (CSV)
          {/* Select box. */}
          <select value={p.delimiter} onChange={e => setP('delimiter', e.target.value)}>
            {/* Detect, comma, semicolon, TAB or pipe. */}
            <option value="">Detect</option><option value=",">,</option><option value=";">;</option><option value="\t">TAB</option><option value="|">|</option>
          </select>
        </label>
        {/* Where the product list is in JSON / XML. */}
        <label>Product list (JSON path / XML element)<input value={p.recordPath} placeholder="detect, e.g. data.items or Article" onChange={e => setP('recordPath', e.target.value)} /></label>
      </div>

      {/* Field mapping. */}
      <h4 className="subhead">Field mapping <span className="muted small">– empty = detected from usual names (SKU, Part Number, Artikelnummer, …)</span></h4>
      {/* One input per canonical field. */}
      <div className="mapping-grid">
        {/* Field label and the supplier's field name (empty = detected). */}
        {FIELDS.map(([k, label]) => (
          // One field.
          <label key={k}><span>{label} <span className="muted">←</span></span>
            {/* Supplier's field name. */}
            <input value={p.fields[k] || ''} placeholder="auto" onChange={e => setField(k, e.target.value)} className="mono" />
          </label>
        ))}
      </div>

      {/* Rights. */}
      <h4 className="subhead">Rights</h4>
      {/* Fields the supplier may change. */}
      <div className="check-row">
        {/* Label. */}
        <span className="muted small">May update:</span>
        {/* One checkbox per field. */}
        {UPDATABLE.map(k => (
          // One checkbox.
          <label key={k} className="check"><input type="checkbox" checked={p.update.includes(k)} onChange={() => toggleUpdate(k)} /> {k}</label>
        ))}
      </div>
      {/* Other rights. */}
      <div className="check-row">
        {/* May create new products. */}
        <label className="check"><input type="checkbox" checked={p.createProducts} onChange={e => setP('createProducts', e.target.checked)} /> May create new products</label>
        {/* Active (portal and FTP login allowed). */}
        <label className="check"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /> Active (portal + FTP login allowed)</label>
      </div>

      {/* Result of the file test. */}
      {preview && (
        // Preview box.
        <div className="preview">
          {/* Title with the file name. */}
          <h4 className="subhead">Test: {preview.name}</h4>
          {/* How the file was read: format, encoding/separator and number of records. */}
          {preview.format && <p className="small muted">{FORMAT_LABEL[preview.format]} · {Object.entries(preview.info || {}).map(([k, v]) => `${k} ${v}`).join(' · ')} · {preview.records} record(s)</p>}
          {/* The supplier's field names (used ones highlighted). */}
          {preview.fields && (
            // Field list.
            <p className="small"><span className="muted">Fields in the file:</span> {preview.fields.map(f => (
              <code key={f} className={Object.values(preview.mapping || {}).includes(f) ? 'used' : ''}>{f}</code>))}</p>
          )}
          {/* The first products as the shop understands them. */}
          {preview.mapping && (
            // Scrollable table.
            <div className="table-wrap">
              {/* Table. */}
              <table className="table compact">
                {/* Column per canonical field with the supplier field it comes from. */}
                <thead><tr>{FIELDS.map(([k, l]) => <th key={k}>{l}<br /><span className="mono muted">{preview.mapping[k] || '–'}</span></th>)}</tr></thead>
                {/* Rows. */}
                <tbody>
                  {/* First five products. */}
                  {(preview.products || []).slice(0, 5).map((r, i) => (
                    // One row.
                    <tr key={i}>{FIELDS.map(([k]) => <td key={k}>{r[k] ?? <span className="muted">–</span>}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {/* Problems, or the confirmation that the file can be read. */}
          {preview.errors?.length > 0
            ? <ul className="error small">{preview.errors.slice(0, 10).map((e, i) => <li key={i}>{e}</li>)}</ul>
            : <p className="test-result ok">The file can be read with this profile – nothing has been imported.</p>}
        </div>
      )}
      {/* Error message of saving. */}
      {error && <p className="error small">{error}</p>}
    </Modal>
  );
}

/* ---------- logins (portal + FTP) ---------- */
// Dialog for the logins of a supplier (the same login works for the portal and for FTP).
function UsersForm({ supplier, onClose, onChanged }) {
  // Notifications.
  const toast = useToast();
  // Fields of a new login.
  const [form, setForm] = useState({ username: '', name: '', password: '' });
  // Error message.
  const [error, setError] = useState('');
  // Adds a login.
  const add = async () => {
    // Clear the old error.
    setError('');
    try {
      // POST /api/suppliers/:id/users.
      await api.createSupplierUser(supplier.id, form);
      // Confirmation.
      toast(`Login ${form.username} created`, 'success');
      // Clear the fields.
      setForm({ username: '', name: '', password: '' });
      // Reload the tab (the dialog shows the new login).
      onChanged();
    // Error (e.g. username taken, password too short).
    } catch (e) { setError(e.message); }
  };
  // Sets a new password.
  const reset = async u => {
    // Ask for the password.
    const pw = prompt(`New password for ${u.username} (min. 8 characters):`);
    // Cancelled.
    if (!pw) return;
    // PUT /api/suppliers/users/:id/password.
    try { await api.resetSupplierPassword(u.id, pw); toast(`Password of ${u.username} changed`, 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  // Deletes a login.
  const remove = async u => {
    // Ask first.
    if (!confirm(`Delete the login ${u.username}?`)) return;
    // DELETE /api/suppliers/users/:id.
    try { await api.deleteSupplierUser(u.id); toast(`${u.username} deleted`, 'info'); onChanged(); } catch (e) { toast(e.message, 'error'); }
  };
  // The dialog markup.
  return (
    // Dialog with a close button.
    <Modal title={`Logins · ${supplier.name}`} onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      {/* Hint. */}
      <p className="muted small">The same login works for the supplier portal and for FTP.</p>
      {/* Existing logins. */}
      <ul className="simple-list">
        {/* One line per login. */}
        {supplier.users.map(u => (
          // One login.
          <li key={u.id}>
            {/* Username and employee name. */}
            <span><strong className="mono">{u.username}</strong> <span className="muted small">{u.name}</span></span>
            {/* New password and delete. */}
            <span className="nowrap"><button className="link" onClick={() => reset(u)}>New password</button><button className="link danger" onClick={() => remove(u)}>Delete</button></span>
          </li>
        ))}
      </ul>
      {/* New login. */}
      <div className="form-grid three">
        {/* Username. */}
        <label>Username<input value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} autoComplete="off" /></label>
        {/* Employee name. */}
        <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        {/* Password. */}
        <label>Password<input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></label>
      </div>
      {/* Error message. */}
      {error && <p className="error small">{error}</p>}
      {/* Add the login. */}
      <button className="primary" onClick={add} disabled={!form.username || !form.password}>Add login</button>
    </Modal>
  );
}

/* ---------- deliveries ---------- */
// Delivery table: every file a supplier delivered, with status, result, details and acknowledgement.
function Deliveries({ rows, suppliers, onReport }) {
  // Row whose details are open.
  const [open, setOpen] = useState(null);
  // Supplier names by id.
  const names = Object.fromEntries(suppliers.map(s => [s.id, s.name]));
  // Nothing yet.
  if (!rows.length) return <p className="muted small">No deliveries yet – upload a file in the supplier portal or by FTP.</p>;
  // The table markup.
  return (
    // Scrollable table.
    <div className="table-wrap">
      {/* Table. */}
      <table className="table transfer-log">
        {/* Column titles. */}
        <thead><tr><th>Received</th><th>Supplier</th><th>File</th><th>Status</th><th>Result</th></tr></thead>
        {/* Rows. */}
        <tbody>
          {/* One row per delivery. */}
          {rows.map(d => {
            // Summary of the processing.
            const s = d.summary || {};
            // Target ERPs of the delivery.
            const targets = Object.values(s.targets || {});
            // Written to more than one ERP.
            const multi = targets.length > 1;
            // How the shop received the change (single target).
            const shop = s.shop || targets[0]?.shop;
            // Details exist (errors, remarks, changes, shop notes).
            const details = d.errors.length || d.warnings.length || s.changes?.length || (multi && targets.some(t => t.shop));
            // The row.
            return (
              // Row.
              <tr key={d.id}>
                {/* Received. */}
                <td className="nowrap">{dateTime(d.receivedAt)}</td>
                {/* Supplier, channel and user. */}
                <td>{names[d.supplierId] || d.supplierId}<span className="source-note">{CHANNEL_LABEL[d.channel]}{d.username ? ` · ${d.username}` : ''}</span></td>
                {/* Original file name and format. */}
                <td className="file-cell"><span className="break">{d.originalName}</span>{d.format && <span className="source-note">{d.format.toUpperCase()}</span>}</td>
                {/* Status. */}
                <td><span className={`tag ${STATUS_CLASS[d.status] ?? ''}`}>{d.status}</span></td>
                {/* Result. */}
                <td>
                  {/* Applied: counters (per ERP below when there are several); rejected / partial: problems; waiting: the reason. */}
                  {d.status === 'applied' || d.status === 'unchanged'
                    ? (multi
                      ? <>{d.rows} product{d.rows === 1 ? '' : 's'} in {targets.length} ERPs</>
                      : <>{d.rows} product{d.rows === 1 ? '' : 's'}: {s.created} new, {s.updated} updated in {targets[0]?.name || 'the ERP'}{shop && <span className="source-note">shop via {shop}</span>}</>)
                    : d.status === 'rejected' ? <span className="error">{d.errors.length} problem(s) – nothing changed</span>
                      : d.status === 'partial' ? <span className="error">partly applied – {d.errors.length} problem(s)</span>
                        : <span className="muted">{d.errors[0] || 'being processed…'}</span>}
                  {/* Per-target labels (several ERPs, or partly applied). */}
                  {(multi || d.status === 'partial') && d.status !== 'rejected' && <TargetList targets={s.targets} />}
                  {/* Buttons. */}
                  <span className="nowrap">
                    {/* Show or hide the details. */}
                    {details ? <button className="link small" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? 'hide' : 'details'}</button> : null}
                    {/* Open the acknowledgement (final statuses only). */}
                    {FINAL.includes(d.status) && <button className="link small" onClick={() => onReport(d)}>acknowledgement</button>}
                  </span>
                  {/* The details, if open. */}
                  {open === d.id && (
                    // Details box.
                    <div className="transfer-details">
                      {/* Problems. */}
                      {d.errors.length > 0 && <ul className="error">{d.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
                      {/* Changes written to the ERP. */}
                      {s.changes?.length > 0 && <ul>{s.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                      {/* Several ERPs: how each shop got the change. */}
                      {multi && <ul className="muted">{targets.filter(t => t.shop).map((t, i) => <li key={i}>{t.name} → shop: {t.shop}</li>)}</ul>}
                      {/* Remarks. */}
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

/* ---------- tab ---------- */
// The suppliers tab.
export default function Suppliers() {
  // Notifications.
  const toast = useToast();
  // Suppliers, channels and target setting (GET /api/suppliers).
  const [data, setData] = useState(null);
  // Deliveries.
  const [deliveries, setDeliveries] = useState([]);
  // Supplier filter of the deliveries ('' = all).
  const [filter, setFilter] = useState('');
  // Supplier in the profile dialog.
  const [editing, setEditing] = useState(null);
  // Supplier id in the logins dialog.
  const [users, setUsers] = useState(null);
  // Acknowledgement shown in the report dialog.
  const [report, setReport] = useState(null);
  // true while 'Process inboxes now' runs.
  const [busy, setBusy] = useState(false);

  // Loads suppliers and deliveries in parallel.
  const load = () => Promise.all([api.suppliers(), api.supplierDeliveries(filter)])
    // Store both.
    .then(([s, d]) => { setData(s); setDeliveries(d); })
    // Error message.
    .catch(e => toast(e.message, 'error'));
  // Load now and every 5 seconds; again when the filter changes.
  useEffect(() => {
    // Now.
    load();
    const t = setInterval(load, 5000); // new deliveries appear without reloading
    // Cleanup: stop the timer.
    return () => clearInterval(t);
  }, [filter]);

  // Processes all supplier inboxes now (also retries waiting files).
  const processNow = async () => {
    // Button busy.
    setBusy(true);
    try {
      // POST /api/suppliers/process.
      const r = await api.processSuppliers();
      // One part per processed file; error color if a file was rejected or partly applied.
      toast(r.length ? r.map(x => `${x.supplier}/${x.originalName}: ${x.status}`).join(' · ') : 'All inboxes are empty', r.some(x => x.status === 'rejected' || x.status === 'partial') ? 'error' : 'success');
      // Reload.
      load();
    // Error message; not busy any more.
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  // Opens the acknowledgement of a delivery.
  const showReport = async d => {
    // GET the report text and show it in the dialog.
    try { setReport({ title: d.originalName, text: await api.deliveryReport(d.id) }); } catch (e) { toast(e.message, 'error'); }
  };

  // Still loading.
  if (!data) return <p className="muted">Loading…</p>;
  // Address of the portal: its own port, or /portal/ of the shop (e.g. on SAP BTP).
  const portalUrl = data.portal.port ? `${location.protocol}//${location.hostname}:${data.portal.port}/` : '/portal/';
  // Supplier of the logins dialog.
  const userSupplier = users && data.suppliers.find(s => s.id === users);

  // The tab markup.
  return (
    // Vertical stack.
    <div className="stack">
      {/* Head card with the flow diagram. */}
      <section className="card">
        {/* Head. */}
        <div className="section-head">
          {/* Title. */}
          <h3>Suppliers (supply chain partners)</h3>
          {/* Buttons. */}
          <div className="toolbar">
            {/* Open the portal in a new tab. */}
            <a className="button primary" href={portalUrl} target="_blank" rel="noreferrer">Open supplier portal</a>
            {/* Process inboxes now. */}
            <button disabled={busy} onClick={processNow}>{busy ? 'Processing…' : 'Process inboxes now'}</button>
          </div>
        </div>
        {/* Flow diagram. */}
        <div className="flow">
          {/* The two channels. */}
          <div className="flow-split">
            {/* Portal and its address. */}
            <div className="flow-step erp"><strong>Supplier portal</strong><span className="muted small">employees upload in the browser · <code className="break">{portalUrl}</code></span></div>
            {/* FTP and its address. */}
            <div className="flow-step erp"><strong>FTP</strong><span className="muted small">supplier systems · {data.ftp ? <code>ftp://{data.ftp.host}:{data.ftp.port}</code> : 'off'}</span></div>
          </div>
          {/* Arrow. */}
          <div className="flow-arrow"><span>file in the supplier's format</span></div>
          {/* Inbox folder per supplier. */}
          <div className="flow-step"><strong>suppliers/&lt;id&gt;/inbox</strong><span className="muted small">one folder per supplier – the folder identifies the sender</span></div>
          {/* Arrow. */}
          <div className="flow-arrow"><span>mapping profile, all or nothing</span></div>
          {/* Translation and checks. */}
          <div className="flow-step"><strong>Translate + check</strong><span className="muted small">CSV · Excel · JSON · XML → product ID, name, price, stock</span></div>
          {/* Arrow. */}
          <div className="flow-arrow"><span>OData POST / PATCH</span></div>
          {/* Target ERPs, then the shop and the acknowledgement. */}
          <div className="flow-step ok"><strong>SAP ERP (master)</strong><span className="muted small">{data.targets.resolved.map(id => data.targets.options.find(o => o.id === id)?.name || id).join(' + ') || 'no target – files wait'} · then the shop: API sync or ERP export file · acknowledgement to the supplier</span></div>
        </div>
      </section>

      {/* Where supplier data is written. */}
      <TargetSetting targets={data.targets} onChanged={load} />

      {/* Supplier cards. */}
      <div className="connector-grid">
        {/* One card per supplier. */}
        {data.suppliers.map(s => (
          // Card.
          <article key={s.id} className="connector">
            {/* Head. */}
            <div className="connector-head">
              {/* Name and location. */}
              <div className="connector-title">
                {/* Name. */}
                <strong>{s.name}</strong>
                {/* Location. */}
                <span className="muted small">{s.location || s.id}</span>
              </div>
              {/* Inactive label. */}
              {!s.active && <span className="tag">inactive</span>}
            </div>
            {/* Facts. */}
            <dl className="facts compact">
              {/* Format. */}
              <dt>Format</dt><dd>{formatSummary(s.profile)}</dd>
              {/* Agreed field names or automatic. */}
              <dt>Mapping</dt><dd>{Object.keys(s.profile.fields || {}).length ? Object.entries(s.profile.fields).map(([k, v]) => `${k} ← ${v}`).join(', ') : 'automatic (usual names)'}</dd>
              {/* Rights. */}
              <dt>May update</dt><dd>{s.profile.update?.length ? s.profile.update.join(', ') : '–'}{s.profile.createProducts !== false ? ' · new products' : ''}</dd>
              {/* Logins. */}
              <dt>Logins</dt><dd className="mono">{s.users.map(u => u.username).join(', ') || '–'}</dd>
              {/* Files waiting in the inbox. */}
              <dt>Inbox</dt><dd>{s.inbox.length ? `${s.inbox.length} file(s) waiting` : 'empty'}</dd>
              {/* Last delivery and its status. */}
              <dt>Last delivery</dt><dd>{s.lastDelivery ? <>{dateTime(s.lastDelivery.receivedAt)} · <span className={`tag ${STATUS_CLASS[s.lastDelivery.status] ?? ''}`}>{s.lastDelivery.status}</span></> : '–'}</dd>
            </dl>
            {/* Buttons. */}
            <div className="connector-actions">
              {/* Mapping profile dialog. */}
              <button onClick={() => setEditing(s)}>Mapping profile</button>
              {/* Logins dialog. */}
              <button className="link" onClick={() => setUsers(s.id)}>Logins</button>
            </div>
          </article>
        ))}
      </div>

      {/* Deliveries. */}
      <section className="card">
        {/* Head. */}
        <div className="section-head">
          {/* Title with the number of rows. */}
          <h3>Deliveries <span className="muted">({deliveries.length})</span></h3>
          {/* Supplier filter. */}
          <div className="chips flat">
            {/* All suppliers. */}
            <button className={`chip ${filter === '' ? 'active' : ''}`} onClick={() => setFilter('')}>All</button>
            {/* One chip per supplier (first word of the name). */}
            {data.suppliers.map(s => <button key={s.id} className={`chip ${filter === s.id ? 'active' : ''}`} onClick={() => setFilter(s.id)}>{s.name.split(' ')[0]}</button>)}
          </div>
        </div>
        {/* Delivery table. */}
        <Deliveries rows={deliveries} suppliers={data.suppliers} onReport={showReport} />
      </section>

      {/* Profile dialog, if open. */}
      {editing && <ProfileForm supplier={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {/* Logins dialog, if open. */}
      {userSupplier && <UsersForm supplier={userSupplier} onClose={() => setUsers(null)} onChanged={load} />}
      {/* Acknowledgement dialog, if open. */}
      {report && (
        // Wide dialog with a close button.
        <Modal wide title={`Acknowledgement · ${report.title}`} onClose={() => setReport(null)} footer={<button onClick={() => setReport(null)}>Close</button>}>
          {/* The report text as it was sent to the supplier. */}
          <pre className="report">{report.text}</pre>
        </Modal>
      )}
    </div>
  );
}
