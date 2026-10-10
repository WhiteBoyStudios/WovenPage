import SftpClient from 'ssh2-sftp-client';

import type { DeployTarget } from '../../shared/types';
import { Credentials, Transport, remoteDir, remoteJoin } from './Transport';

export class SftpTransport implements Transport {
  private client = new SftpClient('wovenpage');
  private madeDirs = new Set<string>();

  constructor(
    private readonly target: DeployTarget,
    private readonly credentials: Credentials,
  ) {}

  async connect(): Promise<void> {
    await this.client.connect({
      host: this.target.host,
      port: this.target.port || 22,
      username: this.target.user,
      password: this.target.auth === 'password' ? this.credentials.password : undefined,
      privateKey: this.target.auth === 'key' ? this.credentials.privateKey : undefined,
      passphrase: this.target.auth === 'key' ? this.credentials.passphrase : undefined,
      readyTimeout: 20000,
    });
  }

  async put(local: string, rel: string): Promise<void> {
    const remote = remoteJoin(this.target.remoteRoot, rel);
    const dir = remoteDir(remote);
    if (!this.madeDirs.has(dir)) {
      if (!(await this.client.exists(dir))) await this.client.mkdir(dir, true);
      this.madeDirs.add(dir);
    }
    await this.client.put(local, remote);
  }

  async remove(rel: string): Promise<void> {
    await this.client.delete(remoteJoin(this.target.remoteRoot, rel), true);
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => undefined);
  }
}
