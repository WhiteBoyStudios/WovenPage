/**
 * Publish dialog: manage destinations (SFTP, FTP, FTPS or a folder), then
 * review exactly what a publish will upload, skip and remove before sending
 * anything.
 */

import type { DeployPlan, DeployProgress, DeployProtocol, DeployTarget, ProjectManifest } from '../../shared/types';
import { api, onEvent } from '../core/api';
import { clear, formatBytes, h } from '../core/dom';
import { icon } from '../core/icons';
import { confirmAction, emptyState, openModal } from '../core/ui';
import type { Shell } from '../workbench/Shell';

const DEFAULT_PORT: Record<DeployProtocol, number> = { sftp: 22, ftp: 21, ftps: 21, folder: 0 };
const PROTOCOL_LABEL: Record<DeployProtocol, string> = {
  sftp: 'SFTP (over SSH)',
  ftps: 'FTPS (FTP over TLS)',
  ftp: 'FTP (not encrypted)',
  folder: 'A folder on this computer or network',
};

function blankTarget(): DeployTarget {
  return { id: `t${Date.now().toString(36)}`, name: 'New destination', protocol: 'sftp', host: '', port: 22, user: '', remoteRoot: '', auth: 'password', prune: false };
}

export function openPublishDialog(shell: Shell): void {
  const manifest: ProjectManifest = structuredClone(shell.project.manifest);
  let selected: DeployTarget | null = manifest.targets[0] ?? null;
  let password = '';
  let passwordStored = false;
  let plan: DeployPlan | null = null;
  let busy = false;
  let dirty = false;

  const modal = openModal('Publish site', { wide: true, onClose: () => stopProgress() });
  const side = h('div.pub__side');
  const main = h('div.pub__main');
  modal.body.classList.add('pub');
  modal.body.append(side, main);

  const progressBar = h('div.pub__bar', null, h('div.pub__fill'));
  const progressText = h('p.pub__status', { role: 'status' });
  const stopProgress = onEvent('deploy:progress', (p: DeployProgress) => {
    if (!selected || p.targetId !== selected.id) return;
    const fill = progressBar.firstElementChild as HTMLElement;
    fill.style.width = p.total ? `${Math.round((p.done / p.total) * 100)}%` : p.phase === 'done' ? '100%' : '0%';
    progressText.textContent =
      p.phase === 'connecting' ? 'Connecting...' : p.phase === 'uploading' ? `Uploading ${p.path} (${p.done + 1} of ${p.total})` : p.phase === 'deleting' ? `Removing ${p.path}` : (p.message ?? '');
    progressText.classList.toggle('is-error', p.phase === 'error');
  });

  const saveManifest = async () => {
    await api.saveManifest(manifest);
    shell.project.manifest = structuredClone(manifest);
    dirty = false;
  };

  const saveTarget = async () => {
    if (!selected) return;
    await saveManifest();
    if (password) {
      await api.setTargetPassword(selected.id, password);
      passwordStored = true;
      password = '';
    }
  };

  const selectTarget = async (target: DeployTarget | null) => {
    selected = target;
    plan = null;
    password = '';
    passwordStored = target ? await api.hasTargetPassword(target.id).catch(() => false) : false;
    render();
  };

  function renderSide() {
    clear(side);
    side.append(h('h3', null, 'Destinations'));
    for (const target of manifest.targets) {
      side.append(
        h('button.pub__target', { type: 'button', class: target === selected ? 'is-active' : '', onclick: () => void selectTarget(target) },
          h('span.pub__targetname', null, target.name),
          h('span.pub__targethost', null, target.protocol === 'folder' ? target.remoteRoot || 'No folder chosen' : target.host || 'No host yet'),
        ),
      );
    }
    side.append(
      h('button.btn', {
        type: 'button',
        onclick: () => {
          const target = blankTarget();
          manifest.targets.push(target);
          dirty = true;
          void selectTarget(target);
        },
      }, 'Add destination'),
    );
  }

  function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return h('div.form__row', null, h('label', null, label), control, hint ? h('p.form__hint', null, hint) : null);
  }

  function renderMain() {
    clear(main);
    const target = selected;
    if (!target) {
      main.append(emptyState('Add a destination to publish this site to a web server over SFTP or FTP, or to a folder.'));
      return;
    }
    const isFolder = target.protocol === 'folder';
    const bind = (key: keyof DeployTarget, type = 'text', placeholder = '') => {
      const input = h<HTMLInputElement>('input', { type, value: String(target[key] ?? ''), placeholder, spellcheck: 'false', autocomplete: 'off' });
      input.addEventListener('input', () => {
        (target as unknown as Record<string, unknown>)[key] = type === 'number' ? Number(input.value) || 0 : input.value;
        dirty = true;
        plan = null;
        if (key === 'name' || key === 'host' || key === 'remoteRoot') renderSide();
      });
      return input;
    };

    const protocol = h<HTMLSelectElement>('select', null, (Object.keys(PROTOCOL_LABEL) as DeployProtocol[]).map((p) => h('option', { value: p }, PROTOCOL_LABEL[p])));
    protocol.value = target.protocol;
    protocol.addEventListener('change', () => {
      const previousDefault = DEFAULT_PORT[target.protocol];
      target.protocol = protocol.value as DeployProtocol;
      if (!target.port || target.port === previousDefault) target.port = DEFAULT_PORT[target.protocol];
      if (target.protocol !== 'sftp') target.auth = 'password';
      dirty = true;
      plan = null;
      render();
    });

    const form = h('div.form.pub__form');
    form.append(field('Name', bind('name')), field('Protocol', protocol, target.protocol === 'ftp' ? 'Plain FTP sends your password unencrypted. Use SFTP or FTPS if your host offers either.' : undefined));

    if (isFolder) {
      const folder = bind('remoteRoot', 'text', 'C:\\inetpub\\wwwroot\\my-site');
      form.append(
        field('Folder', h('div.pub__inline', null, folder, h('button.btn', {
          type: 'button',
          onclick: async () => {
            const picked = await api.pickFolder('Choose the destination folder');
            if (picked) {
              target.remoteRoot = picked;
              dirty = true;
              render();
            }
          },
        }, 'Browse')), 'The built site is copied here.'),
      );
    } else {
      form.append(
        h('div.pub__pair', null, field('Host', bind('host', 'text', 'example.com')), field('Port', bind('port', 'number'))),
        field('User name', bind('user')),
      );
      if (target.protocol === 'sftp') {
        const auth = h<HTMLSelectElement>('select', null, h('option', { value: 'password' }, 'Password'), h('option', { value: 'key' }, 'Private key file'));
        auth.value = target.auth;
        auth.addEventListener('change', () => {
          target.auth = auth.value as DeployTarget['auth'];
          dirty = true;
          render();
        });
        form.append(field('Sign in with', auth));
      }
      if (target.auth === 'key') {
        const key = bind('keyPath', 'text', 'C:\\Users\\you\\.ssh\\id_ed25519');
        form.append(
          field('Key file', h('div.pub__inline', null, key, h('button.btn', {
            type: 'button',
            onclick: async () => {
              const picked = await api.pickFile('Choose a private key file');
              if (picked) {
                target.keyPath = picked;
                dirty = true;
                render();
              }
            },
          }, 'Browse'))),
        );
      }
      const pass = h<HTMLInputElement>('input', { type: 'password', placeholder: passwordStored ? 'Saved. Type to replace it.' : '', autocomplete: 'off' });
      pass.addEventListener('input', () => {
        password = pass.value;
      });
      form.append(
        field(target.auth === 'key' ? 'Key passphrase (if any)' : 'Password', pass, 'Stored encrypted by Windows for your user account. It is never written into the site folder.'),
        field('Remote folder', bind('remoteRoot', 'text', 'public_html'), 'Where the site lives on the server. Leave empty to use the folder you land in after signing in.'),
      );
    }

    const prune = h<HTMLInputElement>('input', { type: 'checkbox', checked: target.prune, id: 'pub-prune' });
    prune.addEventListener('change', () => {
      target.prune = prune.checked;
      dirty = true;
      plan = null;
    });
    form.append(h('label.form__check', { for: 'pub-prune' }, prune, h('span', null, 'Remove files from the destination when they are removed from the site')), h('p.form__hint', null, 'Only files this app uploaded are ever removed.'));

    const testResult = h('p.pub__status', { role: 'status' });
    const actions = h('div.pub__actions', null,
      h('button.btn', {
        type: 'button',
        onclick: async () => {
          testResult.textContent = 'Testing...';
          testResult.classList.remove('is-error', 'is-ok');
          try {
            await saveTarget();
            const result = await api.testTarget(target, password || undefined);
            testResult.textContent = result.message;
            testResult.classList.add(result.ok ? 'is-ok' : 'is-error');
          } catch (err) {
            testResult.textContent = (err as Error).message;
            testResult.classList.add('is-error');
          }
        },
      }, 'Test connection'),
      h('button.btn.btn--danger', {
        type: 'button',
        onclick: async () => {
          if (!(await confirmAction(`Remove "${target.name}"?`, 'The destination and its saved password are removed from this site. Nothing on the server changes.', 'Remove destination', true))) return;
          manifest.targets = manifest.targets.filter((t) => t !== target);
          await api.setTargetPassword(target.id, null);
          await api.resetPublishHistory(target.id);
          await saveManifest();
          await selectTarget(manifest.targets[0] ?? null);
        },
      }, 'Remove'),
      testResult,
    );
    main.append(form, actions, renderPlan(target));
  }

  function renderPlan(target: DeployTarget): HTMLElement {
    const box = h('div.pub__plan');
    const review = async (force: boolean) => {
      busy = true;
      render();
      try {
        await saveTarget();
        await shell.docs.flushOverlays();
        plan = await api.planPublish(target.id, force, shell.docs.dirtyOverlays());
      } catch (err) {
        shell.notify((err as Error).message, 'error');
      } finally {
        busy = false;
        render();
      }
    };

    if (!plan) {
      box.append(
        h('div.pub__actions', null,
          h('button.btn.btn--primary', { type: 'button', disabled: busy, onclick: () => void review(false) }, busy ? 'Building...' : 'Review changes'),
          h('span.form__hint', null, 'Builds the site and compares it with what was last published here. Nothing is sent yet.'),
        ),
      );
      return box;
    }

    const uploads = plan.items.filter((i) => i.action === 'upload');
    const deletes = plan.items.filter((i) => i.action === 'delete');
    const skipped = plan.items.filter((i) => i.action === 'skip').length;
    const errors = plan.build.issues.filter((i) => i.severity === 'error');

    box.append(
      h('p.pub__summary', null,
        uploads.length || deletes.length
          ? `${uploads.length} to upload (${formatBytes(plan.uploadBytes)}), ${deletes.length} to remove, ${skipped} unchanged.`
          : `Everything is up to date. ${skipped} files match what was last published.`,
        plan.lastPublished ? ` Last published ${new Date(plan.lastPublished).toLocaleString()}.` : ' This destination has not been published to before.',
      ),
    );
    if (plan.build.issues.length) {
      box.append(
        h('div.pub__issues', { class: errors.length ? 'is-error' : '' },
          h('strong', null, errors.length ? 'Fix these before publishing:' : 'Warnings from the build:'),
          h('ul', null, plan.build.issues.slice(0, 8).map((i) => h('li', null, `${i.file}: ${i.message}`))),
        ),
      );
    }
    if (uploads.length || deletes.length) {
      box.append(
        h('div.pub__files', null,
          [...uploads, ...deletes].slice(0, 300).map((item) =>
            h('div.pub__file', { class: `is-${item.action}` }, h('span.pub__reason', null, item.action === 'delete' ? 'remove' : item.reason), h('span.pub__path', null, item.path), h('span.pub__size', null, formatBytes(item.size))),
          ),
        ),
      );
    }
    box.append(
      progressBar,
      progressText,
      h('div.pub__actions', null,
        h('button.btn.btn--primary', {
          type: 'button',
          disabled: busy || errors.length > 0 || (!uploads.length && !deletes.length),
          onclick: async () => {
            busy = true;
            render();
            try {
              const result = await api.publish(target.id, plan!.items.some((i) => i.reason === 'forced'), shell.docs.dirtyOverlays());
              progressText.textContent = result.message ?? '';
              progressText.classList.toggle('is-error', !result.ok);
              if (result.failed.length) shell.notify(`${result.failed.length} file(s) failed. First: ${result.failed[0].path}: ${result.failed[0].message}`, 'error');
              else if (result.ok) shell.notify(result.message ?? 'Published.', 'success');
              plan = null;
            } catch (err) {
              shell.notify((err as Error).message, 'error');
            } finally {
              busy = false;
              const message = progressText.textContent;
              render();
              progressText.textContent = message;
            }
          },
        }, busy ? 'Publishing...' : `Publish ${uploads.length + deletes.length} change${uploads.length + deletes.length === 1 ? '' : 's'}`),
        h('button.btn', { type: 'button', disabled: busy, onclick: () => void review(false) }, 'Check again'),
        h('button.btn', { type: 'button', disabled: busy, title: 'Ignore the publish history and send every file', onclick: () => void review(true) }, 'Upload everything'),
      ),
    );
    return box;
  }

  function render() {
    renderSide();
    renderMain();
  }

  modal.footer.append(
    h('span.form__hint.pub__footnote', null, icon('info', 14), ' Destinations are saved in wovenpage.json. Passwords are not.'),
    h('button.btn', {
      type: 'button',
      onclick: async () => {
        if (dirty) await saveTarget().catch((err) => shell.notify((err as Error).message, 'error'));
        modal.close();
      },
    }, 'Done'),
  );

  void selectTarget(selected);
}
