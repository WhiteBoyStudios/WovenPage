/**
 * The command registry: the one place user-facing actions are defined.
 * The native menu, keyboard shortcuts, the command palette and toolbar buttons
 * all run commands by id, so they can never disagree about what an action does.
 */

export interface Command {
  id: string;
  title: string;
  /** e.g. "Ctrl+Shift+F". Parsed by the keybinding layer. */
  key?: string;
  /** Hide from the command palette (still reachable by key or menu). */
  hidden?: boolean;
  /** Return false to mark the command unavailable right now. */
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** Canonical form of a key press, e.g. "ctrl+shift+f". */
export function chordOf(e: KeyLike): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  let key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Shifted digits arrive as symbols; use the physical key so Ctrl+Shift+1 still reads as "1".
  if (e.code && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  if (key === ' ') key = 'space';
  parts.push(key.toLowerCase());
  return parts.join('+');
}

function chordFromLabel(label: string): string {
  const parts = label.toLowerCase().split('+').map((p) => p.trim());
  const key = parts.pop()!;
  const mods = ['ctrl', 'shift', 'alt'].filter((m) => parts.includes(m));
  return [...mods, key].join('+');
}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private keys = new Map<string, string>();
  private onError: (message: string) => void = () => undefined;

  setErrorHandler(handler: (message: string) => void): void {
    this.onError = handler;
  }

  register(...commands: Command[]): void {
    for (const command of commands) {
      this.commands.set(command.id, command);
      if (command.key) this.keys.set(chordFromLabel(command.key), command.id);
    }
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  all(): Command[] {
    return [...this.commands.values()];
  }

  async run(id: string): Promise<void> {
    const command = this.commands.get(id);
    if (!command) return;
    if (command.enabled && !command.enabled()) return;
    try {
      await command.run();
    } catch (err) {
      this.onError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Runs the command bound to a key press. Returns true if one was found. */
  handleKey(e: KeyLike): boolean {
    const id = this.keys.get(chordOf(e));
    if (!id) return false;
    const command = this.commands.get(id);
    if (!command || (command.enabled && !command.enabled())) return false;
    void this.run(id);
    return true;
  }
}
