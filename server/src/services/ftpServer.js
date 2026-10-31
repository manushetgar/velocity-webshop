// =====================================================================================================
// ftpServer.js - a small FTP server for the suppliers (Lab 2 extension), written with Node's net module only
// (no npm dependency).
//
// Role in the architecture:
//  - Second delivery channel next to the supplier portal: a supplier's SYSTEM (or an employee with FileZilla)
//    uploads product files by FTP - the classic way of file based B2B integration.
//  - Login = a supplier user (the same account as in the supplier portal). Every account only sees its own
//    supplier folder:
//        /inbox    upload your files here (write)  -> processed by supplierImport.js
//        /outbox   acknowledgements: <file>.ack.txt / <file>.error.txt (read, delete)
//  - Plain FTP, passive mode only (PASV / EPSV), bound to 127.0.0.1 by default. Plain FTP sends passwords
//    unencrypted - fine for a local demo, in production SFTP or FTPS would be used (see README).
//
// Protocol in short (RFC 959): the client sends text commands on the control connection ("USER anna",
// "PASV", "STOR file.csv"), the server answers with a 3-digit code and a text ("230 Logged in"). File contents and
// directory listings travel over a second "data" connection; in passive mode the server opens a port, tells the
// client its number (227 / 229 reply), and the client connects to it.
// =====================================================================================================

