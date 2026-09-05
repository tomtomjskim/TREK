import { admitApplicationRequest, RestoreInProgressError, runWithApplicationRequest } from './restore-quiescence';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';

const RESTORE_QUIESCENCE_OWNER = 'trek:restore-quiescence-owner';
const RESTORE_QUIESCENCE_PROBE = 'trek:restore-quiescence-probe';

/** Marks the two admin restore handlers which must not count themselves. */
export const RestoreQuiescenceOwner = () => SetMetadata(RESTORE_QUIESCENCE_OWNER, true);

/** Keeps the side-effect-free container liveness probe reachable in maintenance. */
export const RestoreQuiescenceProbe = () => SetMetadata(RESTORE_QUIESCENCE_PROBE, true);

@Injectable()
export class RestoreQuiescenceInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const owner = this.reflector.getAllAndOverride<boolean>(RESTORE_QUIESCENCE_OWNER, [
      context.getHandler?.(),
      context.getClass?.(),
    ]);
    const probe = this.reflector.getAllAndOverride<boolean>(RESTORE_QUIESCENCE_PROBE, [
      context.getHandler?.(),
      context.getClass?.(),
    ]);
    if (owner || probe) return next.handle();

    const admission = admitApplicationRequest();
    if (!admission) {
      throw new RestoreInProgressError();
    }

    // Creating an Observable in an AsyncLocalStorage scope is not enough: RxJS
    // subscribes to the returned inner source after a `defer` factory returns,
    // when that scope has already ended. Subscribe while the application scope
    // is active so every async continuation produced by the handler inherits it.
    return new Observable((subscriber) =>
      runWithApplicationRequest(admission, () => next.handle().subscribe(subscriber)),
    ).pipe(finalize(() => admission.release()));
  }
}
