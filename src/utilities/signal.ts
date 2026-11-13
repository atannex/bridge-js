/**
 * One signal that aborts on the caller's signal or after `timeout` ms.
 *
 * `AbortSignal.any` and `AbortSignal.timeout` are missing from Node 18 and some
 * React Native versions, so this wires it up by hand and reports which of the
 * two fired.
 */
export interface LinkedSignal {
  signal: AbortSignal;
  timedOut(): boolean;
  /** Aborts the linked signal itself, for example to release a response body nobody will read. */
  abort(reason?: unknown): void;
  dispose(): void;
}

export function linkSignal(parent: AbortSignal | undefined, timeout: number | undefined): LinkedSignal {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = (): void => controller.abort(parent?.reason);
  if (parent?.aborted) {
    controller.abort(parent.reason);
  } else {
    parent?.addEventListener('abort', onAbort, { once: true });
  }

  if (timeout !== undefined && timeout > 0 && timeout !== Infinity) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    abort: (reason) => controller.abort(reason),
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

/** Waits `ms`, or rejects as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One signal that aborts when either input does. `dispose` detaches the
 * listeners once the work is done.
 */
export function eitherSignal(first: AbortSignal, second: AbortSignal | undefined): LinkedSignal {
  const linked = linkSignal(first, undefined);
  if (second === undefined) return linked;
  const onAbort = (): void => linked.abort(second.reason);
  if (second.aborted) linked.abort(second.reason);
  else second.addEventListener('abort', onAbort, { once: true });
  return {
    ...linked,
    dispose: () => {
      linked.dispose();
      second.removeEventListener('abort', onAbort);
    },
  };
}
