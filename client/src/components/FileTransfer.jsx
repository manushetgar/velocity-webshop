// FileTransfer.jsx - the tab Admin > File transfer (Lab 2, header comment below).
//
// React hooks: effect (loading + timer), ref (hidden file input), state.
import { useEffect, useRef, useState } from 'react';
// Router link.
import { Link } from 'react-router-dom';
// API calls and date formatting.
import { api, dateTime } from '../api.js';
// Notifications.
import { useToast } from './Toast.jsx';
// Icon.
import { DatabaseIcon } from './Icons.jsx';

/*
 * Admin > File transfer (Lab 2): product master data travels from the Mini-ERP to the shop as files.
 * ERP export job -> transfer/inbox -> import (validation) -> processed/ or error/.
 * The page refreshes itself every few seconds, so the inbox poller can be watched at work.
 */

// File size as B or KB.
const kb = bytes => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

// One line describing the import result of a file.
function importText(r) {
  // Rejected: the first problem (+ how many more).
  if (r.status === 'rejected') return `rejected – ${r.errors[0]}${r.errors.length > 1 ? ` (+${r.errors.length - 1} more)` : ''}`;
  // Same data as before.
  if (r.status === 'unchanged') return `${r.rows} products, no changes`;
  // Not imported yet.
  if (r.status === 'pending') return 'waiting in the inbox';
  // Imported: counters.
  return `${r.rows} products: ${r.created} new, ${r.updated} updated, ${r.unlinked} removed`;
}

// One line describing the export step of a transfer run.
function exportText(e) {
  // No export in this run.
  if (!e) return '';
  // A new file was written.
  if (e.written) return `export ${e.file} (${e.rows} products)`;
  // No new file (data unchanged) or the error.
  return e.ok ? 'ERP data unchanged, no new file' : `export failed: ${e.error}`;
}

// Color of the status labels.
const STATUS_CLASS = { written: 'ok', imported: 'ok', unchanged: '', rejected: 'bad', failed: 'bad' };

// Status label of a history row.
function StatusTag({ status }) {
  // Label with the color class.
  return <span className={`tag ${STATUS_CLASS[status] ?? ''}`}>{status}</span>;
}

