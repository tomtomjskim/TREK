import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * What the offline cache is allowed to keep of another member's packing list
 * (#1976).
 *
 * The server scopes these events now, so in ordinary running nothing here has
 * anything to refuse. It refuses anyway, because a leak on the wire used to
 * become permanent on this side: the write is a `put`, the offline read hands
 * back every cached row for the trip without a privacy filter, and nothing ever
 * prunes. One stray event put another member's item into this browser for good,
 * and it surfaced every time a read fell back to the cache — offline, captive
 * portal, dropped connection.
 *
 * So the interesting case is not that the item is skipped. It is that a row
 * which arrived before any of this existed gets deleted when the next event
 * about it comes past, which is what makes an already-leaked list heal itself.
 */

const { packingItems, places, dbGeneration } = vi.hoisted(() => ({
  packingItems: { put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
  places: { put: vi.fn(async () => undefined) },
  dbGeneration: { value: 0 },
}));

vi.mock('../../../src/db/offlineDb', () => ({
  offlineDb: {
    places,
    packingItems,
    // The handler module touches these at import time only.
    trips: {}, days: {}, assignments: {},
  },
  captureOfflineDbLease: () => ({ generation: dbGeneration.value }),
  isOfflineDbLeaseValid: (lease: { generation: number }) => lease.generation === dbGeneration.value,
}));

import { useTripStore } from '../../../src/store/tripStore';
import { useAuthStore } from '../../../src/store/authStore';
import { handleRemoteEvent } from '../../../src/store/slices/remoteEventHandler';
import { setAuthed } from '../../../src/sync/authGate';
import { resetAllStores } from '../../helpers/store';
import { buildPackingItem, buildPlace } from '../../helpers/factories';

const ME = 7;
const SOMEONE_ELSE = 99;

beforeEach(() => {
  resetAllStores();
  packingItems.put.mockClear();
  packingItems.delete.mockClear();
  places.put.mockClear();
  dbGeneration.value += 1;
  setAuthed(false);
  useAuthStore.setState({ user: { id: ME, username: 'me', email: 'me@example.test' } as never });
});

const send = (item: unknown) =>
  useTripStore.getState().handleRemoteEvent({ type: 'packing:updated', item } as never);

describe('a packing item arriving over the wire', () => {
  it('is cached when it is shared with the whole trip', async () => {
    send(buildPackingItem({ id: 1, is_private: 0 }));
    expect(packingItems.put).toHaveBeenCalledTimes(1);
    expect(packingItems.delete).not.toHaveBeenCalled();
  });

  it('is cached when it is my own private one', async () => {
    send(buildPackingItem({ id: 2, is_private: 1, owner_id: ME }));
    expect(packingItems.put).toHaveBeenCalledTimes(1);
  });

  it('is cached when it is private but shared with me', async () => {
    send(buildPackingItem({
      id: 3, is_private: 1, owner_id: SOMEONE_ELSE,
      recipients: [{ user_id: ME, username: 'me' }],
    }));
    expect(packingItems.put).toHaveBeenCalledTimes(1);
  });

  /* The assertion that would have caught the leak. */
  it('is not cached when it is somebody else s private one', async () => {
    send(buildPackingItem({ id: 4, is_private: 1, owner_id: SOMEONE_ELSE }));
    expect(packingItems.put).not.toHaveBeenCalled();
  });

  it('removes a copy that an earlier leak already left behind', async () => {
    send(buildPackingItem({ id: 5, is_private: 1, owner_id: SOMEONE_ELSE }));
    expect(packingItems.delete).toHaveBeenCalledWith(5);
  });

  /*
   * A signed-out or not-yet-loaded session has no id to compare against.
   * Refusing is the safe answer: there is no user whose list this could be.
   */
  it('keeps a restricted item out when nobody is signed in', async () => {
    useAuthStore.setState({ user: null });
    send(buildPackingItem({ id: 6, is_private: 1, owner_id: SOMEONE_ELSE }));
    expect(packingItems.put).not.toHaveBeenCalled();
  });

  it('drops an event when auth changes during event snapshotting', () => {
    setAuthed(true, ME);
    const place = buildPlace({ id: 10, name: 'Original' });
    const state = { places: [place], assignments: {}, trip: null };
    let firstRead = true;
    const get = () => {
      if (firstRead) {
        firstRead = false;
        setAuthed(false);
      }
      return state;
    };
    const set = (updater: (current: typeof state) => Partial<typeof state>) => {
      Object.assign(state, updater(state));
    };

    handleRemoteEvent(set as never, get as never, {
      type: 'place:updated',
      place: { ...place, name: 'must not land' },
    } as never);

    expect(state.places[0].name).not.toBe('must not land');
  });

  it('does not start a Dexie write when the active DB changes during state application', async () => {
    setAuthed(true, ME);
    const place = buildPlace({ id: 11, name: 'Original' });
    const state = { places: [place], assignments: {}, trip: null };
    const get = () => state;
    const set = (updater: (current: typeof state) => Partial<typeof state>) => {
      Object.assign(state, updater(state));
      dbGeneration.value += 1;
    };

    handleRemoteEvent(set as never, get as never, {
      type: 'place:updated',
      place: { ...place, name: 'new DB must not receive this' },
    } as never);

    await Promise.resolve();
    expect(places.put).not.toHaveBeenCalled();
  });
});
