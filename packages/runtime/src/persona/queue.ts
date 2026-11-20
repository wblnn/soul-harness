/**
 * Per-key asynchronous write queue.
 *
 * Calls that share a key run one at a time, in the order they were enqueued.
 * A different key does not wait. A rejection is contained: the next operation
 * on that key still runs. The queue stores no persona fields, so it cannot
 * leak a display name into a later operation.
 */

export function createKeyedQueue(): {
  run<T>(key: string, operation: () => T | Promise<T>): Promise<T>;
} {
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      const executed = previous.then(operation, operation);
      const settled: Promise<void> = executed.then(
        () => undefined,
        () => undefined,
      );
      tails.set(key, settled);
      void settled.then(() => {
        if (tails.get(key) === settled) {
          tails.delete(key);
        }
      });
      return executed;
    },
  };
}
