import {
  admitApplicationRequest,
  assertRestoreAccessAllowed,
  resetRestoreQuiescenceForTests,
  RestoreInProgressError,
  RestoreRecoveryRequiredError,
  RestoreDrainTimeoutError,
  runInRestoreQuiescence,
  runWithApplicationRequest,
} from '../../../src/nest/backup/restore-quiescence';
import {
  RestoreQuiescenceInterceptor,
  RestoreQuiescenceProbe,
} from '../../../src/nest/backup/restore-quiescence.interceptor';
import { CallHandler, ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { defer, from, lastValueFrom, Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('restore quiescence', () => {
  beforeEach(() => resetRestoreQuiescenceForTests());

  it('drains an admitted request, rejects new work, and gives only the restore scoped access', async () => {
    const admission = admitApplicationRequest();
    expect(admission).not.toBeNull();

    let entered = false;
    let finishRestore!: () => void;
    const restoreBody = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    const restore = runInRestoreQuiescence(async () => {
      entered = true;
      expect(() => assertRestoreAccessAllowed()).not.toThrow();
      await restoreBody;
    });

    await Promise.resolve();
    expect(entered).toBe(false);
    expect(admitApplicationRequest()).toBeNull();
    expect(() => assertRestoreAccessAllowed()).toThrow(/restore/i);
    expect(() => runWithApplicationRequest(admission!, () => assertRestoreAccessAllowed())).not.toThrow();

    admission!.release();
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(() => assertRestoreAccessAllowed()).toThrow(/restore/i);

    finishRestore();
    await restore;
    expect(() => assertRestoreAccessAllowed()).not.toThrow();
    expect(admitApplicationRequest()).not.toBeNull();
  });

  it('always reopens access when the restore body fails', async () => {
    await expect(
      runInRestoreQuiescence(async () => {
        throw new Error('restore failed');
      }),
    ).rejects.toThrow('restore failed');
    expect(() => assertRestoreAccessAllowed()).not.toThrow();
  });

  it('holds maintenance closed when automatic recovery is incomplete', async () => {
    await expect(
      runInRestoreQuiescence(async () => {
        throw new RestoreRecoveryRequiredError('operator recovery required');
      }),
    ).rejects.toThrow('operator recovery required');

    expect(() => assertRestoreAccessAllowed()).toThrow(/restore/i);
    expect(admitApplicationRequest()).toBeNull();
  });

  it('runs the drain-start hook only after new work is blocked and before waiting for long requests', async () => {
    const longRequest = admitApplicationRequest();
    expect(longRequest).not.toBeNull();
    let hookCalled = false;
    const fallback = setTimeout(() => longRequest!.release(), 25);

    await runInRestoreQuiescence(async () => undefined, {
      onDrainStarted: () => {
        hookCalled = true;
        expect(admitApplicationRequest()).toBeNull();
        longRequest!.release();
      },
    });
    clearTimeout(fallback);
    expect(hookCalled).toBe(true);
  });

  it('awaits asynchronous drain-start cleanup before entering the restore body', async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let restoreBodyRan = false;

    const restore = runInRestoreQuiescence(
      async () => {
        restoreBodyRan = true;
      },
      { onDrainStarted: () => cleanup },
    );

    await Promise.resolve();
    expect(restoreBodyRan).toBe(false);
    expect(admitApplicationRequest()).toBeNull();
    finishCleanup();
    await restore;
    expect(restoreBodyRan).toBe(true);
  });

  it('applies the drain timeout to asynchronous drain-start cleanup too', async () => {
    let restoreBodyRan = false;

    await expect(
      runInRestoreQuiescence(
        async () => {
          restoreBodyRan = true;
        },
        {
          onDrainStarted: () => new Promise<void>(() => undefined),
          drainTimeoutMs: 5,
        },
      ),
    ).rejects.toBeInstanceOf(RestoreDrainTimeoutError);

    expect(restoreBodyRan).toBe(false);
    const nextRequest = admitApplicationRequest();
    expect(nextRequest).not.toBeNull();
    nextRequest!.release();
  });

  it('aborts and reopens before mutation when an admitted stream cannot drain in time', async () => {
    const stuckRequest = admitApplicationRequest();
    expect(stuckRequest).not.toBeNull();
    const fallback = setTimeout(() => stuckRequest!.release(), 50);
    let restoreBodyRan = false;

    await expect(
      runInRestoreQuiescence(
        async () => {
          restoreBodyRan = true;
        },
        { drainTimeoutMs: 5 },
      ),
    ).rejects.toBeInstanceOf(RestoreDrainTimeoutError);
    clearTimeout(fallback);
    expect(restoreBodyRan).toBe(false);

    stuckRequest!.release();
    const nextRequest = admitApplicationRequest();
    expect(nextRequest).not.toBeNull();
    nextRequest!.release();
  });
});

describe('RestoreQuiescenceInterceptor', () => {
  beforeEach(() => resetRestoreQuiescenceForTests());

  it('tracks ordinary requests through observable completion', async () => {
    const interceptor = new RestoreQuiescenceInterceptor({
      getAllAndOverride: () => false,
    } as any);
    const context = {} as ExecutionContext;
    const next = { handle: () => of('ok') } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, next))).resolves.toBe('ok');

    await expect(runInRestoreQuiescence(async () => 'restored')).resolves.toBe('restored');
  });

  it('keeps only a marked liveness probe reachable while recovery maintenance is blocked', async () => {
    class ProbeController {
      @RestoreQuiescenceProbe()
      health(): void {}

      features(): void {}
    }

    await expect(
      runInRestoreQuiescence(async () => {
        throw new RestoreRecoveryRequiredError('operator recovery required');
      }),
    ).rejects.toBeInstanceOf(RestoreRecoveryRequiredError);

    const interceptor = new RestoreQuiescenceInterceptor(new Reflector());
    const handler = { handle: () => of('ok') } as CallHandler;
    const contextFor = (method: 'health' | 'features') =>
      ({
        getHandler: () => ProbeController.prototype[method],
        getClass: () => ProbeController,
      }) as unknown as ExecutionContext;

    await expect(lastValueFrom(interceptor.intercept(contextFor('health'), handler))).resolves.toBe('ok');
    expect(() => interceptor.intercept(contextFor('features'), handler)).toThrow(RestoreInProgressError);
  });

  it('keeps the application access scope through asynchronous Observable subscription work', async () => {
    const interceptor = new RestoreQuiescenceInterceptor({
      getAllAndOverride: () => false,
    } as any);
    let continueHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      continueHandler = resolve;
    });
    let subscribed = false;
    const next = {
      handle: () =>
        new Observable<string>((subscriber) => {
          subscribed = true;
          void handlerGate.then(() => {
            try {
              assertRestoreAccessAllowed();
              subscriber.next('ok');
              subscriber.complete();
            } catch (error) {
              subscriber.error(error);
            }
          });
        }),
    } as CallHandler;

    const response = lastValueFrom(interceptor.intercept({} as ExecutionContext, next));
    await vi.waitFor(() => expect(subscribed).toBe(true));
    let restoreEntered = false;
    const restore = runInRestoreQuiescence(async () => {
      restoreEntered = true;
    });
    await Promise.resolve();
    expect(restoreEntered).toBe(false);

    continueHandler();
    await expect(response).resolves.toBe('ok');
    await restore;
    expect(restoreEntered).toBe(true);
  });

  it('does not admit a second ordinary request after restore draining starts', async () => {
    const first = admitApplicationRequest()!;
    const restore = runInRestoreQuiescence(async () => undefined);
    await Promise.resolve();

    const interceptor = new RestoreQuiescenceInterceptor({
      getAllAndOverride: () => false,
    } as any);
    expect(() => interceptor.intercept({} as ExecutionContext, { handle: () => of(null) } as CallHandler)).toThrow(
      HttpException,
    );

    first.release();
    await restore;
  });

  it('lets the restore owner endpoint enter without counting itself', async () => {
    const interceptor = new RestoreQuiescenceInterceptor({
      getAllAndOverride: () => true,
    } as any);
    await expect(
      lastValueFrom(
        interceptor.intercept(
          {} as ExecutionContext,
          { handle: () => defer(() => from(runInRestoreQuiescence(async () => 'ok'))) } as CallHandler,
        ),
      ),
    ).resolves.toBe('ok');
  });
});
