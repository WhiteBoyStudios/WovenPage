/**
 * Per-user application state kept outside any project: theme, recent sites,
 * and publishing passwords. Passwords are encrypted with the operating
 * system's credential protection (DPAPI on Windows) before they touch disk;
 * if that is unavailable they are held in memory for the session only.
 */

import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

import type { AppSettings, RecentProject } from '../shared/types';
import type { SecretStore } from './services/DeployService';

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

export class SettingsStore {
  private file = nodePath.join(app.getPath('userData'), 'settings.json');
  private data: AppSettings;

  constructor() {
    const raw = readJson<Partial<AppSettings>>(this.file, {});
    this.data = {
      theme: raw.theme === 'indigo' ? 'indigo' : 'linen',
      recent: Array.isArray(raw.recent) ? raw.recent : [],
      initialProject: null,
    };
  }

  get(): AppSettings {
    // Drop recents whose folders have gone away.
    this.data.recent = this.data.recent.filter((r) => fs.existsSync(r.root));
    return this.data;
  }

  setTheme(theme: AppSettings['theme']): void {
    this.data.theme = theme;
    this.save();
  }

  noteOpened(project: Omit<RecentProject, 'opened'>): void {
    this.data.recent = [{ ...project, opened: Date.now() }, ...this.data.recent.filter((r) => r.root !== project.root)].slice(0, 12);
    this.save();
  }

  private save(): void {
    const { initialProject: _ignored, ...persisted } = this.data;
    writeJson(this.file, persisted);
  }
}

export class VaultSecretStore implements SecretStore {
  private file = nodePath.join(app.getPath('userData'), 'secrets.json');
  private memory = new Map<string, string>();

  private get canEncrypt(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    if (this.memory.has(key)) return this.memory.get(key)!;
    if (!this.canEncrypt) return null;
    const stored = readJson<Record<string, string>>(this.file, {})[key];
    if (!stored) return null;
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      return null;
    }
  }

  async set(key: string, value: string | null): Promise<void> {
    if (value === null) this.memory.delete(key);
    else this.memory.set(key, value);
    if (!this.canEncrypt) return;
    const all = readJson<Record<string, string>>(this.file, {});
    if (value === null) delete all[key];
    else all[key] = safeStorage.encryptString(value).toString('base64');
    writeJson(this.file, all);
  }
}
