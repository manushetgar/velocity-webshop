import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dateTime } from '../api.js';
import { useToast } from './Toast.jsx';
import { DatabaseIcon } from './Icons.jsx';

const kb = bytes => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

function importText(r) {
  if (r.status === 'rejected') return `rejected – ${r.errors[0]}${r.errors.length > 1 ? ` (+${r.errors.length - 1} more)` : ''}`;
  if (r.status === 'unchanged') return `${r.rows} products, no changes`;
  if (r.status === 'pending') return 'waiting in the inbox';
  return `${r.rows} products: ${r.created} new, ${r.updated} updated, ${r.unlinked} removed`;
}

function exportText(e) {
  if (!e) return '';
  if (e.written) return `export ${e.file} (${e.rows} products)`;
  return e.ok ? 'ERP data unchanged, no new file' : `export failed: ${e.error}`;
}

const STATUS_CLASS = { written: 'ok', imported: 'ok', unchanged: '', rejected: 'bad', failed: 'bad' };

function StatusTag({ status }) {
  return <span className={`tag ${STATUS_CLASS[status] ?? ''}`}>{status}</span>;
}

function History({ rows, onDownload }) {
  const [open, setOpen] = useState(null);
  if (!rows.length) return <p className="muted small">No transfers yet.</p>;
  return (
    <div className="table-wrap">
      <table className="table transfer-log">
        <thead><tr><th>Time</th><th>Step</th><th>File</th><th>Status</th><th>Result</th></tr></thead>
        <tbody>
          {rows.map(h => {
            const s = h.summary || {};
            const folder = h.direction === 'export' ? null : (s.movedTo || '').split('/')[0];
            const details = h.errors.length > 0 || s.warnings?.length > 0;
            return (
              <tr key={h.id}>
                <td className="nowrap">{dateTime(h.at)}</td>
                <td>{h.direction === 'export' ? 'ERP export' : 'Shop import'}</td>
                <td className="file-cell">
                  {h.file ? (
                    folder ? <button className="link mono" title={`Download from ${s.movedTo}`} onClick={() => onDownload(folder, s.movedTo.split('/')[1])}>{h.file}</button>
                      : <span className="mono">{h.file}</span>
                  ) : <span className="muted">–</span>}
                  {s.originalName && <span className="source-note">uploaded as {s.originalName}</span>}
                </td>
                <td><StatusTag status={h.status} /></td>
                <td>
                  {h.direction === 'export'
                    ? (h.status === 'written' ? `${h.rows} products · ${kb(s.bytes || 0)} · ${s.trigger}` : h.errors[0])
                    : h.status === 'rejected'
                      ? <span className="error">{h.errors.length} problem(s) – not imported</span>
                      : `${h.rows} products: ${s.created} new, ${s.updated} updated, ${s.unlinked} removed`}
                  {details && (
                    <button className="link small" onClick={() => setOpen(open === h.id ? null : h.id)}>
                      {open === h.id ? 'hide' : h.errors.length ? 'show problems' : 'show remarks'}
                    </button>
                  )}
                  {open === h.id && (
                    <div className="transfer-details">
                      {h.errors.length > 0 && <ul className="error">{h.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
                      {s.warnings?.length > 0 && <ul className="muted">{s.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
                      {h.status === 'rejected' && folder === 'error' && (
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

export default function FileTransfer() {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState('');
  const fileInput = useRef(null);

  const load = () => api.fileTransfer().then(setS).catch(e => toast(e.message, 'error'));
  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, []);

  const run = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
      load();
      window.dispatchEvent(new Event('sap-connector-changed'));
    }
  };

  const switchMode = integration => run('mode', async () => {
    const r = await api.setIntegration(integration);
    if (!r.sync.ok) return toast(`Switched, but the first run failed: ${r.sync.error}`, 'error');
    if (integration === 'file') {
      const last = r.sync.imports?.at(-1);
      toast(`File transfer on · ${exportText(r.sync.export)}${last ? ` · ${importText(last)}` : ''}`, last?.status === 'rejected' ? 'error' : 'success');
    } else {
      toast(`API integration on · ${r.sync.products.received} products synced live from the ERP`, 'success');
    }
  });
  const exportNow = () => run('export', async () => {
    const r = await api.fileExport();
    toast(`Export file written: ${r.file} (${r.rows} products)`, 'success');
  });
  const importNow = () => run('import', async () => {
    const r = await api.fileImport();
    if (!r.length) return toast('The inbox is empty – nothing to import', 'info');
    toast(r.map(x => `${x.file}: ${importText(x)}`).join(' · '), r.some(x => x.status === 'rejected') ? 'error' : 'success');
  });
  const upload = e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    run('upload', async () => {
      const r = await api.fileUpload(file);
      toast(`${file.name}: ${importText(r)}`, r.status === 'rejected' ? 'error' : 'success');
    });
  };
  const download = (folder, name) => api.fileDownload(folder, name).catch(e => toast(e.message, 'error'));

  if (!s) return <p className="muted">Loading…</p>;
  const conn = s.connector;
  const fileMode = conn?.integration === 'file';
  const lastExport = s.lastExport;
  const lastImport = s.lastImport;

  return (
    <div className="stack">
      <section className={`card erp-status ${fileMode ? 'on' : 'off'}`}>
        <div className="section-head">
          <h3><span className={`dot ${fileMode ? (lastExport?.status === 'failed' ? 'bad' : 'good') : 'idle'}`} />
            File transfer (Lab 2){conn ? ` · ${conn.name}` : ''}</h3>
          {conn && (
            <div className="segmented" role="group" aria-label="How product data reaches the shop">
              <button className={!fileMode ? 'active' : ''} disabled={!!busy} onClick={() => fileMode && switchMode('api')}>API (live)</button>
              <button className={fileMode ? 'active' : ''} disabled={!!busy} onClick={() => !fileMode && switchMode('file')}>
                {busy === 'mode' ? 'Switching…' : 'File transfer'}
              </button>
            </div>
          )}
        </div>
        {!conn ? (
          <p className="muted small">No SAP connector is active. Choose an ERP in <Link to="/admin/connectors">SAP connectors</Link> first.</p>
        ) : fileMode ? (
          <p className="muted small">
            The shop does not call the ERP to read products. The ERP's export job writes its product list as a file into the
            transfer folder, and the shop imports it from there. Orders stay in the shop (like Lab 1): the shop reduces its own
            stock, the next file brings the ERP's stock again.
          </p>
        ) : (
          <p className="muted small">
            {conn.name} is connected through its API (REST/OData): products are read live and every checkout creates an order in
            the ERP. Switch to <strong>File transfer</strong> to exchange the product data with files instead.
          </p>
        )}
        {fileMode && lastExport?.status === 'failed' && (
          <p className="test-result bad">Last export failed ({dateTime(lastExport.at)}): {lastExport.errors[0]}. The shop keeps the products of the last imported file.</p>
        )}
      </section>

      <section className="card">
        <h3>How the files travel</h3>
        <div className="flow">
          <div className="flow-step erp">
            <span className="connector-icon"><DatabaseIcon /></span>
            <strong>SAP ERP – export job</strong>
            <span className="muted small">{conn?.name || 'no ERP'} · <code>GET /rest/api/getProducts()</code> (CSV)</span>
          </div>
          <div className="flow-arrow"><span>every {s.exportIntervalS} s if the ERP data changed, or “Export now”</span></div>
          <div className="flow-step">
            <strong>inbox/</strong>
            <span className="kpi-value">{s.inbox.length}</span>
            <span className="muted small">file(s) waiting</span>
          </div>
          <div className="flow-arrow"><span>checked every {s.pollIntervalS} s</span></div>
          <div className="flow-step">
            <strong>Shop import</strong>
            <span className="muted small">checks name, format and every line – all or nothing</span>
          </div>
          <div className="flow-split">
            <div className="flow-step ok"><strong>processed/</strong><span className="kpi-value">{s.counts.processed}</span><span className="muted small">imported</span></div>
            <div className="flow-step bad"><strong>error/</strong><span className="kpi-value">{s.counts.error}</span><span className="muted small">rejected (+ report)</span></div>
          </div>
        </div>
        <p className="muted small">Folder on the server: <code className="break">{s.dir}</code></p>
      </section>

      <section className="card">
        <div className="section-head">
          <h3>Transfer now</h3>
          <div className="toolbar">
            <button className="primary" disabled={!conn || !!busy} onClick={exportNow}>{busy === 'export' ? 'Exporting…' : 'Export from ERP now'}</button>
            <button disabled={!fileMode || !!busy} onClick={importNow}>{busy === 'import' ? 'Importing…' : 'Import inbox now'}</button>
            <button disabled={!fileMode || !!busy} onClick={() => fileInput.current.click()}>{busy === 'upload' ? 'Uploading…' : 'Upload file…'}</button>
            <input ref={fileInput} type="file" accept=".csv,.xlsx" hidden onChange={upload} />
          </div>
        </div>
        <dl className="facts compact">
          <dt>Last export</dt>
          <dd>{lastExport ? <>{dateTime(lastExport.at)} · <StatusTag status={lastExport.status} /> {lastExport.file || lastExport.errors[0]}</> : '–'}</dd>
          <dt>Last import</dt>
          <dd>{lastImport ? <>{dateTime(lastImport.at)} · <StatusTag status={lastImport.status} /> {lastImport.file}</> : '–'}</dd>
        </dl>
        <p className="muted small transfer-note">
          <strong>Upload</strong> accepts the ERP's CSV export and the .xlsx file of the Fiori app's “Export to Spreadsheet” button
          (Manage Products). A file is always the <em>complete</em> product list: products that are missing in it are removed from the shop.
          {!fileMode && conn && ' Import and upload are available in file transfer mode; an export made now waits in the inbox until then.'}
        </p>
      </section>

      <div className="two-col even">
        <section className="card">
          <h3>Inbox <span className="muted">({s.inbox.length})</span></h3>
          {s.inbox.length === 0 ? <p className="muted small">Empty – every file has been processed.</p> : (
            <ul className="simple-list">
              {s.inbox.map(f => (
                <li key={f.name}>
                  <span className="mono break">{f.name}{!f.valid && <span className="tag bad">name not valid</span>}</span>
                  <span className="muted small nowrap">{kb(f.size)} · {dateTime(f.modified)}</span>
                </li>
              ))}
            </ul>
          )}
          {!fileMode && s.inbox.length > 0 && <p className="muted small">Files are imported when the connector uses file transfer.</p>}
        </section>
        <section className="card">
          <h3>Rules</h3>
          <dl className="facts compact">
            <dt>File name</dt><dd><code className="break">{s.naming}</code><span className="source-note">source = ERP connector id or “upload”, time in UTC</span></dd>
            <dt>Formats</dt><dd>CSV (<code>,</code> or <code>;</code>, UTF-8) or XLSX – columns productID, name, description, price, stock</dd>
            <dt>Frequency</dt><dd>export every {s.exportIntervalS} s (only when changed), inbox every {s.pollIntervalS} s, or on demand</dd>
            <dt>Rejected if</dt><dd>wrong name or source, already imported, older than the last import, empty, not CSV/XLSX, missing columns or any invalid line</dd>
            <dt>Safety</dt><dd>files are written as <code>.part</code> and renamed when complete; one transaction per file</dd>
          </dl>
        </section>
      </div>

      <section className="card">
        <div className="section-head">
          <h3>History <span className="muted">({s.history.length})</span></h3>
          <span className="muted small">updates automatically</span>
        </div>
        <History rows={s.history} onDownload={download} />
      </section>
    </div>
  );
}
