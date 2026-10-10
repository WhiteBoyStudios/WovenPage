/**
 * Typed access to the main process. `api.readFile(path)` becomes one IPC call
 * through the preload bridge; there is no other route out of the renderer.
 */

import type { Api, ApiEvents, Bridge } from '../../shared/ipc';

declare global {
  interface Window {
    wovenpage: Bridge;
  }
}

/** Strips Electron's "Error invoking remote method" wrapper so messages read naturally. */
function tidy(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''));
}

export const api = new Proxy({} as Api, {
  get(_target, method: string) {
    return (...args: unknown[]) => window.wovenpage.invoke(method as keyof Api, args).catch((e) => Promise.reject(tidy(e)));
  },
});

export function onEvent<K extends keyof ApiEvents>(event: K, listener: (payload: ApiEvents[K]) => void): () => void {
  return window.wovenpage.on(event, listener);
}
