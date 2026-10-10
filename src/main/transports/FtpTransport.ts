import { Client } from 'basic-ftp';

import type { DeployTarget } from '../../shared/types';
import { Credentials, Transport, remoteDir, remoteJoin } from './Transport';

/** FTP and explicit FTPS (FTP over TLS). */
export class FtpTransport implements Transport {
  private client = new Client(20000);
  private madeDirs = new Set<string>();
  private home = '/';

  constructor(
    private readonly target: DeployTarget,
    private readonly credentials: Credentials,
  ) {}

  async connect(): Promise<void> {
    await this.client.access({
      host: this.target.host,
      port: this.target.port || 21,
      user: this.target.user,
      password: this.credentials.password ?? '',
      secure: this.target.protocol === 'ftps',
    });
    this.home = await this.client.pwd();
  }

  async put(local: string, rel: string): Promise<void> {
    const remote = remoteJoin(this.target.remoteRoot, rel);
    const dir = remoteDir(remote);
    if (!this.madeDirs.has(dir)) {
      // ensureDir changes the working directory, so return home afterwards to
      // keep relative remote roots meaningful.
      await this.client.cd(this.home);
      await this.client.ensureDir(dir);
      await this.client.cd(this.home);
      this.madeDirs.add(dir);
    }
    await this.client.uploadFrom(local, remote);
  }

  async remove(rel: string): Promise<void> {
    await this.client.remove(remoteJoin(this.target.remoteRoot, rel), true);
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
