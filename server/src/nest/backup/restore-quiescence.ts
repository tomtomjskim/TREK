import { HttpException } from '@nestjs/common';

import { AsyncLocalStorage } from 'node:async_hooks';

type RestorePhase = 'open' | 'draining' | 'blocked';
type AccessScope = 'application' | 'restore';

const accessScope = new AsyncLocalStorage<AccessScope>();
let phase: RestorePhase = 'open';
let activeRequests = 0;
let drainedWaiters: Array<() => void> = [];
const DEFAULT_RESTORE_DRAIN_TIMEOUT_MS = 120_000;

export class RestoreInProgressError extends HttpException {
  constructor() {
    const message = 'Backup restore in progress; try again after it completes.';
    super({ error: message }, 503);
    this.message = message;
    this.name = 'RestoreInProgressError';
  }
}

/** A partial restore must keep this process in maintenance until recovery. */
export class RestoreRecoveryRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RestoreRecoveryRequiredError';
  }
}

/** Restore never began because admitted application work did not drain. */
export class RestoreDrainTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms while draining application work for restore.`);
    this.name = 'RestoreDrainTimeoutError';
  }
}

export interface ApplicationRequestAdmission {
  release(): void;
}

export interface RestoreQuiescenceOptions {
  /**
   * Runs after new application work is rejected but before existing work is
   * drained. Use it to close long-lived transports (for example MCP SSE) whose
   * normal completion is what releases an already-admitted request.
   */
  onDrainStarted?: () => void | Promise<void>;
  /** Maximum time to wait before aborting safely, before any restore mutation. */
  drainTimeoutMs?: number;
}

/**
 * Admit an ordinary request while the service is open. The restore owner route
 * deliberately does not call this: otherwise it would wait forever for itself
 * while draining the requests which entered before it.
 */
export function admitApplicationRequest(): ApplicationRequestAdmission | null {
  if (phase !== 'open') return null;
  activeRequests++;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      activeRequests--;
      if (activeRequests === 0 && phase === 'draining') {
        const waiters = drainedWaiters;
        drainedWaiters = [];
        for (const resolve of waiters) resolve();
      }
    },
  };
}

/** Run an admitted request inside a scope that may finish while restore drains. */
export function runWithApplicationRequest<T>(_admission: ApplicationRequestAdmission, operation: () => T): T {
  return accessScope.run('application', operation);
}

/**
 * Keep detached application work in the same drain set as HTTP requests. This
 * is used by storage jobs which intentionally outlive the request that starts
 * them, so restore cannot cross their copy/route-flip boundary.
 */
export function runTrackedApplicationWork<T>(operation: () => Promise<T>): Promise<T> {
  const admission = admitApplicationRequest();
  if (!admission) throw new RestoreInProgressError();
  let result: Promise<T>;
  try {
    result = runWithApplicationRequest(admission, operation);
  } catch (error) {
    admission.release();
    throw error;
  }
  return result.finally(() => admission.release());
}

/**
 * Final fail-closed boundary for DB/storage access. During drain, requests which
 * were admitted beforehand may finish; once drained, only the restore scope may
 * touch state. Detached work loses permission at the blocked phase even if it
 * inherited an old request's async context.
 */
export function assertRestoreAccessAllowed(): void {
  if (phase === 'open') return;
  const scope = accessScope.getStore();
  if (scope === 'restore') return;
  if (phase === 'draining' && scope === 'application') return;
  throw new RestoreInProgressError();
}

async function waitUntilDrained(timeoutMs: number): Promise<void> {
  if (activeRequests === 0) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resolveDrained = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    drainedWaiters.push(resolveDrained);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      drainedWaiters = drainedWaiters.filter((waiter) => waiter !== resolveDrained);
      reject(new RestoreDrainTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function runDrainStartHook(hook: RestoreQuiescenceOptions['onDrainStarted'], timeoutMs: number): Promise<void> {
  if (!hook) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new RestoreDrainTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();

    Promise.resolve()
      .then(hook)
      .then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/**
 * Reject new requests, drain admitted work, then run one privileged restore.
 * The finally is the only reopening point, covering both commit and rollback.
 */
export async function runInRestoreQuiescence<T>(
  operation: () => Promise<T>,
  options: RestoreQuiescenceOptions = {},
): Promise<T> {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_RESTORE_DRAIN_TIMEOUT_MS;
  if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs <= 0) {
    throw new RangeError('Restore drain timeout must be a positive finite number.');
  }
  if (phase !== 'open') throw new RestoreInProgressError();
  phase = 'draining';
  const drainDeadline = Date.now() + drainTimeoutMs;
  let recoveryRequired = false;
  try {
    await runDrainStartHook(options.onDrainStarted, drainTimeoutMs);
    const remainingDrainMs = Math.max(1, drainDeadline - Date.now());
    await waitUntilDrained(remainingDrainMs);
    phase = 'blocked';
    return await accessScope.run('restore', operation);
  } catch (error) {
    recoveryRequired = error instanceof RestoreRecoveryRequiredError;
    throw error;
  } finally {
    phase = recoveryRequired ? 'blocked' : 'open';
    const waiters = drainedWaiters;
    drainedWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Unit-test isolation only. Never call while application work is active. */
export function resetRestoreQuiescenceForTests(): void {
  phase = 'open';
  activeRequests = 0;
  drainedWaiters = [];
}
