import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';

import type { DeployTarget } from '../../shared/types';
import type { Transport } from './Transport';

/** Publishes to a folder: a mounted network share, a synced drive, or a local web root. */
export class FolderTransport implements Transport {
  private root: string;

  constructor(target: DeployTarget) {
    this.root = nodePath.resolve(target.remoteRoot);
  }

  private resolve(rel: string): string {
    const full = nodePath.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + nodePath.sep)) throw new Error(`"${rel}" is outside the destination folder.`);
    return full;
  }

  async connect(): Promise<void> {
    if (!nodePath.isAbsolute(this.root) || this.root === nodePath.parse(this.root).root) {
      throw new Error('Choose a destination folder that is not a drive root.');
    }
    await fsp.mkdir(this.root, { recursive: true });
  }

  async put(local: string, rel: string): Promise<void> {
    const dest = this.resolve(rel);
    await fsp.mkdir(nodePath.dirname(dest), { recursive: true });
    await fsp.copyFile(local, dest);
  }

  async remove(rel: string): Promise<void> {
    await fsp.rm(this.resolve(rel), { force: true });
  }

  async close(): Promise<void> {}
}
