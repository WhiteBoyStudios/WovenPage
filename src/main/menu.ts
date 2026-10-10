/**
 * The native application menu. Items do not act directly: each sends a command
 * id to the renderer, whose command registry is the single place behaviour
 * lives (so the menu, the keyboard, and the command palette cannot drift).
 *
 * Shortcuts are shown but not registered here (`registerAccelerator: false`)
 * because the renderer's keybinding layer already handles them - registering
 * both would fire a command twice.
 */

import { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';

export function buildMenu(send: (command: string) => void, window: () => BrowserWindow | null): Menu {
  const cmd = (label: string, id: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => send(id),
  });
  const sep: MenuItemConstructorOptions = { type: 'separator' };

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&File',
      submenu: [
        cmd('New Page...', 'file.newPage', 'Ctrl+N'),
        cmd('New Stylesheet...', 'file.newStylesheet'),
        cmd('New Layout...', 'file.newLayout'),
        cmd('New Part...', 'file.newPart'),
        sep,
        cmd('New Site...', 'file.newSite'),
        cmd('Open Site Folder...', 'file.openSite', 'Ctrl+O'),
        cmd('Close Site', 'file.closeSite'),
        sep,
        cmd('Save', 'file.save', 'Ctrl+S'),
        cmd('Save All', 'file.saveAll', 'Ctrl+Shift+S'),
        cmd('Close Tab', 'file.closeTab', 'Ctrl+W'),
        sep,
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        cmd('Undo', 'edit.undo', 'Ctrl+Z'),
        cmd('Redo', 'edit.redo', 'Ctrl+Y'),
        sep,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        sep,
        cmd('Find', 'edit.find', 'Ctrl+F'),
        cmd('Replace', 'edit.replace', 'Ctrl+H'),
        cmd('Find in Site', 'edit.findInSite', 'Ctrl+Shift+F'),
      ],
    },
    {
      label: '&View',
      submenu: [
        cmd('Canvas', 'view.canvas', 'Ctrl+1'),
        cmd('Split', 'view.split', 'Ctrl+2'),
        cmd('Source', 'view.source', 'Ctrl+3'),
        sep,
        cmd('Interact with Page', 'view.toggleInteract', 'Ctrl+I'),
        cmd('Reload Canvas', 'view.reloadCanvas', 'F5'),
        sep,
        cmd('Go to File...', 'view.quickOpen', 'Ctrl+P'),
        cmd('Command Palette...', 'view.commandPalette', 'Ctrl+Shift+P'),
        cmd('Problems', 'view.problems', 'Ctrl+Shift+M'),
        sep,
        cmd('Switch Theme', 'view.theme'),
        { role: 'togglefullscreen' },
        {
          label: 'Developer Tools',
          accelerator: 'Ctrl+Shift+I',
          click: () => window()?.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: '&Site',
      submenu: [
        cmd('Preview in Browser', 'site.previewInBrowser', 'F9'),
        cmd('Check Site for Problems', 'site.checkProblems'),
        sep,
        cmd('Build Site', 'site.build', 'Ctrl+B'),
        cmd('Publish...', 'site.publish', 'Ctrl+Shift+U'),
      ],
    },
    {
      label: '&Help',
      submenu: [cmd('Keyboard Shortcuts', 'help.shortcuts'), cmd('About Wovenpage', 'help.about')],
    },
  ];
  return Menu.buildFromTemplate(template);
}
