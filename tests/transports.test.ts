/**
 * Exercises the real FTP and SFTP transports against small in-process servers,
 * so publishing is tested over the actual wire protocols without needing a
 * network or an installed server.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import ssh2 from 'ssh2';

import { ProjectService } from '../src/main/services/ProjectService';
import { BuildService } from '../src/main/services/BuildService';
import { DeployService, SecretStore } from '../src/main/services/DeployService';
import type { DeployTarget } from '../src/shared/types';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wovenpage-transport-'));

class MemorySecrets implements SecretStore {
  private map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string | null) {
    if (value === null) this.map.delete(key);
    else this.map.set(key, value);
  }
}

/** Maps a remote path onto the server's root folder, refusing to leave it. */
function jail(root: string, cwd: string, remote: string): string {
  const posix = remote.startsWith('/') ? remote : path.posix.join(cwd, remote);
  const full = path.join(root, path.posix.normalize(posix));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('outside root');
  return full;
}

// ------------------------------------------------------------- FTP server

interface FtpLog {
  commands: string[];
}

function startFtp(root: string, user: string, password: string): Promise<{ port: number; log: FtpLog; close: () => Promise<void> }> {
  const log: FtpLog = { commands: [] };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A client that drops the connection without QUIT surfaces as ECONNRESET on Windows.
    socket.on('error', () => undefined);
    let cwd = '/';
    let authed = false;
    let name = '';
    let passive: net.Server | null = null;
    let dataSocket: Promise<net.Socket> | null = null;
    const say = (line: string) => socket.write(line + '\r\n');
    say('220 Test FTP ready');

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        void handle(line);
      }
    });

    async function handle(line: string) {
      const space = line.indexOf(' ');
      const cmd = (space === -1 ? line : line.slice(0, space)).toUpperCase();
      const arg = space === -1 ? '' : line.slice(space + 1);
      log.commands.push(cmd === 'PASS' ? 'PASS ***' : line);
      try {
        switch (cmd) {
          case 'USER':
            name = arg;
            return say('331 Password required');
          case 'PASS':
            authed = name === user && arg === password;
            return say(authed ? '230 Logged in' : '530 Login incorrect');
          case 'FEAT':
            return say('211-Features\r\n EPSV\r\n UTF8\r\n211 End');
          case 'SYST':
            return say('215 UNIX Type: L8');
          case 'OPTS':
          case 'TYPE':
          case 'STRU':
          case 'MODE':
          case 'NOOP':
            return say('200 OK');
          case 'QUIT':
            say('221 Bye');
            return socket.end();
        }
        if (!authed) return say('530 Not logged in');
        switch (cmd) {
          case 'PWD':
            return say(`257 "${cwd}" is the current directory`);
          case 'CWD': {
            const target = jail(root, cwd, arg);
            if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return say('550 No such directory');
            cwd = arg.startsWith('/') ? path.posix.normalize(arg) : path.posix.join(cwd, arg);
            return say('250 OK');
          }
          case 'MKD':
            fs.mkdirSync(jail(root, cwd, arg));
            return say(`257 "${arg}" created`);
          case 'EPSV':
          case 'PASV': {
            passive?.close();
            passive = net.createServer();
            passive.on('error', () => undefined);
            dataSocket = new Promise((resolve) =>
              passive!.once('connection', (data) => {
                data.on('error', () => undefined);
                resolve(data);
              }),
            );
            await new Promise<void>((resolve) => passive!.listen(0, '127.0.0.1', resolve));
            const port = (passive.address() as net.AddressInfo).port;
            return say(cmd === 'EPSV' ? `229 Entering Extended Passive Mode (|||${port}|)` : `227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
          }
          case 'STOR': {
            if (!dataSocket) return say('425 Use PASV first');
            const target = jail(root, cwd, arg);
            if (!fs.existsSync(path.dirname(target))) return say('553 No such directory');
            say('150 Ready for data');
            const data = await dataSocket;
            const out = fs.createWriteStream(target);
            data.pipe(out);
            await new Promise((resolve) => out.on('close', resolve));
            passive?.close();
            passive = null;
            dataSocket = null;
            return say('226 Transfer complete');
          }
          case 'DELE': {
            const target = jail(root, cwd, arg);
            if (!fs.existsSync(target)) return say('550 No such file');
            fs.unlinkSync(target);
            return say('250 Deleted');
          }
          default:
            return say('502 Not implemented');
        }
      } catch (err) {
        say(`550 ${(err as Error).message}`);
      }
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        log,
        close: () =>
          new Promise<void>((done) => {
            sockets.forEach((s) => s.destroy());
            server.close(() => done());
          }),
      }),
    );
  });
}

// ------------------------------------------------------------ SFTP server

function startSftp(root: string, user: string, password: string): Promise<{ port: number; ops: string[]; close: () => Promise<void> }> {
  const { STATUS_CODE } = ssh2.utils.sftp;
  const ops: string[] = [];
  const hostKey = ssh2.utils.generateKeyPairSync('ed25519').private;
  const clients = new Set<ssh2.Connection>();
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === user && ctx.password === password) ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        acceptSession().on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, number>();
          let next = 0;
          const local = (remote: string) => jail(root, '/home', remote);
          const attrs = (stat: fs.Stats) => ({ mode: stat.mode, uid: 0, gid: 0, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });
          const guard = (reqid: number, fn: () => void) => {
            try {
              fn();
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              sftp.status(reqid, code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE);
            }
          };
          const statLike = (reqid: number, remote: string) => guard(reqid, () => sftp.attrs(reqid, attrs(fs.statSync(local(remote)))));

          sftp.on('REALPATH', (reqid, remote) => {
            const resolved = remote.startsWith('/') ? path.posix.normalize(remote) : path.posix.join('/home', remote);
            sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} as ssh2.Attributes }]);
          });
          sftp.on('STAT', statLike);
          sftp.on('LSTAT', statLike);
          sftp.on('MKDIR', (reqid, remote) =>
            guard(reqid, () => {
              ops.push(`mkdir ${remote}`);
              fs.mkdirSync(local(remote));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('OPEN', (reqid, remote) =>
            guard(reqid, () => {
              ops.push(`put ${remote}`);
              const fd = fs.openSync(local(remote), 'w');
              const id = next++;
              handles.set(id, fd);
              const handle = Buffer.alloc(4);
              handle.writeUInt32BE(id, 0);
              sftp.handle(reqid, handle);
            }),
          );
          sftp.on('WRITE', (reqid, handle, offset, data) =>
            guard(reqid, () => {
              fs.writeSync(handles.get(handle.readUInt32BE(0))!, data, 0, data.length, offset);
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('FSTAT', (reqid, handle) => guard(reqid, () => sftp.attrs(reqid, attrs(fs.fstatSync(handles.get(handle.readUInt32BE(0))!)))));
          sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on('CLOSE', (reqid, handle) =>
            guard(reqid, () => {
              const id = handle.readUInt32BE(0);
              fs.closeSync(handles.get(id)!);
              handles.delete(id);
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
          sftp.on('REMOVE', (reqid, remote) =>
            guard(reqid, () => {
              ops.push(`remove ${remote}`);
              fs.unlinkSync(local(remote));
              sftp.status(reqid, STATUS_CODE.OK);
            }),
          );
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        ops,
        close: () =>
          new Promise<void>((done) => {
            clients.forEach((c) => c.end());
            server.close(() => done());
          }),
      }),
    );
  });
}

// ------------------------------------------------------------------ tests

async function siteWith(target: DeployTarget, password: string): Promise<{ project: ProjectService; deploy: DeployService }> {
  const project = await ProjectService.create(path.join(temp(), 'site'), 'Transport test', 'starter');
  await project.saveManifest({ ...project.manifest, targets: [target] });
  const deploy = new DeployService(project, new BuildService(project), new MemorySecrets());
  await deploy.setPassword(target.id, password);
  return { project, deploy };
}

/** Publishes, changes the site, publishes again; shared by both protocols. */
async function roundTrip(deploy: DeployService, project: ProjectService, id: string, remoteSite: string): Promise<void> {
  const first = await deploy.publish(id, false, () => undefined);
  assert.deepEqual([first.ok, first.failed, first.deleted], [true, [], 0], first.message ?? "");
  assert.equal(first.uploaded, 10);
  for (const file of ['index.html', 'classes.html', 'css/site.css', 'js/site.js', 'assets/shelf.svg']) {
    assert.equal(fs.readFileSync(path.join(remoteSite, file), 'utf8'), fs.readFileSync(path.join(project.root, '_site', file), 'utf8'), file);
  }
  assert.ok(!fs.existsSync(path.join(remoteSite, 'layouts')), 'authoring folders are not published');

  await project.write('css/site.css', project.readSync('css/site.css')! + '\n.new { color: red; }\n');
  await project.remove('visit.html');
  const second = await deploy.publish(id, false, () => undefined);
  assert.deepEqual([second.ok, second.uploaded, second.deleted], [true, 1, 1], second.message ?? "");
  assert.match(fs.readFileSync(path.join(remoteSite, 'css/site.css'), 'utf8'), /\.new \{ color: red; \}/);
  assert.ok(!fs.existsSync(path.join(remoteSite, 'visit.html')));

  const third = await deploy.publish(id, false, () => undefined);
  assert.equal(third.message, 'Everything is already up to date.');
}

test('FTP: publishes into a nested remote folder, then only the changes', async () => {
  const root = temp();
  const server = await startFtp(root, 'webmaster', 'p@ss word');
  try {
    const target: DeployTarget = { id: 'ftp', name: 'FTP', protocol: 'ftp', host: '127.0.0.1', port: server.port, user: 'webmaster', remoteRoot: 'sites/pottery', auth: 'password', prune: true };
    const { project, deploy } = await siteWith(target, 'p@ss word');
    assert.deepEqual(await deploy.test(target), { ok: true, message: 'Connected to 127.0.0.1.' });
    await roundTrip(deploy, project, 'ftp', path.join(root, 'sites/pottery'));
    assert.ok(server.log.commands.some((c) => c.startsWith('STOR ')));
    assert.ok(server.log.commands.some((c) => c.startsWith('DELE ')));

    const wrong = await deploy.test(target, 'not the password');
    assert.equal(wrong.ok, false);
    assert.equal(wrong.message, 'The server rejected the user name, password or key.');
  } finally {
    await server.close();
  }
});

test('SFTP: publishes into a nested remote folder, then only the changes', async () => {
  const root = temp();
  fs.mkdirSync(path.join(root, 'home'));
  const server = await startSftp(root, 'deploy', 'correct horse');
  try {
    const target: DeployTarget = { id: 'sftp', name: 'SFTP', protocol: 'sftp', host: '127.0.0.1', port: server.port, user: 'deploy', remoteRoot: 'public_html/pottery', auth: 'password', prune: true };
    const { project, deploy } = await siteWith(target, 'correct horse');
    assert.deepEqual(await deploy.test(target), { ok: true, message: 'Connected to 127.0.0.1.' });
    // A relative remote root is resolved from the folder the server puts the user in.
    await roundTrip(deploy, project, 'sftp', path.join(root, 'home/public_html/pottery'));
    assert.ok(server.ops.some((o) => o.startsWith('remove ') && o.endsWith('visit.html')));

    const wrong = await deploy.test(target, 'nope');
    assert.equal(wrong.ok, false);
    assert.equal(wrong.message, 'The server rejected the user name, password or key.');
  } finally {
    await server.close();
  }
});

test('an unreachable server is reported plainly and nothing is recorded as published', async () => {
  // Reserve a port, then close it, so the connection is refused.
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  const target: DeployTarget = { id: 'down', name: 'Down', protocol: 'ftp', host: '127.0.0.1', port, user: 'u', remoteRoot: '', auth: 'password', prune: false };
  const { deploy } = await siteWith(target, 'x');
  const result = await deploy.publish('down', false, () => undefined);
  assert.equal(result.ok, false);
  assert.equal(result.message, 'The server refused the connection. Check the port and protocol.');
  assert.equal((await deploy.plan('down', false)).lastPublished, null);
});
