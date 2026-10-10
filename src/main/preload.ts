/**
 * The only bridge between the sandboxed renderer and the main process. It
 * forwards a fixed list of method names and event names - nothing else from
 * Electron or Node is reachable from the page.
 */

import { contextBridge, ipcRenderer } from 'electron';

import { API_EVENTS, API_METHODS, ApiEvents, Bridge, IPC_EVENT, IPC_INVOKE } from '../shared/ipc';

const listeners = new Map<string, Set<(payload: unknown) => void>>();

ipcRenderer.on(IPC_EVENT, (_event, name: string, payload: unknown) => {
  listeners.get(name)?.forEach((listener) => listener(payload));
});

const bridge: Bridge = {
  invoke(method, args) {
    if (!API_METHODS.includes(method)) return Promise.reject(new Error(`Unknown method "${String(method)}".`));
    return ipcRenderer.invoke(IPC_INVOKE, method, args);
  },
  on<K extends keyof ApiEvents>(event: K, listener: (payload: ApiEvents[K]) => void) {
    if (!API_EVENTS.includes(event)) throw new Error(`Unknown event "${event}".`);
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(listener as (payload: unknown) => void);
    return () => set!.delete(listener as (payload: unknown) => void);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('wovenpage', bridge);
