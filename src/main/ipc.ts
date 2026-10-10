/**
 * Implements the renderer-facing Api on top of the services. One site is open
 * per window; `Session` bundles the services that belong to it.
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';

import { API_METHODS, Api, ApiEvents, IPC_EVENT, IPC_INVOKE } from '../shared/ipc';
import { normalize } from '../shared/paths';
import type { ProjectChange, ProjectInfo } from '../shared/types';
import { BuildService } from './services/BuildService';
import { DeployService } from './services/DeployService';
import { LintService } from './services/LintService';
import { PreviewServer } from './services/PreviewServer';
import { ProjectService } from './services/ProjectService';
import { SearchService } from './services/SearchService';
import type { SettingsStore, VaultSecretStore } from './settings';

interface Session {
  project: ProjectService;
  preview: PreviewServer;
  search: SearchService;
  builder: BuildService;
  lint: LintService;
  deploy: DeployService;
}

export interface IpcContext {
  window: () => BrowserWindow | null;
  settings: SettingsStore;
  secrets: VaultSecretStore;
  /** Directory holding the built canvas scripts (agent.js, live.js). */
  canvasDir: string;
  onDirtyCount: (count: number) => void;
  closeNow: () => void;
}

export class AppIpc {
  private session: Session | null = null;

  constructor(private readonly ctx: IpcContext) {}

  get previewOrigin(): string | null {
    return this.session?.preview.origin ?? null;
  }

  send<K extends keyof ApiEvents>(event: K, payload: ApiEvents[K]): void {
    const win = this.ctx.window();
    if (win && !win.isDestroyed()) win.webContents.send(IPC_EVENT, event, payload);
  }

  register(): void {
    const api = this.implementation();
    ipcMain.handle(IPC_INVOKE, async (event, method: keyof Api, args: unknown[]) => {
      // Only the workbench itself may call in - never a previewed page.
      const win = this.ctx.window();
      if (!win || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame.url.startsWith('wp://app/')) {
        throw new Error('Rejected a call from an unexpected frame.');
      }
      if (!API_METHODS.includes(method)) throw new Error(`Unknown method "${String(method)}".`);
      const fn = api[method] as (...a: unknown[]) => Promise<unknown>;
      return fn(...(Array.isArray(args) ? args : []));
    });
  }

  async dispose(): Promise<void> {
    await this.endSession();
  }

  private need(): Session {
    if (!this.session) throw new Error('No site is open.');
    return this.session;
  }

  private async endSession(): Promise<void> {
    const s = this.session;
    this.session = null;
    if (!s) return;
    s.project.dispose();
    await s.preview.stop();
  }

  private async startSession(project: ProjectService): Promise<ProjectInfo> {
    await this.endSession();
    const read = (name: string) => () => {
      try {
        return fs.readFileSync(nodePath.join(this.ctx.canvasDir, name), 'utf8');
      } catch {
        return `console.error("Wovenpage: ${name} has not been built.")`;
      }
    };
    const preview = new PreviewServer(project, { agent: read('agent.js'), live: read('live.js') });
    await preview.start();
    const builder = new BuildService(project);
    this.session = {
      project,
      preview,
      builder,
      search: new SearchService(project),
      lint: new LintService(project),
      deploy: new DeployService(project, builder, this.ctx.secrets),
    };
    project.on('changed', (change: ProjectChange) => {
      preview.notify(change.paths);
      this.send('project:changed', change);
    });
    project.watch();
    this.ctx.settings.noteOpened({ root: project.root, name: project.manifest.name });
    this.ctx.window()?.setTitle(`${project.manifest.name} - Wovenpage`);
    return { root: project.root, manifest: project.manifest, previewOrigin: preview.origin };
  }

