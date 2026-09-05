import { describe, it, expect, vi } from 'vitest';
import {
  RestoreInProgressError,
  runInRestoreQuiescence,
  resetRestoreQuiescenceForTests,
} from '../../../../src/nest/backup/restore-quiescence';
import { DatabaseService } from '../../../../src/nest/database/database.service';
import type { NotificationsService } from '../../../../src/nest/notifications/notifications.service';
import { StorageHealthNotifierService } from '../../../../src/nest/notifications/storage-health-notifier.service';
import { StorageEventsService } from '../../../../src/nest/storage/storage-events.service';
import { makeNotificationsService } from '../../../helpers/notifications';
import { createTestDb } from '../../../helpers/test-db';

describe('StorageHealthNotifierService', () => {
  it('NOTIF-001 subscribes on bootstrap and sends an admin-scoped replica_failure with params', () => {
    const events = new StorageEventsService();
    const send = vi.fn().mockResolvedValue(undefined);
    const notifier = new StorageHealthNotifierService(events, { send } as unknown as NotificationsService);
    notifier.onApplicationBootstrap();
    events.emitReplicaFailure({ backend: 's3-bkp', key: 'backups/db.zip', op: 'put', error: 'timeout', at: 1 });
    expect(send).toHaveBeenCalledWith({
      event: 'replica_failure',
      actorId: null,
      scope: 'admin',
      targetId: 0,
      params: { backend: 's3-bkp', key: 'backups/db.zip', op: 'put', error: 'timeout', suppressed: '0' },
    });
    // Second failure inside the window: suppressed, no second send.
    events.emitReplicaFailure({ backend: 's3-bkp', key: 'backups/x.zip', op: 'put', error: 'timeout', at: 2 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('NOTIF-002 a rejected send never throws into the emitter (write path stays safe)', () => {
    const events = new StorageEventsService();
    const send = vi.fn().mockRejectedValue(new Error('smtp down'));
    const notifier = new StorageHealthNotifierService(events, { send } as unknown as NotificationsService);
    notifier.onApplicationBootstrap();
    expect(() => events.emitReplicaFailure({ backend: 'b', key: 'k', op: 'delete', error: 'e', at: 3 })).not.toThrow();
  });

  it('NOTIF-003 public send rejects while restore is blocked instead of touching the DB', async () => {
    const db = createTestDb();
    const notifications = makeNotificationsService(new DatabaseService(db));

    try {
      await runInRestoreQuiescence(async () => {
        await expect(
          notifications.send({
            event: 'replica_failure',
            actorId: null,
            scope: 'admin',
            targetId: 0,
            params: { backend: 'b', key: 'k', op: 'put', error: 'e', suppressed: '0' },
          }),
        ).rejects.toBeInstanceOf(RestoreInProgressError);
      });
    } finally {
      db.close();
      resetRestoreQuiescenceForTests();
    }
  });

  it('NOTIF-004 storage-health detached send uses the same blocked admission boundary', async () => {
    const db = createTestDb();
    const notifications = makeNotificationsService(new DatabaseService(db));
    const send = vi.spyOn(notifications, 'send');
    const events = new StorageEventsService();
    const notifier = new StorageHealthNotifierService(events, notifications as NotificationsService);
    notifier.onApplicationBootstrap();

    try {
      await runInRestoreQuiescence(async () => {
        expect(() => events.emitReplicaFailure({ backend: 'b', key: 'k', op: 'put', error: 'e', at: 4 })).not.toThrow();
        expect(send).toHaveBeenCalledTimes(1);
        await expect(send.mock.results[0].value as Promise<void>).rejects.toBeInstanceOf(RestoreInProgressError);
      });
    } finally {
      db.close();
      resetRestoreQuiescenceForTests();
    }
  });
});
