/**
 * What the publisher needs from a remote: connect, put a file, remove a file.
 * Each protocol is one small class behind this interface, so adding another
 * (S3, WebDAV, rsync) does not touch the planning or ledger logic.
 */

import type { DeployTarget } from '../../shared/types';

export interface Credentials {
  password?: string;
  /** Contents of a private key file, for SFTP key authentication. */
  privateKey?: string;
  passphrase?: string;
}

export interface Transport {
  connect(): Promise<void>;
  /** Uploads a local file to a path relative to the target's remote root, creating folders as needed. */
  put(localAbsolutePath: string, remoteRelativePath: string): Promise<void>;
  /** Removes a remote file. Must not fail if the file is already gone. */
  remove(remoteRelativePath: string): Promise<void>;
  close(): Promise<void>;
}

export type TransportFactory = (target: DeployTarget, credentials: Credentials) => Transport;

/** Joins the remote root and a site-relative path into a POSIX remote path. */
export function remoteJoin(root: string, rel: string): string {
  const cleanRel = rel.replace(/^\/+/, '');
  const trimmed = root.trim().replace(/\\/g, '/');
  if (trimmed === '' || trimmed === '.') return `./${cleanRel}`;
  const base = trimmed.replace(/\/+$/, '');
  if (base === '') return `/${cleanRel}`;
  if (base.startsWith('/') || base.startsWith('./') || base.startsWith('~')) return `${base}/${cleanRel}`;
  return `./${base}/${cleanRel}`;
}

export function remoteDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? (path.startsWith('/') ? '/' : '.') : path.slice(0, i);
}