// TCP sockets and servers.
import net from 'node:net';
// Files of the supplier folders.
import { createReadStream, createWriteStream, existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
// posix: virtual FTP paths always use "/"; join: real paths on the server.
import { join, posix } from 'node:path';
// Supplier accounts, folders and the delivery log.
import { verifySupplierLogin, supplierDirs, createDelivery, openDelivery } from './suppliers.js';
// Processing of a supplier's inbox right after an upload.
import { processSupplierInboxes } from './supplierImport.js';
// Size limit of one file (same as for portal uploads).
import { MAX_FILE_BYTES } from './productFile.js';

// Address and port (FTP_PORT=0 switches the server off). 127.0.0.1: only reachable from this computer.
export const FTP_HOST = process.env.FTP_HOST || '127.0.0.1';
// FTP port (default 2121).
export const FTP_PORT = Number(process.env.FTP_PORT ?? 2121);
// Optional fixed range for passive data ports (e.g. for a firewall); 0 = any free port.
const PASV_MIN = Number(process.env.FTP_PASV_MIN || 0);
// (upper end of the range)
const PASV_MAX = Number(process.env.FTP_PASV_MAX || 0);
// The folders of the virtual root and the one that accepts uploads.
const FOLDERS = ['inbox', 'outbox'];
// Commands that are allowed before the login.
const PUBLIC = new Set(['USER', 'PASS', 'QUIT', 'FEAT', 'SYST', 'AUTH', 'PBSZ', 'PROT', 'OPTS', 'NOOP', 'HELP', 'CLNT']);
// Month names for the Unix style LIST format.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A file name a supplier may use: no path separators, no drive letters, no control characters, not hidden.
const validName = n => !!n && n.length <= 200 && !/[\\/:*?"<>|\x00-\x1f]/.test(n) && !n.startsWith('.') && n !== '..';

// Time in FTP's machine format (MDTM, MLSD): YYYYMMDDHHMMSS in UTC.
const ftpTime = d => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);

// One line of a Unix style directory listing ("-rw-r--r-- 1 ftp ftp 1234 Oct 26 15:42 file.csv").
function listLine(name, st, isDir) {
  // Modification time of the entry.
  const d = st.mtime;
  // Recent files show the time, older ones (> 6 months) the year - like "ls -l".
  const recent = Date.now() - d.getTime() < 180 * 24 * 3600 * 1000;
  // e.g. "Oct 26 15:42" or "Mar  3  2025".
  const when = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${recent ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ` ${d.getFullYear()}`}`;
  // Permissions, links, owner, group, size (10 wide), date and name - the format FTP clients parse.
  return `${isDir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 ftp ftp ${String(isDir ? 0 : st.size).padStart(10)} ${when} ${name}`;
}

/** One FTP control connection (one logged-in client). */
class FtpSession {
  // Called by net.createServer for every new client connection.
  constructor(socket) {
    // The control connection (commands and replies).
    this.socket = socket;
    // Login state: the user name of USER, then the account after a successful PASS.
    this.pendingUser = null;
    // Logged-in account: { user, supplier, dirs } after a successful PASS.
    this.account = null;
    // Counter for the brute force protection.
    this.failedLogins = 0;
    // Current virtual directory and the source of a rename (RNFR).
    this.cwd = '/';
    // Source of a rename (RNFR) until RNTO arrives.
    this.renameFrom = null;
    // Passive data connection waiting for the client: { server, socket: Promise }.
    this.pasv = null;
    // Commands are executed one after the other (a transfer finishes before the next command runs).
    this.queue = Promise.resolve();
    // Incomplete command line.
    let buffer = '';
    // Commands are text (UTF-8).
    socket.setEncoding('utf8');
    // Idle connections are closed after 10 minutes.
    socket.setTimeout(10 * 60 * 1000, () => { this.reply(421, 'Timeout - closing connection.'); socket.end(); });
    // New bytes from the client.
    socket.on('data', chunk => {
      // Append to the incomplete line.
      buffer += chunk;
      // A command line is never this long - protection against garbage / attacks.
      if (buffer.length > 8192) { socket.destroy(); return; }
      // Execute every complete line (commands end with CRLF).
      let nl;
      // One iteration per complete line.
      while ((nl = buffer.indexOf('\n')) >= 0) {
        // The line without its line break.
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        // Keep the rest for the next chunk.
        buffer = buffer.slice(nl + 1);
        // Queue the command; an exception becomes "451 Local error" instead of crashing the server.
        this.queue = this.queue.then(() => this.command(line)).catch(e => this.reply(451, `Local error: ${e.message}`));
      }
    });
    // Connection errors (client gone) are not a problem of the server.
    socket.on('error', () => {});
    // Client gone: close a passive port that may still be open.
    socket.on('close', () => this.closePasv());
    // Greeting.
    this.reply(220, 'VeloCity supplier FTP - log in with your supplier portal account');
  }

  // Sends a reply line "<code> <text>".
  reply(code, text) {
    // Only while the connection is open.
    if (!this.socket.destroyed) this.socket.write(`${code} ${text}\r\n`);
  }

  // Sends a multi-line reply: "<code>-first", " line", ..., "<code> last".
  replyLines(code, first, lines, last) {
    // First line with "-", inner lines indented, last line with a space after the code (RFC 959).
    if (!this.socket.destroyed) this.socket.write(`${code}-${first}\r\n${lines.map(l => ` ${l}\r\n`).join('')}${code} ${last}\r\n`);
  }

  // Resolves a path argument against the current directory inside the supplier's virtual root.
  // Returns { path, folder, name, real } or null for paths outside "/", "/inbox", "/outbox" and their files.
  resolve(arg = '') {
    // posix.normalize removes "." and ".." - ".." above "/" stays at "/", so the client cannot leave its root.
    const v = posix.normalize(arg.startsWith('/') ? arg : posix.join(this.cwd, arg || '.'));
    // Path parts without empty strings.
    const parts = v.split('/').filter(Boolean);
    // Only the two folders and files directly inside them; a plain file name in "/" is reported as such (it has no
    // real path), so STOR can answer "only in /inbox" instead of "invalid name".
    if (parts.length > 2 || (parts[1] && !validName(parts[1]))) return null;
    // A file name directly in "/": known name, but no real file (uploads go to /inbox).
    if (parts.length === 1 && !FOLDERS.includes(parts[0])) return validName(parts[0]) ? { path: v, folder: null, name: parts[0], real: null } : null;
    // Other folders do not exist.
    if (parts[0] && !FOLDERS.includes(parts[0])) return null;
    // The supplier's root folder on the server.
    const root = this.account.dirs.root;
    // Virtual path, folder, file name and the real path below the supplier's root.
    return { path: '/' + parts.join('/'), folder: parts[0] || null, name: parts[1] || null, real: join(root, ...parts) };
  }

  // Closes a passive data port that is still open.
  closePasv() {
    // Stop listening and the 30 s timer.
    if (this.pasv) { this.pasv.server.close(); this.pasv.timer && clearTimeout(this.pasv.timer); this.pasv = null; }
  }

  // Opens a passive data port and returns its number.
  async openPasv() {
    // Only one passive port per connection.
    this.closePasv();
    // A small TCP server only for this one data connection.
    const server = net.createServer();
    // Ports to try: the configured range, or 0 (= the operating system picks a free one).
    const ports = PASV_MIN && PASV_MAX >= PASV_MIN ? Array.from({ length: PASV_MAX - PASV_MIN + 1 }, (_, i) => PASV_MIN + i) : [0];
    // The port that could be opened.
    let port = null;
    // Try the ports one after the other.
    for (const p of ports) {
      // listen() reports success with the callback, failure with the error event.
      port = await new Promise(res => {
        // The port is in use: try the next one.
        server.once('error', () => res(null));
        // Listen on the address of the control connection; the callback returns the port the system assigned.
        server.listen(p, this.socket.localAddress, () => res(server.address().port));
      });
      // Opened.
      if (port) break;
    }
    // All ports of the range are in use.
    if (!port) throw new Error('no free passive port');
    // The first connection from the SAME client address is the data connection (others are refused).
    const socket = new Promise((resolve, reject) => {
      // A client connects to the data port.
      server.on('connection', s => {
        // Port theft protection: another address may not take over the transfer.
        if (s.remoteAddress !== this.socket.remoteAddress) { s.destroy(); return; }
        // Accept only this one connection.
        server.close();
        // The data socket.
        resolve(s);
      });
      // Port closed (timeout / ABOR) before anyone connected.
      server.once('close', () => reject(new Error('data connection closed')));
    });
    // Avoid an "unhandled rejection" if nobody waits for the promise.
    socket.catch(() => {});
    // Remember the passive port.
    this.pasv = { server, socket, port };
    // Nobody connected within 30 seconds: close the port.
    this.pasv.timer = setTimeout(() => this.closePasv(), 30000);
    // For the 227 / 229 reply.
    return port;
  }

  // Waits for the client's data connection (after PASV/EPSV); null if there is none.
  async dataSocket() {
    // PASV/EPSV was not sent before.
    if (!this.pasv) return null;
    // The waiting promise and the timeout timer.
    const { socket, timer } = this.pasv;
    try {
      // The client has 15 seconds to connect.
      const s = await Promise.race([socket, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]);
      // Connected: stop the 30 s timer.
      clearTimeout(timer);
      // The port is used up.
      this.pasv = null;
      // The data socket.
      return s;
    } catch {
      // No connection: close the port.
      this.closePasv();
      // The caller answers 425.
      return null;
    }
  }

  // Sends text (a listing) over a data connection: 150, data, 226.
  async sendData(text) {
    // Wait for the data connection.
    const s = await this.dataSocket();
    // No data connection.
    if (!s) return this.reply(425, 'Use PASV or EPSV first (passive mode only).');
    // 150 = the transfer starts.
    this.reply(150, 'Here comes the listing.');
    // Send the text and close the data connection (end of data = end of file in stream mode).
    await new Promise(res => s.end(text, res));
    // 226 = transfer complete.
    this.reply(226, 'Transfer complete.');
  }

  // Entries of a virtual directory: the root shows the two folders, a folder its files.
  entries(dir) {
    // Root: the two folders.
    if (!dir.folder) return FOLDERS.map(f => ({ name: f, isDir: true, st: statSync(join(this.account.dirs.root, f)) }));
    // Missing folder: empty.
    if (!existsSync(dir.real)) return [];
    // Visible, complete files of the folder.
    return readdirSync(dir.real, { withFileTypes: true })
      .filter(d => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.part'))
      .map(d => ({ name: d.name, isDir: false, st: statSync(join(dir.real, d.name)) }));
  }

  // Executes one command line.
  async command(line) {
    // "STOR my file.csv" -> verb STOR, argument "my file.csv" (file names may contain spaces).
    const space = line.indexOf(' ');
    // Command word, case-insensitive.
    const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    // Everything after the first space.
    const arg = space < 0 ? '' : line.slice(space + 1);
    // Empty line: ignore.
    if (!verb) return;
    // Everything except the public commands needs a login.
    if (!this.account && !PUBLIC.has(verb)) return this.reply(530, 'Please log in with USER and PASS.');

    // One case per supported command.
    switch (verb) {
      // USER <name>: remember the name, ask for the password.
      case 'USER':
        // The user name sent by the client.
        this.pendingUser = arg.trim();
        // Not logged in until PASS succeeds.
        this.account = null;
        // 331: the server waits for the password.
        return this.reply(331, `Password required for ${this.pendingUser}.`);
      // PASS <password>: check the login.
      case 'PASS': {
        // PASS without USER.
        if (!this.pendingUser) return this.reply(503, 'Send USER first.');
        // Same check as the portal login (bcrypt, active supplier).
        const login = verifySupplierLogin(this.pendingUser, arg);
        // Wrong user or password:
        if (!login) {
          // Slow down password guessing; close the connection after 5 failures.
          this.failedLogins++;
          // Wait 1, 2, 3 seconds (more failures = longer wait).
          await new Promise(r => setTimeout(r, 1000 * Math.min(this.failedLogins, 3)));
          // Too many failures: disconnect.
          if (this.failedLogins >= 5) { this.reply(421, 'Too many failed logins.'); return this.socket.end(); }
          // 530 = not logged in.
          return this.reply(530, 'Login incorrect.');
        }
        // Logged in: the account with the supplier's folders.
        this.account = { ...login, dirs: supplierDirs(login.supplier.id) };
        // Start in the virtual root.
        this.cwd = '/';
        // Server log.
        console.log(`[ftp] ${login.user.username} (${login.supplier.name}) logged in`);
        // 230 = logged in.
        return this.reply(230, `Welcome ${login.user.name} (${login.supplier.name}) - upload files into /inbox, acknowledgements are in /outbox`);
      }
      // TLS (FTPS) commands.
      case 'AUTH': case 'PBSZ': case 'PROT':
        // No TLS in this demo server (clients like FileZilla then continue with plain FTP after asking the user).
        return this.reply(502, 'TLS is not supported by this demo server (plain FTP on localhost).');
      // Operating system type, as most FTP clients expect.
      case 'SYST': return this.reply(215, 'UNIX Type: L8');
      // Extensions supported by this server (RFC 2389).
      case 'FEAT': return this.replyLines(211, 'Features:', ['EPSV', 'PASV', 'MDTM', 'SIZE', 'MLST type*;size*;modify*;', 'UTF8'], 'End');
      // OPTS UTF8 ON: names are always UTF-8 here.
      case 'OPTS': return this.reply(200, /^UTF8/i.test(arg) ? 'Always in UTF8 mode.' : 'OK.');
      // No-ops.
      case 'NOOP': case 'CLNT': return this.reply(200, 'OK.');
      // List of the commands.
      case 'HELP': return this.reply(214, 'USER PASS PWD CWD CDUP LIST NLST MLSD MLST STOR RETR DELE RNFR RNTO SIZE MDTM PASV EPSV TYPE QUIT');
      // End of the session.
      case 'QUIT': this.reply(221, 'Goodbye.'); return this.socket.end();
      // ASCII or binary - files are always transferred unchanged.
      case 'TYPE': return /^[AI]/i.test(arg) ? this.reply(200, `Type set to ${arg.toUpperCase()}.`) : this.reply(504, 'Only TYPE A and I.');
      // Only stream mode ...
      case 'MODE': return /^S$/i.test(arg) ? this.reply(200, 'Mode S.') : this.reply(504, 'Only stream mode.');
      // ... and file structure (the FTP defaults).
      case 'STRU': return /^F$/i.test(arg) ? this.reply(200, 'Structure F.') : this.reply(504, 'Only file structure.');
      // No space has to be reserved.
      case 'ALLO': return this.reply(202, 'No storage allocation necessary.');
      // Restart of interrupted transfers is not supported.
      case 'REST': return arg.trim() === '0' ? this.reply(350, 'Restarting at 0.') : this.reply(502, 'Resume is not supported.');
      // Abort: close the data port.
      case 'ABOR': this.closePasv(); return this.reply(226, 'Aborted.');
      // Active mode (the server connects to the client) is not supported.
      case 'PORT': case 'EPRT': return this.reply(502, 'Active mode is not supported - use passive mode.');
      // Current directory.
      case 'PWD': case 'XPWD': return this.reply(257, `"${this.cwd}" is the current directory.`);
      // Change directory (CDUP = one level up).
      case 'CWD': case 'XCWD': case 'CDUP': case 'XCUP': {
        // Only "/", "/inbox" and "/outbox" are directories.
        const d = this.resolve(verb.includes('UP') ? '..' : arg);
        // Not a directory.
        if (!d || d.name) return this.reply(550, 'No such directory (use /inbox or /outbox).');
        // The new current directory.
        this.cwd = d.path;
        // 250 = OK.
        return this.reply(250, `Directory changed to ${this.cwd}.`);
      }
      // Passive mode, IPv4 reply format.
      case 'PASV': {
        // Open a data port.
        const port = await this.openPasv();
        // IPv4 address of this server in the 227 format "h1,h2,h3,h4,p1,p2" (port = p1 * 256 + p2).
        const host = String(this.socket.localAddress || FTP_HOST).replace(/^::ffff:/, '').replace('::1', '127.0.0.1');
        // 227 (h1,h2,h3,h4,p1,p2) - the client connects to h1.h2.h3.h4 port p1*256+p2.
        return this.reply(227, `Entering Passive Mode (${host.split('.').join(',')},${port >> 8},${port & 255}).`);
      }
      // Extended passive mode (RFC 2428): only the port number.
      case 'EPSV': {
        // Open a data port.
        const port = await this.openPasv();
        // 229 (|||port|).
        return this.reply(229, `Entering Extended Passive Mode (|||${port}|).`);
      }
      // Directory listings: LIST (ls -l format), NLST (names only), MLSD (machine readable facts).
      case 'LIST': case 'NLST': case 'MLSD': {
        // Options like "-a" or "-la" (sent by some clients) are ignored.
        const d = this.resolve(arg.replace(/^-\w+\s*/, ''));
        // Not a directory.
        if (!d || d.name) { this.closePasv(); return this.reply(550, 'No such directory.'); }
        // The entries of the directory.
        const list = this.entries(d);
        // One text line per entry, in the requested format.
        const text = verb === 'NLST' ? list.map(e => e.name)
          : verb === 'MLSD' ? list.map(e => `type=${e.isDir ? 'dir' : 'file'};${e.isDir ? '' : `size=${e.st.size};`}modify=${ftpTime(e.st.mtime)}; ${e.name}`)
          : list.map(e => listLine(e.name, e.st, e.isDir));
        // Lines end with CRLF.
        return this.sendData(text.map(l => l + '\r\n').join(''));
      }
      // Facts of one entry, on the control connection.
      case 'MLST': {
        // Resolve the path.
        const d = this.resolve(arg);
        // Unknown path.
        if (!d || (d.name && !(d.real && existsSync(d.real)))) return this.reply(550, 'Not found.');
        // Size and time.
        const st = statSync(d.real);
        // Machine readable facts, like one MLSD line.
        return this.replyLines(250, 'Listing', [`type=${d.name ? 'file' : 'dir'};${d.name ? `size=${st.size};` : ''}modify=${ftpTime(st.mtime)}; ${d.path}`], 'End');
      }
      // SIZE / MDTM of a file (used by clients to compare files).
      case 'SIZE': case 'MDTM': {
        // Resolve the path.
        const d = this.resolve(arg);
        // Only existing files.
        if (!d?.real || !d.name || !existsSync(d.real)) return this.reply(550, 'File not found.');
        // Size and time.
        const st = statSync(d.real);
        // 213 + size in bytes, or the modification time.
        return this.reply(213, verb === 'SIZE' ? String(st.size) : ftpTime(st.mtime));
      }
      // Download a file (e.g. an acknowledgement from /outbox).
      case 'RETR': {
        // Resolve the path.
        const d = this.resolve(arg);
        // Only existing files.
        if (!d?.real || !d.name || !existsSync(d.real)) { this.closePasv(); return this.reply(550, 'File not found.'); }
        // Wait for the data connection.
        const s = await this.dataSocket();
        // No data connection.
        if (!s) return this.reply(425, 'Use PASV or EPSV first.');
        // Transfer starts.
        this.reply(150, `Sending ${d.name}.`);
        // Stream the file into the data connection.
        await new Promise(res => createReadStream(d.real).on('error', () => { s.destroy(); res(); }).pipe(s).on('finish', res).on('close', res));
        // Transfer complete.
        return this.reply(226, 'Transfer complete.');
      }
      // STOR <file>: upload a file into /inbox.
      case 'STOR': {
        // Uploads only into /inbox, with a plain file name.
        const d = this.resolve(arg);
        // Not a valid file name (path parts, special characters).
        if (!d?.name) { this.closePasv(); return this.reply(553, 'Invalid file name.'); }
        // In "/" or "/outbox".
        if (d.folder !== 'inbox') { this.closePasv(); return this.reply(553, 'Uploads are only allowed in /inbox.'); }
        // Wait for the data connection.
        const s = await this.dataSocket();
        // No data connection.
        if (!s) return this.reply(425, 'Use PASV or EPSV first.');
        // Transfer starts.
        this.reply(150, `Ready to receive ${d.name}.`);
        // Write to a hidden temporary file first; the import only sees the file when it is complete (rename).
        const tmp = join(this.account.dirs.inbox, `.${d.name}.part`);
        // true when the file was received completely, false on error / too large.
        const ok = await new Promise(res => {
          // Bytes received so far.
          let size = 0;
          // Write into the temporary file.
          const out = createWriteStream(tmp);
          // Size limit: stop the transfer when the file gets too large.
          s.on('data', chunk => { size += chunk.length; if (size > MAX_FILE_BYTES) { s.destroy(); out.destroy(); res(false); } });
          // Copy the data into the file.
          s.pipe(out);
          // The client closed the data connection: the file is complete.
          out.on('finish', () => res(true));
          // Disk error.
          out.on('error', () => res(false));
        });
        // Failed: remove the temporary file, 552 = exceeded storage allocation.
        if (!ok) { try { unlinkSync(tmp); } catch { /* not created */ } return this.reply(552, `Upload failed or larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`); }
        // Complete: make it visible for the import (overwrites a waiting file with the same name).
        renameSync(tmp, d.real);
        // 226 = received.
        this.reply(226, `Received ${d.name} - it will be processed now; the acknowledgement appears in /outbox.`);
        // Delivery log + immediate processing (the same file name again replaces a file that is still waiting).
        const { supplier, user } = this.account;
        // Record the delivery unless a waiting delivery of the same file exists.
        if (!openDelivery(supplier.id, d.name))
          createDelivery({ supplierId: supplier.id, channel: 'ftp', username: user.username, originalName: d.name, fileName: d.name });
        // Server log.
        console.log(`[ftp] ${user.username} uploaded ${d.name}`);
        // Process it now (in the background; the acknowledgement appears in /outbox).
        processSupplierInboxes({ supplierId: supplier.id, force: true }).catch(() => {});
        // The reply was sent already.
        return;
      }
      // Delete a file (a waiting upload in /inbox or an acknowledgement in /outbox).
      case 'DELE': {
        // Resolve the path.
        const d = this.resolve(arg);
        // Only existing files.
        if (!d?.real || !d.name || !existsSync(d.real)) return this.reply(550, 'File not found.');
        // Delete it.
        unlinkSync(d.real);
        // 250 = done.
        return this.reply(250, `Deleted ${d.name}.`);
      }
      // Rename, step 1: the old name.
      case 'RNFR': {
        // Resolve the path.
        const d = this.resolve(arg);
        // Only files in /inbox.
        if (!d?.real || !d.name || !existsSync(d.real) || d.folder !== 'inbox') return this.reply(550, 'Only files in /inbox can be renamed.');
        // Remember the source.
        this.renameFrom = d;
        // 350 = waiting for RNTO.
        return this.reply(350, 'Ready for RNTO.');
      }
      // Rename, step 2: the new name.
      case 'RNTO': {
        // Resolve the new path.
        const d = this.resolve(arg);
        // The source from RNFR ...
        const from = this.renameFrom;
        // ... is used only once.
        this.renameFrom = null;
        // Both names must be in /inbox.
        if (!from || !d?.name || d.folder !== 'inbox') return this.reply(553, 'Rename only within /inbox.');
        // Rename on disk.
        renameSync(from.real, d.real);
        // 250 = done.
        return this.reply(250, 'Renamed.');
      }
      // The folder structure is fixed.
      case 'MKD': case 'XMKD': case 'RMD': case 'XRMD':
        // 550: not allowed.
        return this.reply(550, 'Folders cannot be created or removed.');
      // Everything else.
      default:
        // 502: command not implemented.
        return this.reply(502, `${verb} is not implemented.`);
    }
  }
}

/** Starts the FTP server (index.js). Returns the server, or null if FTP_PORT=0. */
export function startFtpServer() {
  // FTP_PORT=0: no FTP server.
  if (!FTP_PORT) return null;
  // One FtpSession per client connection.
  const server = net.createServer(socket => new FtpSession(socket));
  // A port that is already used must not crash the shop - only FTP is not available then.
  server.on('error', e => console.warn(`[ftp] ${e.code === 'EADDRINUSE' ? `port ${FTP_PORT} is already in use` : e.message} - supplier FTP is not available`));
  // Listen on FTP_HOST (default 127.0.0.1 = only this computer).
  server.listen(FTP_PORT, FTP_HOST, () => console.log(`[ftp] supplier FTP server on ftp://${FTP_HOST}:${FTP_PORT} (log in with a supplier account)`));
  // The server object (not used further).
  return server;
}
