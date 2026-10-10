/**
 * Publishing with synchronisation awareness.
 *
 * Each target keeps a ledger - the content hash of every file this app last
 * uploaded there. Publishing builds the site, hashes the output, and diffs it
 * against the ledger to produce a plan: upload what is new or changed, skip
 * what is identical, and (if the target allows it) remove files the site no
 * longer contains. The plan is shown before anything is sent, and the ledger
 * is updated per file, so an interrupted publish resumes where it stopped.
 *
 * The ledger only ever lists files this app uploaded, so pruning can never
 * touch files someone else put on the server.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { DeployPlan, DeployProgress, DeployResult, DeployTarget, PlanItem } from '../../shared/types';
import type { BuildService } from './BuildService';
import type { ProjectService } from './ProjectService';
import { Credentials, Transport, TransportFactory } from '../transports/Transport';
import { FolderTransport } from '../transports/FolderTransport';
import { FtpTransport } from '../transports/FtpTransport';
import { SftpTransport } from '../transports/SftpTransport';

/** Stores secrets outside the project. The app backs this with the OS credential vault. */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | null): Promise<void>;
}

interface Ledger {
  publishedAt: number | null;
  files: Record<string, { hash: string; size: number }>;
}

export const defaultTransportFactory: TransportFactory = (target, credentials) => {
  switch (target.protocol) {
    case 'sftp':
      return new SftpTransport(target, credentials);
    case 'ftp':
    case 'ftps':
      return new FtpTransport(target, credentials);
    case 'folder':
      return new FolderTransport(target);
  }
};

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    fs.createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

export class DeployService {
  private running = false;

  constructor(
    private readonly project: ProjectService,
    private readonly builder: BuildService,
    private readonly secrets: SecretStore,
    private readonly makeTransport: TransportFactory = defaultTransportFactory,
  ) {}

  // ---------------------------------------------------------------- secrets

  private secretKey(targetId: string): string {
    return `${this.project.root}::${targetId}`;
  }

  setPassword(targetId: string, password: string | null): Promise<void> {
    return this.secrets.set(this.secretKey(targetId), password);
  }

  async hasPassword(targetId: string): Promise<boolean> {
    return (await this.secrets.get(this.secretKey(targetId))) !== null;
  }

  private async credentialsFor(target: DeployTarget, override?: string): Promise<Credentials> {
    const secret = override ?? (await this.secrets.get(this.secretKey(target.id))) ?? undefined;
    if (target.protocol === 'folder') return {};
    if (target.auth === 'key') {
      if (!target.keyPath) throw new Error('Choose a private key file for this destination.');
      return { privateKey: await fsp.readFile(target.keyPath, 'utf8'), passphrase: secret };
    }
    if (!secret) throw new Error('Enter the password for this destination.');
    return { password: secret };
  }

  // ----------------------------------------------------------------- ledger

  private ledgerPath(targetId: string): string {
    return this.project.stateFile(`publish-${targetId.replace(/[^\w-]/g, '_')}.json`);
  }

