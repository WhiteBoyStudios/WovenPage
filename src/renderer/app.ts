/**
 * Renderer entry point. Shows the start screen or the workbench for an open
 * site, and owns the handful of things that outlive a single site: Monaco's
 * configuration, completion providers, and the theme.
 */

import '@fontsource-variable/instrument-sans/index.css';
import '@fontsource/commit-mono/400.css';
import '@fontsource/commit-mono/700.css';
import './styles/app.css';

import type { AppSettings, ProjectInfo } from '../shared/types';
import { api, onEvent } from './core/api';
import { toast } from './core/ui';
import { registerCompletions } from './editor/completions';
import { setupMonaco } from './editor/monacoSetup';
import { Launcher } from './panels/Launcher';
import { Workbench } from './workbench/Workbench';

const root = document.getElementById('app')!;
let workbench: Workbench | null = null;
let settings: AppSettings;

async function showLauncher(): Promise<void> {
  workbench?.dispose();
  workbench = null;
  settings = await api.getSettings();
  root.replaceChildren(new Launcher(settings.recent, (project) => void showWorkbench(project)).el);
}

async function showWorkbench(project: ProjectInfo): Promise<void> {
  workbench?.dispose();
  workbench = new Workbench(project, settings, () => void showLauncher());
  root.replaceChildren(workbench.el);
  try {
    await workbench.start();
  } catch (err) {
    toast(`The site could not be loaded: ${(err as Error).message}`, { kind: 'error' });
  }
}

async function main(): Promise<void> {
  setupMonaco();
  settings = await api.getSettings();
  document.documentElement.dataset.theme = settings.theme;
  registerCompletions(
    () => workbench?.index() ?? null,
    (path) => workbench?.docs.text(path) ?? null,
  );

  // With no site open, the only menu commands that mean anything open one.
  onEvent('menu:command', (id) => {
    if (workbench) return;
    if (id === 'file.openSite') void api.openProjectDialog().then((p) => p && showWorkbench(p)).catch((e) => toast(e.message, { kind: 'error' }));
    else if (id === 'view.theme') {
      settings.theme = settings.theme === 'linen' ? 'indigo' : 'linen';
      document.documentElement.dataset.theme = settings.theme;
      void api.setTheme(settings.theme);
    }
  });
  onEvent('app:save-and-close', () => {
    if (!workbench) void api.closeWindowNow();
  });

  if (settings.initialProject) {
    try {
      return await showWorkbench(await api.openProject(settings.initialProject));
    } catch (err) {
      toast(`Could not open ${settings.initialProject}: ${(err as Error).message}`, { kind: 'error' });
    }
  }
  await showLauncher();
}

void main();
