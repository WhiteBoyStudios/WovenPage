export type Listener<T> = (value: T) => void;

/** Minimal typed event emitter. `on` returns an unsubscribe function. */
export class Emitter<T = void> {
  private listeners = new Set<Listener<T>>();

  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
}