/* ---------- history (file_transfer_log) ---------- */
// History table of exports and imports, with details and downloads.
function History({ rows, onDownload }) {
  // Row whose details are open.
  const [open, setOpen] = useState(null);
  // Nothing yet.
  if (!rows.length) return <p className="muted small">No transfers yet.</p>;
  // The table markup.
  return (
    // Scrollable table.
    <div className="table-wrap">
      {/* Table. */}
      <table className="table transfer-log">
        {/* Column titles. */}
        <thead><tr><th>Time</th><th>Step</th><th>File</th><th>Status</th><th>Result</th></tr></thead>
        {/* Rows. */}
        <tbody>
          {/* One row per export or import. */}
          {rows.map(h => {
            // Summary of the entry (JSON from the server).
            const s = h.summary || {};
            // Folder of an imported file (processed or error), for the download.
            const folder = h.direction === 'export' ? null : (s.movedTo || '').split('/')[0];
            // Errors or remarks exist.
            const details = h.errors.length > 0 || s.warnings?.length > 0;
            // The row.
            return (
              // Row.
              <tr key={h.id}>
                {/* Time. */}
                <td className="nowrap">{dateTime(h.at)}</td>
                {/* Step: ERP export or shop import. */}
                <td>{h.direction === 'export' ? 'ERP export' : 'Shop import'}</td>
                {/* File name. */}
                <td className="file-cell">
                  {/* Imported files can be downloaded; exports only show the name. */}
                  {h.file ? (
                    // Download button (from processed/ or error/), or the plain name.
                    folder ? <button className="link mono" title={`Download from ${s.movedTo}`} onClick={() => onDownload(folder, s.movedTo.split('/')[1])}>{h.file}</button>
                      : <span className="mono">{h.file}</span>
                  ) : <span className="muted">–</span>}
                  {/* Original name of an uploaded file. */}
                  {s.originalName && <span className="source-note">uploaded as {s.originalName}</span>}
                </td>
                {/* Status. */}
                <td><StatusTag status={h.status} /></td>
                {/* Result. */}
                <td>
                  {/* Export: products, size and trigger, or the error; import: rejected or the counters. */}
                  {h.direction === 'export'
                    ? (h.status === 'written' ? `${h.rows} products · ${kb(s.bytes || 0)} · ${s.trigger}` : h.errors[0])
                    : h.status === 'rejected'
                      ? <span className="error">{h.errors.length} problem(s) – not imported</span>
                      : `${h.rows} products: ${s.created} new, ${s.updated} updated, ${s.unlinked} removed`}
                  {/* Button to show the problems / remarks. */}
                  {details && (
                    // Toggle button.
                    <button className="link small" onClick={() => setOpen(open === h.id ? null : h.id)}>
                      {/* Button text. */}
                      {open === h.id ? 'hide' : h.errors.length ? 'show problems' : 'show remarks'}
                    </button>
                  )}
                  {/* The details, if open. */}
                  {open === h.id && (
                    // Details box.
                    <div className="transfer-details">
                      {/* Problems. */}
                      {h.errors.length > 0 && <ul className="error">{h.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
                      {/* Remarks. */}
                      {s.warnings?.length > 0 && <ul className="muted">{s.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                      {/* Rejected files: download the error report. */}
                      {h.status === 'rejected' && folder === 'error' && (
                        // Download button.
                        <button className="link small" onClick={() => onDownload('error', `${s.movedTo.split('/')[1]}.error.txt`)}>Download error report</button>
                      )}
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
// The file transfer tab.
export default function FileTransfer() {
  // Notifications.
  const toast = useToast();
  // State from GET /api/erp/files (null while loading).
  const [s, setS] = useState(null);
  // Which button is running.
  const [busy, setBusy] = useState('');
  // Hidden file input for the upload.
  const fileInput = useRef(null);

  // Loads the state.
  const load = () => api.fileTransfer().then(setS).catch(e => toast(e.message, 'error'));
  // Load now and every 4 seconds.
  useEffect(() => {
    // Now.
    load();
    const timer = setInterval(load, 4000); // shows the inbox poller importing new files
    // Cleanup: stop the timer when the tab closes.
    return () => clearInterval(timer);
  }, []);

  // Runs an action: busy flag, error toast, reload afterwards.
  const run = async (key, fn) => {
    // Button busy.
    setBusy(key);
    try {
      // Run the action.
      await fn();
    } catch (e) {
      // Error message.
      toast(e.message, 'error');
    } finally {
      // Not busy any more.
      setBusy('');
      // Reload the state.
      load();
      window.dispatchEvent(new Event('sap-connector-changed')); // refreshes the connection chip in the admin header
    }
  };

  // Switches the active connector between API and file transfer.
  const switchMode = integration => run('mode', async () => {
    // POST /api/erp/files/mode.
    const r = await api.setIntegration(integration);
    // Switched, but the first run failed.
    if (!r.sync.ok) return toast(`Switched, but the first run failed: ${r.sync.error}`, 'error');
    // File transfer: describe the first export and import.
    if (integration === 'file') {
      // The last import of the first run.
      const last = r.sync.imports?.at(-1);
      // Message.
      toast(`File transfer on · ${exportText(r.sync.export)}${last ? ` · ${importText(last)}` : ''}`, last?.status === 'rejected' ? 'error' : 'success');
    } else {
      // API: number of synced products.
      toast(`API integration on · ${r.sync.products.received} products synced live from the ERP`, 'success');
    }
  });
  // Writes an ERP export file now.
  const exportNow = () => run('export', async () => {
    // POST /api/erp/files/export.
    const r = await api.fileExport();
    // Message.
    toast(`Export file written: ${r.file} (${r.rows} products)`, 'success');
  });
  // Imports the inbox now.
  const importNow = () => run('import', async () => {
    // POST /api/erp/files/import.
    const r = await api.fileImport();
    // Nothing in the inbox.
    if (!r.length) return toast('The inbox is empty – nothing to import', 'info');
    // One part per file.
    toast(r.map(x => `${x.file}: ${importText(x)}`).join(' · '), r.some(x => x.status === 'rejected') ? 'error' : 'success');
  });
  // Uploads a file chosen in the hidden file input.
  const upload = e => {
    // The chosen file.
    const file = e.target.files[0];
    e.target.value = ''; // the same file can be chosen again
    // Dialog cancelled.
    if (!file) return;
    // Upload and import.
    run('upload', async () => {
      // POST /api/erp/files/upload.
      const r = await api.fileUpload(file);
      // Result message.
      toast(`${file.name}: ${importText(r)}`, r.status === 'rejected' ? 'error' : 'success');
    });
  };
  // Downloads a file of a transfer folder.
  const download = (folder, name) => api.fileDownload(folder, name).catch(e => toast(e.message, 'error'));

  // Still loading.
  if (!s) return <p className="muted">Loading…</p>;
  // The active connector.
  const conn = s.connector;
  // It uses file transfer.
  const fileMode = conn?.integration === 'file';
  // Newest export entry.
  const lastExport = s.lastExport;
  // Newest import entry.
  const lastImport = s.lastImport;

  // The tab markup.
  return (
    // Vertical stack.
    <div className="stack">
      {/* Status card. */}
      <section className={`card erp-status ${fileMode ? 'on' : 'off'}`}>
        {/* Head: title and mode switch. */}
        <div className="section-head">
          {/* Title with a dot (red when the last export failed) and the connector name. */}
          <h3><span className={`dot ${fileMode ? (lastExport?.status === 'failed' ? 'bad' : 'good') : 'idle'}`} />
            File transfer (Lab 2){conn ? ` · ${conn.name}` : ''}</h3>
          {/* Mode switch (only with a connector). */}
          {conn && (
            // Two buttons.
            <div className="segmented" role="group" aria-label="How product data reaches the shop">
              {/* API mode. */}
              <button className={!fileMode ? 'active' : ''} disabled={!!busy} onClick={() => fileMode && switchMode('api')}>API (live)</button>
              {/* File transfer mode. */}
              <button className={fileMode ? 'active' : ''} disabled={!!busy} onClick={() => !fileMode && switchMode('file')}>
                {/* Button text. */}
                {busy === 'mode' ? 'Switching…' : 'File transfer'}
              </button>
            </div>
          )}
        </div>
        {/* Explanation of the current mode. */}
        {!conn ? (
          // No connector.
          <p className="muted small">No SAP connector is active. Choose an ERP in <Link to="/admin/connectors">SAP connectors</Link> first.</p>
        ) : fileMode ? (
          // File transfer text.
          <p className="muted small">
            {/* Explanation. */}
            The shop does not call the ERP to read products. The ERP's export job writes its product list as a file into the
            transfer folder, and the shop imports it from there. Orders stay in the shop (like Lab 1): the shop reduces its own
            stock, the next file brings the ERP's stock again.
          </p>
        ) : (
          // API text.
          <p className="muted small">
            {/* Explanation. */}
            {conn.name} is connected through its API (REST/OData): products are read live and every checkout creates an order in
            the ERP. Switch to <strong>File transfer</strong> to exchange the product data with files instead.
          </p>
        )}
        {/* The last export failed. */}
        {fileMode && lastExport?.status === 'failed' && (
          // Error line.
          <p className="test-result bad">Last export failed ({dateTime(lastExport.at)}): {lastExport.errors[0]}. The shop keeps the products of the last imported file.</p>
        )}
      </section>

      {/* How the files travel. */}
      <section className="card">
        {/* Title. */}
        <h3>How the files travel</h3>
        {/* Flow diagram. */}
        <div className="flow">
          {/* Step 1: ERP export. */}
          <div className="flow-step erp">
            {/* Icon. */}
            <span className="connector-icon"><DatabaseIcon /></span>
            {/* Title. */}
            <strong>SAP ERP – export job</strong>
            {/* ERP and the export endpoint. */}
            <span className="muted small">{conn?.name || 'no ERP'} · <code>GET /rest/api/getProducts()</code> (CSV)</span>
          </div>
          {/* Arrow: when files are written. */}
          <div className="flow-arrow"><span>every {s.exportIntervalS} s if the ERP data changed, or “Export now”</span></div>
          {/* Step 2: inbox. */}
          <div className="flow-step">
            {/* Folder. */}
            <strong>inbox/</strong>
            {/* Files waiting. */}
            <span className="kpi-value">{s.inbox.length}</span>
            {/* Label. */}
            <span className="muted small">file(s) waiting</span>
          </div>
          {/* Arrow: poll interval. */}
          <div className="flow-arrow"><span>checked every {s.pollIntervalS} s</span></div>
          {/* Step 3: import. */}
          <div className="flow-step">
            {/* Title. */}
            <strong>Shop import</strong>
            {/* What is checked. */}
            <span className="muted small">checks name, format and every line – all or nothing</span>
          </div>
          {/* Step 4: processed or error. */}
          <div className="flow-split">
            {/* Processed files. */}
            <div className="flow-step ok"><strong>processed/</strong><span className="kpi-value">{s.counts.processed}</span><span className="muted small">imported</span></div>
            {/* Rejected files. */}
            <div className="flow-step bad"><strong>error/</strong><span className="kpi-value">{s.counts.error}</span><span className="muted small">rejected (+ report)</span></div>
          </div>
        </div>
        {/* Folder on the server. */}
        <p className="muted small">Folder on the server: <code className="break">{s.dir}</code></p>
      </section>

      {/* Manual actions. */}
      <section className="card">
        {/* Head. */}
        <div className="section-head">
          {/* Title. */}
          <h3>Transfer now</h3>
          {/* Buttons. */}
          <div className="toolbar">
            {/* Export now. */}
            <button className="primary" disabled={!conn || !!busy} onClick={exportNow}>{busy === 'export' ? 'Exporting…' : 'Export from ERP now'}</button>
            {/* Import now (file mode only). */}
            <button disabled={!fileMode || !!busy} onClick={importNow}>{busy === 'import' ? 'Importing…' : 'Import inbox now'}</button>
            {/* Upload (opens the hidden file input). */}
            <button disabled={!fileMode || !!busy} onClick={() => fileInput.current.click()}>{busy === 'upload' ? 'Uploading…' : 'Upload file…'}</button>
            {/* Hidden file input (CSV or XLSX). */}
            <input ref={fileInput} type="file" accept=".csv,.xlsx" hidden onChange={upload} />
          </div>
        </div>
        {/* Last export and import. */}
        <dl className="facts compact">
          {/* Label. */}
          <dt>Last export</dt>
          {/* Time, status and file (or error). */}
          <dd>{lastExport ? <>{dateTime(lastExport.at)} · <StatusTag status={lastExport.status} /> {lastExport.file || lastExport.errors[0]}</> : '–'}</dd>
          {/* Label. */}
          <dt>Last import</dt>
          {/* Time, status and file. */}
          <dd>{lastImport ? <>{dateTime(lastImport.at)} · <StatusTag status={lastImport.status} /> {lastImport.file}</> : '–'}</dd>
        </dl>
        {/* Note about uploads. */}
        <p className="muted small transfer-note">
          {/* Accepted files. */}
          <strong>Upload</strong> accepts the ERP's CSV export and the .xlsx file of the Fiori app's “Export to Spreadsheet” button
          (Manage Products). A file is always the <em>complete</em> product list: products that are missing in it are removed from the shop.
          {/* Hint in API mode. */}
          {!fileMode && conn && ' Import and upload are available in file transfer mode; an export made now waits in the inbox until then.'}
        </p>
      </section>

      {/* Inbox and rules side by side. */}
      <div className="two-col even">
        {/* Inbox. */}
        <section className="card">
          {/* Title. */}
          <h3>Inbox <span className="muted">({s.inbox.length})</span></h3>
          {/* Empty or the list. */}
          {s.inbox.length === 0 ? <p className="muted small">Empty – every file has been processed.</p> : (
            // File list.
            <ul className="simple-list">
              {/* One line per file. */}
              {s.inbox.map(f => (
                // One file.
                <li key={f.name}>
                  {/* Name (and a label when the name breaks the naming rule). */}
                  <span className="mono break">{f.name}{!f.valid && <span className="tag bad">name not valid</span>}</span>
                  {/* Size and time. */}
                  <span className="muted small nowrap">{kb(f.size)} · {dateTime(f.modified)}</span>
                </li>
              ))}
            </ul>
          )}
          {/* Hint in API mode. */}
          {!fileMode && s.inbox.length > 0 && <p className="muted small">Files are imported when the connector uses file transfer.</p>}
        </section>
        {/* Rules. */}
        <section className="card">
          {/* Title. */}
          <h3>Rules</h3>
          {/* Facts. */}
          <dl className="facts compact">
            {/* File name pattern. */}
            <dt>File name</dt><dd><code className="break">{s.naming}</code><span className="source-note">source = ERP connector id or “upload”, time in UTC</span></dd>
            {/* Formats. */}
            <dt>Formats</dt><dd>CSV (<code>,</code> or <code>;</code>, UTF-8) or XLSX – columns productID, name, description, price, stock</dd>
            {/* Frequency. */}
            <dt>Frequency</dt><dd>export every {s.exportIntervalS} s (only when changed), inbox every {s.pollIntervalS} s, or on demand</dd>
            {/* Rejection reasons. */}
            <dt>Rejected if</dt><dd>wrong name or source, already imported, older than the last import, empty, not CSV/XLSX, missing columns or any invalid line</dd>
            {/* Safety. */}
            <dt>Safety</dt><dd>files are written as <code>.part</code> and renamed when complete; one transaction per file</dd>
          </dl>
        </section>
      </div>

      {/* History. */}
      <section className="card">
        {/* Head. */}
        <div className="section-head">
          {/* Title. */}
          <h3>History <span className="muted">({s.history.length})</span></h3>
          {/* Hint. */}
          <span className="muted small">updates automatically</span>
        </div>
        {/* History table. */}
        <History rows={s.history} onDownload={download} />
      </section>
    </div>
  );
}
