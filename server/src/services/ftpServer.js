import net from 'node:net';
import { createReadStream, createWriteStream, existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, posix } from 'node:path';
import { verifySupplierLogin, supplierDirs, createDelivery, openDelivery } from './suppliers.js';
import { processSupplierInboxes } from './supplierImport.js';
import { MAX_FILE_BYTES } from './productFile.js';

export const FTP_HOST = process.env.FTP_HOST || '127.0.0.1';
export const FTP_PORT = Number(process.env.FTP_PORT ?? 2121);
const PASV_MIN = Number(process.env.FTP_PASV_MIN || 0);
const PASV_MAX = Number(process.env.FTP_PASV_MAX || 0);
const FOLDERS = ['inbox', 'outbox'];
const PUBLIC = new Set(['USER', 'PASS', 'QUIT', 'FEAT', 'SYST', 'AUTH', 'PBSZ', 'PROT', 'OPTS', 'NOOP', 'HELP', 'CLNT']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const validName = n => !!n && n.length <= 200 && !/[\\/:*?"<>|\x00-\x1f]/.test(n) && !n.startsWith('.') && n !== '..';

const ftpTime = d => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);

function listLine(name, st, isDir) {
  const d = st.mtime;
  const recent = Date.now() - d.getTime() < 180 * 24 * 3600 * 1000;
  const when = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${recent ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ` ${d.getFullYear()}`}`;
  return `${isDir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 ftp ftp ${String(isDir ? 0 : st.size).padStart(10)} ${when} ${name}`;
}

class FtpSession {
  constructor(socket) {
    this.socket = socket;
    this.pendingUser = null;
    this.account = null;
    this.failedLogins = 0;
    this.cwd = '/';
    this.renameFrom = null;
    this.pasv = null;
    this.queue = Promise.resolve();
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10 * 60 * 1000, () => { this.reply(421, 'Timeout - closing connection.'); socket.end(); });
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8192) { socket.destroy(); return; }
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        this.queue = this.queue.then(() => this.command(line)).catch(e => this.reply(451, `Local error: ${e.message}`));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.closePasv());
    this.reply(220, 'VeloCity supplier FTP - log in with your supplier portal account');
  }

  reply(code, text) {
    if (!this.socket.destroyed) this.socket.write(`${code} ${text}\r\n`);
  }

  replyLines(code, first, lines, last) {
    if (!this.socket.destroyed) this.socket.write(`${code}-${first}\r\n${lines.map(l => ` ${l}\r\n`).join('')}${code} ${last}\r\n`);
  }

  resolve(arg = '') {
    const v = posix.normalize(arg.startsWith('/') ? arg : posix.join(this.cwd, arg || '.'));
    const parts = v.split('/').filter(Boolean);
    if (parts.length > 2 || (parts[1] && !validName(parts[1]))) return null;
    if (parts.length === 1 && !FOLDERS.includes(parts[0])) return validName(parts[0]) ? { path: v, folder: null, name: parts[0], real: null } : null;
    if (parts[0] && !FOLDERS.includes(parts[0])) return null;
    const root = this.account.dirs.root;
    return { path: '/' + parts.join('/'), folder: parts[0] || null, name: parts[1] || null, real: join(root, ...parts) };
  }

  closePasv() {
    if (this.pasv) { this.pasv.server.close(); this.pasv.timer && clearTimeout(this.pasv.timer); this.pasv = null; }
  }

  async openPasv() {
    this.closePasv();
    const server = net.createServer();
    const ports = PASV_MIN && PASV_MAX >= PASV_MIN ? Array.from({ length: PASV_MAX - PASV_MIN + 1 }, (_, i) => PASV_MIN + i) : [0];
    let port = null;
    for (const p of ports) {
      port = await new Promise(res => {
        server.once('error', () => res(null));
        server.listen(p, this.socket.localAddress, () => res(server.address().port));
      });
      if (port) break;
    }
    if (!port) throw new Error('no free passive port');
    const socket = new Promise((resolve, reject) => {
      server.on('connection', s => {
        if (s.remoteAddress !== this.socket.remoteAddress) { s.destroy(); return; }
        server.close();
        resolve(s);
      });
      server.once('close', () => reject(new Error('data connection closed')));
    });
    socket.catch(() => {});
    this.pasv = { server, socket, port };
    this.pasv.timer = setTimeout(() => this.closePasv(), 30000);
    return port;
  }

  async dataSocket() {
    if (!this.pasv) return null;
    const { socket, timer } = this.pasv;
    try {
      const s = await Promise.race([socket, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]);
      clearTimeout(timer);
      this.pasv = null;
      return s;
    } catch {
      this.closePasv();
      return null;
    }
  }

  async sendData(text) {
    const s = await this.dataSocket();
    if (!s) return this.reply(425, 'Use PASV or EPSV first (passive mode only).');
    this.reply(150, 'Here comes the listing.');
    await new Promise(res => s.end(text, res));
    this.reply(226, 'Transfer complete.');
  }

  entries(dir) {
    if (!dir.folder) return FOLDERS.map(f => ({ name: f, isDir: true, st: statSync(join(this.account.dirs.root, f)) }));
    if (!existsSync(dir.real)) return [];
    return readdirSync(dir.real, { withFileTypes: true })
      .filter(d => d.isFile() && !d.name.startsWith('.') && !d.name.endsWith('.part'))
      .map(d => ({ name: d.name, isDir: false, st: statSync(join(dir.real, d.name)) }));
  }

  async command(line) {
    const space = line.indexOf(' ');
    const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    const arg = space < 0 ? '' : line.slice(space + 1);
    if (!verb) return;
    if (!this.account && !PUBLIC.has(verb)) return this.reply(530, 'Please log in with USER and PASS.');

    switch (verb) {
      case 'USER':
        this.pendingUser = arg.trim();
        this.account = null;
        return this.reply(331, `Password required for ${this.pendingUser}.`);
      case 'PASS': {
        if (!this.pendingUser) return this.reply(503, 'Send USER first.');
        const login = verifySupplierLogin(this.pendingUser, arg);
        if (!login) {
          this.failedLogins++;
          await new Promise(r => setTimeout(r, 1000 * Math.min(this.failedLogins, 3)));
          if (this.failedLogins >= 5) { this.reply(421, 'Too many failed logins.'); return this.socket.end(); }
          return this.reply(530, 'Login incorrect.');
        }
        this.account = { ...login, dirs: supplierDirs(login.supplier.id) };
        this.cwd = '/';
        console.log(`[ftp] ${login.user.username} (${login.supplier.name}) logged in`);
        return this.reply(230, `Welcome ${login.user.name} (${login.supplier.name}) - upload files into /inbox, acknowledgements are in /outbox`);
      }
      case 'AUTH': case 'PBSZ': case 'PROT':
        return this.reply(502, 'TLS is not supported by this demo server (plain FTP on localhost).');
      case 'SYST': return this.reply(215, 'UNIX Type: L8');
      case 'FEAT': return this.replyLines(211, 'Features:', ['EPSV', 'PASV', 'MDTM', 'SIZE', 'MLST type*;size*;modify*;', 'UTF8'], 'End');
      case 'OPTS': return this.reply(200, /^UTF8/i.test(arg) ? 'Always in UTF8 mode.' : 'OK.');
      case 'NOOP': case 'CLNT': return this.reply(200, 'OK.');
      case 'HELP': return this.reply(214, 'USER PASS PWD CWD CDUP LIST NLST MLSD MLST STOR RETR DELE RNFR RNTO SIZE MDTM PASV EPSV TYPE QUIT');
      case 'QUIT': this.reply(221, 'Goodbye.'); return this.socket.end();
      case 'TYPE': return /^[AI]/i.test(arg) ? this.reply(200, `Type set to ${arg.toUpperCase()}.`) : this.reply(504, 'Only TYPE A and I.');
      case 'MODE': return /^S$/i.test(arg) ? this.reply(200, 'Mode S.') : this.reply(504, 'Only stream mode.');
      case 'STRU': return /^F$/i.test(arg) ? this.reply(200, 'Structure F.') : this.reply(504, 'Only file structure.');
      case 'ALLO': return this.reply(202, 'No storage allocation necessary.');
      case 'REST': return arg.trim() === '0' ? this.reply(350, 'Restarting at 0.') : this.reply(502, 'Resume is not supported.');
      case 'ABOR': this.closePasv(); return this.reply(226, 'Aborted.');
      case 'PORT': case 'EPRT': return this.reply(502, 'Active mode is not supported - use passive mode.');
      case 'PWD': case 'XPWD': return this.reply(257, `"${this.cwd}" is the current directory.`);
      case 'CWD': case 'XCWD': case 'CDUP': case 'XCUP': {
        const d = this.resolve(verb.includes('UP') ? '..' : arg);
        if (!d || d.name) return this.reply(550, 'No such directory (use /inbox or /outbox).');
        this.cwd = d.path;
        return this.reply(250, `Directory changed to ${this.cwd}.`);
      }
      case 'PASV': {
        const port = await this.openPasv();
        const host = String(this.socket.localAddress || FTP_HOST).replace(/^::ffff:/, '').replace('::1', '127.0.0.1');
        return this.reply(227, `Entering Passive Mode (${host.split('.').join(',')},${port >> 8},${port & 255}).`);
      }
      case 'EPSV': {
        const port = await this.openPasv();
        return this.reply(229, `Entering Extended Passive Mode (|||${port}|).`);
      }
      case 'LIST': case 'NLST': case 'MLSD': {
        const d = this.resolve(arg.replace(/^-\w+\s*/, ''));
        if (!d || d.name) { this.closePasv(); return this.reply(550, 'No such directory.'); }
        const list = this.entries(d);
        const text = verb === 'NLST' ? list.map(e => e.name)
          : verb === 'MLSD' ? list.map(e => `type=${e.isDir ? 'dir' : 'file'};${e.isDir ? '' : `size=${e.st.size};`}modify=${ftpTime(e.st.mtime)}; ${e.name}`)
          : list.map(e => listLine(e.name, e.st, e.isDir));
        return this.sendData(text.map(l => l + '\r\n').join(''));
      }
      case 'MLST': {
        const d = this.resolve(arg);
        if (!d || (d.name && !(d.real && existsSync(d.real)))) return this.reply(550, 'Not found.');
        const st = statSync(d.real);
        return this.replyLines(250, 'Listing', [`type=${d.name ? 'file' : 'dir'};${d.name ? `size=${st.size};` : ''}modify=${ftpTime(st.mtime)}; ${d.path}`], 'End');
      }
      case 'SIZE': case 'MDTM': {
        const d = this.resolve(arg);
        if (!d?.real || !d.name || !existsSync(d.real)) return this.reply(550, 'File not found.');
        const st = statSync(d.real);
        return this.reply(213, verb === 'SIZE' ? String(st.size) : ftpTime(st.mtime));
      }
      case 'RETR': {
        const d = this.resolve(arg);
        if (!d?.real || !d.name || !existsSync(d.real)) { this.closePasv(); return this.reply(550, 'File not found.'); }
        const s = await this.dataSocket();
        if (!s) return this.reply(425, 'Use PASV or EPSV first.');
        this.reply(150, `Sending ${d.name}.`);
        await new Promise(res => createReadStream(d.real).on('error', () => { s.destroy(); res(); }).pipe(s).on('finish', res).on('close', res));
        return this.reply(226, 'Transfer complete.');
      }
      case 'STOR': {
        const d = this.resolve(arg);
        if (!d?.name) { this.closePasv(); return this.reply(553, 'Invalid file name.'); }
        if (d.folder !== 'inbox') { this.closePasv(); return this.reply(553, 'Uploads are only allowed in /inbox.'); }
        const s = await this.dataSocket();
        if (!s) return this.reply(425, 'Use PASV or EPSV first.');
        this.reply(150, `Ready to receive ${d.name}.`);
        const tmp = join(this.account.dirs.inbox, `.${d.name}.part`);
        const ok = await new Promise(res => {
          let size = 0;
          const out = createWriteStream(tmp);
          s.on('data', chunk => { size += chunk.length; if (size > MAX_FILE_BYTES) { s.destroy(); out.destroy(); res(false); } });
          s.pipe(out);
          out.on('finish', () => res(true));
          out.on('error', () => res(false));
        });
        if (!ok) { try { unlinkSync(tmp); } catch {} return this.reply(552, `Upload failed or larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`); }
        renameSync(tmp, d.real);
        this.reply(226, `Received ${d.name} - it will be processed now; the acknowledgement appears in /outbox.`);
        const { supplier, user } = this.account;
        if (!openDelivery(supplier.id, d.name))
          createDelivery({ supplierId: supplier.id, channel: 'ftp', username: user.username, originalName: d.name, fileName: d.name });
        console.log(`[ftp] ${user.username} uploaded ${d.name}`);
        processSupplierInboxes({ supplierId: supplier.id, force: true }).catch(() => {});
        return;
      }
      case 'DELE': {
        const d = this.resolve(arg);
        if (!d?.real || !d.name || !existsSync(d.real)) return this.reply(550, 'File not found.');
        unlinkSync(d.real);
        return this.reply(250, `Deleted ${d.name}.`);
      }
      case 'RNFR': {
        const d = this.resolve(arg);
        if (!d?.real || !d.name || !existsSync(d.real) || d.folder !== 'inbox') return this.reply(550, 'Only files in /inbox can be renamed.');
        this.renameFrom = d;
        return this.reply(350, 'Ready for RNTO.');
      }
      case 'RNTO': {
        const d = this.resolve(arg);
        const from = this.renameFrom;
        this.renameFrom = null;
        if (!from || !d?.name || d.folder !== 'inbox') return this.reply(553, 'Rename only within /inbox.');
        renameSync(from.real, d.real);
        return this.reply(250, 'Renamed.');
      }
      case 'MKD': case 'XMKD': case 'RMD': case 'XRMD':
        return this.reply(550, 'Folders cannot be created or removed.');
      default:
        return this.reply(502, `${verb} is not implemented.`);
    }
  }
}

export function startFtpServer() {
  if (!FTP_PORT) return null;
  const server = net.createServer(socket => new FtpSession(socket));
  server.on('error', e => console.warn(`[ftp] ${e.code === 'EADDRINUSE' ? `port ${FTP_PORT} is already in use` : e.message} - supplier FTP is not available`));
  server.listen(FTP_PORT, FTP_HOST, () => console.log(`[ftp] supplier FTP server on ftp://${FTP_HOST}:${FTP_PORT} (log in with a supplier account)`));
  return server;
}