  private implementation(): Api {
    const win = () => this.ctx.window()!;
    return {
      // ------------------------------------------------------ application
      getSettings: async () => this.ctx.settings.get(),
      setTheme: async (theme) => this.ctx.settings.setTheme(theme === 'indigo' ? 'indigo' : 'linen'),
      setDirtyCount: async (count) => this.ctx.onDirtyCount(Number(count) || 0),
      closeWindowNow: async () => this.ctx.closeNow(),
      openExternal: async (url) => {
        if (/^(https?:|mailto:)/i.test(url)) await shell.openExternal(url);
      },

      // ---------------------------------------------------------- project
      openProjectDialog: async () => {
        const picked = await dialog.showOpenDialog(win(), { title: 'Open a site folder', properties: ['openDirectory'] });
        if (picked.canceled || !picked.filePaths[0]) return null;
        return this.startSession(await ProjectService.open(picked.filePaths[0]));
      },
      openProject: async (root) => this.startSession(await ProjectService.open(root)),
      createProject: async (name, starter) => {
        const picked = await dialog.showOpenDialog(win(), {
          title: 'Choose an empty folder for the new site',
          buttonLabel: 'Create site here',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (picked.canceled || !picked.filePaths[0]) return null;
        return this.startSession(await ProjectService.create(picked.filePaths[0], name.trim() || 'New site', starter === 'blank' ? 'blank' : 'starter'));
      },
      closeProject: async () => {
        await this.endSession();
        this.ctx.window()?.setTitle('Wovenpage');
      },
      saveManifest: async (manifest) => {
        await this.need().project.saveManifest(manifest);
        this.ctx.window()?.setTitle(`${manifest.name} - Wovenpage`);
      },

      // ------------------------------------------------------------ files
      getTree: async () => this.need().project.tree(),
      getIndex: async (overlays) => this.need().project.index(overlays ?? {}),
      readFile: async (path) => this.need().project.read(path),
      writeFile: async (path, text) => this.need().project.write(path, text),
      statFile: async (path) => this.need().project.stat(path),
      createFile: async (path, content) => this.need().project.createFile(path, content),
      createFolder: async (path) => this.need().project.createFolder(path),
      renamePath: async (from, to, updateLinks) => this.need().project.rename(from, to, !!updateLinks),
      duplicatePath: async (path) => this.need().project.duplicate(path),
      deletePath: async (path) => {
        const { project } = this.need();
        if (!normalize(path)) throw new Error('The site folder itself cannot be deleted from here.');
        try {
          // Prefer the recycle bin so a slip is recoverable.
          await shell.trashItem(project.abs(path));
        } catch {
          await project.remove(path);
        }
      },
      importFilesDialog: async (destDir, kind) => {
        const { project } = this.need();
        const picked = await dialog.showOpenDialog(win(), {
          title: 'Add files to the site',
          buttonLabel: 'Add to site',
          properties: ['openFile', 'multiSelections'],
          filters:
            kind === 'media'
              ? [
                  { name: 'Images, video, audio and fonts', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'mp4', 'webm', 'ogv', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'woff', 'woff2', 'ttf', 'otf'] },
                  { name: 'All files', extensions: ['*'] },
                ]
              : [{ name: 'All files', extensions: ['*'] }],
        });
        if (picked.canceled) return [];
        return project.importFiles(picked.filePaths, destDir);
      },
      revealPath: async (path) => shell.showItemInFolder(this.need().project.abs(path)),
      pickFile: async (title) => {
        const picked = await dialog.showOpenDialog(win(), { title, properties: ['openFile', 'showHiddenFiles'] });
        return picked.canceled ? null : (picked.filePaths[0] ?? null);
      },
      pickFolder: async (title) => {
        const picked = await dialog.showOpenDialog(win(), { title, properties: ['openDirectory', 'createDirectory'] });
        return picked.canceled ? null : (picked.filePaths[0] ?? null);
      },

      // ---------------------------------------------------------- preview
      setOverlay: async (path, text) => this.need().preview.setOverlay(path, String(text)),
      clearOverlay: async (path) => this.need().preview.clearOverlay(path),
      openInBrowser: async (path) => {
        await shell.openExternal(this.need().preview.urlFor(path));
      },

      // --------------------------------------------- search, lint, build
      search: async (query, overlays) => this.need().search.search(query, overlays ?? {}),
      replaceInFiles: async (query, replacement, paths) => this.need().search.replaceInFiles(query, replacement, paths),
      lintProject: async (overlays) => this.need().lint.lintProject(overlays ?? {}),
      build: async (overlays) => this.need().builder.build(overlays ?? {}),

      // ------------------------------------------------------- publishing
      setTargetPassword: async (targetId, password) => this.need().deploy.setPassword(targetId, password),
      hasTargetPassword: async (targetId) => this.need().deploy.hasPassword(targetId),
      testTarget: async (target, password) => this.need().deploy.test(target, password),
      planPublish: async (targetId, force, overlays) => this.need().deploy.plan(targetId, !!force, overlays ?? {}),
      publish: async (targetId, force, overlays) =>
        this.need().deploy.publish(targetId, !!force, (progress) => this.send('deploy:progress', progress), overlays ?? {}),
      resetPublishHistory: async (targetId) => this.need().deploy.resetLedger(targetId),
    };
  }
}