  private async readLedger(targetId: string): Promise<Ledger> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.ledgerPath(targetId), 'utf8'));
      return { publishedAt: raw.publishedAt ?? null, files: raw.files ?? {} };
    } catch {
      return { publishedAt: null, files: {} };
    }
  }

  private async writeLedger(targetId: string, ledger: Ledger): Promise<void> {
    const path = this.ledgerPath(targetId);
    await fsp.mkdir(nodePath.dirname(path), { recursive: true });
    await fsp.writeFile(path, JSON.stringify(ledger, null, 1), 'utf8');
  }

  /** Forgets what was uploaded, so the next publish sends everything. */
  async resetLedger(targetId: string): Promise<void> {
    await fsp.rm(this.ledgerPath(targetId), { force: true });
  }

  // ------------------------------------------------------------------- plan

  private target(targetId: string): DeployTarget {
    const target = this.project.manifest.targets.find((t) => t.id === targetId);
    if (!target) throw new Error('That destination no longer exists.');
    return target;
  }

  /** Builds the site and works out what a publish would do, without connecting. */
  async plan(targetId: string, force: boolean, overlays: Record<string, string> = {}): Promise<DeployPlan> {
    const target = this.target(targetId);
    const build = await this.builder.build(overlays);
    const ledger = await this.readLedger(targetId);
    const outAbs = this.project.abs(build.outDir);
    const items: PlanItem[] = [];
    let uploadBytes = 0;

    for (const file of build.files) {
      const abs = nodePath.join(outAbs, file);
      const size = (await fsp.stat(abs)).size;
      const known = ledger.files[file];
      let reason: PlanItem['reason'];
      if (force) reason = 'forced';
      else if (!known) reason = 'new';
      else if (known.size !== size || known.hash !== (await hashFile(abs))) reason = 'changed';
      else reason = 'unchanged';
      const action = reason === 'unchanged' ? 'skip' : 'upload';
      if (action === 'upload') uploadBytes += size;
      items.push({ path: file, action, size, reason });
    }

    if (target.prune) {
      const current = new Set(build.files);
      for (const file of Object.keys(ledger.files)) {
        if (!current.has(file)) items.push({ path: file, action: 'delete', size: ledger.files[file].size, reason: 'removed locally' });
      }
    }

    return { targetId, items, uploadBytes, build, lastPublished: ledger.publishedAt };
  }

  // ---------------------------------------------------------------- publish

  async test(target: DeployTarget, password?: string): Promise<{ ok: boolean; message: string }> {
    let transport: Transport | null = null;
    try {
      transport = this.makeTransport(target, await this.credentialsFor(target, password));
      await transport.connect();
      return { ok: true, message: target.protocol === 'folder' ? 'The folder is writable.' : `Connected to ${target.host}.` };
    } catch (err) {
      return { ok: false, message: explain(err) };
    } finally {
      await transport?.close().catch(() => undefined);
    }
  }

  async publish(targetId: string, force: boolean, onProgress: (p: DeployProgress) => void, overlays: Record<string, string> = {}): Promise<DeployResult> {
    if (this.running) return { ok: false, uploaded: 0, deleted: 0, failed: [], message: 'A publish is already running.' };
    this.running = true;
    const failed: DeployResult['failed'] = [];
    let uploaded = 0;
    let deleted = 0;
    let transport: Transport | null = null;
    try {
      const target = this.target(targetId);
      const plan = await this.plan(targetId, force, overlays);
      const blocking = plan.build.issues.filter((i) => i.severity === 'error');
      if (blocking.length) {
        return { ok: false, uploaded, deleted, failed, message: `The site has ${blocking.length} build error${blocking.length === 1 ? '' : 's'}. Fix them before publishing. First: ${blocking[0].file}: ${blocking[0].message}` };
      }
      const work = plan.items.filter((i) => i.action !== 'skip');
      const total = work.length;
      if (!total) {
        onProgress({ targetId, phase: 'done', done: 0, total: 0, message: 'Everything is already up to date.' });
        return { ok: true, uploaded, deleted, failed, message: 'Everything is already up to date.' };
      }

      onProgress({ targetId, phase: 'connecting', done: 0, total });
      transport = this.makeTransport(target, await this.credentialsFor(target));
      await transport.connect();

      const ledger = await this.readLedger(targetId);
      const outAbs = this.project.abs(plan.build.outDir);
      let done = 0;
      for (const item of work) {
        onProgress({ targetId, phase: item.action === 'delete' ? 'deleting' : 'uploading', path: item.path, done, total });
        try {
          if (item.action === 'upload') {
            const abs = nodePath.join(outAbs, item.path);
            await transport.put(abs, item.path);
            ledger.files[item.path] = { hash: await hashFile(abs), size: item.size };
            uploaded++;
          } else {
            await transport.remove(item.path);
            delete ledger.files[item.path];
            deleted++;
          }
        } catch (err) {
          failed.push({ path: item.path, message: explain(err) });
        }
        done++;
        // Persist progress periodically so an interrupted publish can resume.
        if (done % 25 === 0) await this.writeLedger(targetId, ledger);
      }
      if (!failed.length) ledger.publishedAt = Date.now();
      await this.writeLedger(targetId, ledger);

      const ok = failed.length === 0;
      const message = ok ? `Published ${uploaded} file${uploaded === 1 ? '' : 's'}${deleted ? `, removed ${deleted}` : ''}.` : `${failed.length} file${failed.length === 1 ? '' : 's'} could not be sent.`;
      onProgress({ targetId, phase: ok ? 'done' : 'error', done, total, message });
      return { ok, uploaded, deleted, failed, message };
    } catch (err) {
      const message = explain(err);
      onProgress({ targetId, phase: 'error', done: 0, total: 0, message });
      return { ok: false, uploaded, deleted, failed, message };
    } finally {
      await transport?.close().catch(() => undefined);
      this.running = false;
    }
  }
}

/** Rewrites the most common connection failures into something actionable. */
export function explain(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { level?: string };
  const text = e?.message ?? String(err);
  if (e?.code === 'ENOTFOUND') return 'The server name could not be found. Check the host.';
  if (e?.code === 'ECONNREFUSED') return 'The server refused the connection. Check the port and protocol.';
  if (e?.code === 'ETIMEDOUT' || /timed out/i.test(text)) return 'The server did not answer in time. Check the host, port and your network.';
  if (/authentication|530|login/i.test(text)) return 'The server rejected the user name, password or key.';
  if (e?.code === 'EACCES' || /permission denied|550/i.test(text)) return `The server would not allow that (${text}). Check the remote folder and its permissions.`;
  return text;
}
