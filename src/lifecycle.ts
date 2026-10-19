import { AsyncLocalStorage } from "node:async_hooks";

import { DispatchkitError } from "./errors.ts";

export function createLifecycle() {
  const callbacks: Array<() => void | Promise<void>> = [];
  let disposal: Promise<void> | undefined;
  let disposed = false;
  // Arrow functions: `onDispose` is handed to factories as a detached callback.
  return {
    get disposed() {
      return disposed;
    },
    onDispose: (callback: () => void | Promise<void>): void => {
      if (disposed)
        throw new DispatchkitError(
          "DISPATCHKIT_RUNTIME_DISPOSED: Cannot register cleanup after disposal",
        );
      if (typeof callback !== "function") throw new TypeError("onDispose expects a function");
      const runInContext = AsyncLocalStorage.snapshot();
      callbacks.push(() => runInContext(callback));
    },
    dispose: (): Promise<void> => {
      if (disposal) return disposal;
      disposed = true;
      // Defer callbacks so reentrant calls observe the same disposal promise.
      disposal = Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        for (const callback of callbacks.reverse()) {
          try {
            await callback();
          } catch (error) {
            errors.push(error);
          }
        }
        callbacks.length = 0;
        if (errors.length)
          throw new AggregateError(errors, "DISPATCHKIT_DISPOSE_FAILED: Resource cleanup failed");
      });
      return disposal;
    },
  };
}
