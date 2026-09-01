/**
 * PLUG-SEC: the v4 decorated RPC registry is the authorization boundary.
 *
 * The first case builds the complete decorated controller set and routes it through
 * PluginRpcHostFactory. The remaining cases use the real PackingRpc controller and
 * the same factory with a small database/service fixture, so the checks exercise
 * registry binding and host-bound actor propagation rather than calling methods
 * directly.
 */
import { describe, expect, it, vi } from 'vitest';
import { PluginRpcHostFactory } from '../../../src/nest/plugins/host/plugin-rpc-host.factory';
import { PluginRpcRegistryService } from '../../../src/nest/plugins/host/rpc-kit/registry.service';
import { createTestPluginRegistry } from '../../../src/nest/plugins/host/rpc-kit/testing';
import { PluginGuards } from '../../../src/nest/plugins/host/plugin-guards.service';
import { PackingRpc } from '../../../src/nest/packing/packing.rpc';
import type { DatabaseService } from '../../../src/nest/database/database.service';
import type { PermissionsService } from '../../../src/nest/permissions/permissions.service';
import type { AddonsService } from '../../../src/nest/addons/addons.service';
import type { RealtimeService } from '../../../src/nest/realtime/realtime.service';
import type { RpcError, RpcRequest, RpcResponse } from '../../../src/nest/plugins/protocol/envelope';
import { KNOWN_METHODS, UNCONDITIONAL_METHODS } from '../../../src/nest/plugins/protocol/envelope';
import { allRpcControllers } from '../../helpers/rpc-host-deps';

const req = (method: string, params: Record<string, unknown> = {}): RpcRequest => ({
  k: 'req',
  id: 'plug-sec',
  method,
  params,
});

type Result = RpcResponse | RpcError;
const errorOf = (result: Result): RpcError['error'] => (result as RpcError).error;

const router = {
  callPlugin: vi.fn(async () => undefined),
  emitPluginEvent: vi.fn(),
};

describe('PLUG-SEC — complete decorated registry through the production factory', () => {
  it('PLUGSEC-001 denies every known privileged method when no grant is present', async () => {
    // allRpcControllers() is the same decorated provider inventory used by the
    // coverage ledger. The factory, not PluginRpcHost directly, creates the host.
    const registry = createTestPluginRegistry(allRpcControllers());
    const factory = new PluginRpcHostFactory(
      {} as DatabaseService,
      registry as unknown as PluginRpcRegistryService,
    );
    const host = factory.create('no-grants', new Set(), router);

    expect(registry.methodNames()).toEqual(new Set([...KNOWN_METHODS, ...UNCONDITIONAL_METHODS]));
    for (const method of KNOWN_METHODS) {
      const result = await host.dispatch(req(method), 42);
      expect(result.ok, `${method} must remain default-deny`).toBe(false);
      expect(errorOf(result).code, `${method} denial code`).toBe('PERMISSION_DENIED');
    }
  });
});

function securityFixture() {
  const activeMembers = new Set([5, 6, 7]);
  const canAccessTrip = vi.fn((tripId: number, userId: number) => {
    if (tripId !== 1 || !activeMembers.has(userId)) return undefined;
    return { id: 1, user_id: 5 };
  });
  const db = {
    canAccessTrip,
    prepare: vi.fn(() => ({ get: () => ({ role: 'user' }) })),
  } as unknown as DatabaseService;
  const permissions = { checkPermission: vi.fn(() => true) } as unknown as PermissionsService;
  const addons = { isAddonEnabled: vi.fn(() => true) } as unknown as AddonsService;
  const guards = new PluginGuards(db, permissions, addons);
  const listItems = vi.fn((_tripId: number, userId: number) => {
    const common = { id: 1, name: 'Shared charger', is_private: 0 };
    const privateItem = { id: 2, name: 'Owner gift', is_private: 1, owner_id: 5, recipients: [{ user_id: 7 }] };
    return userId === 5 || userId === 7 ? [common, privateItem] : [common];
  });
  const packing = { listItems } as never;
  const realtime = { broadcast: vi.fn() } as unknown as RealtimeService;
  const registry = createTestPluginRegistry([new PackingRpc(packing, realtime, guards)]);
  const factory = new PluginRpcHostFactory(
    db,
    registry as unknown as PluginRpcRegistryService,
  );
  const host = factory.create('packing-security', new Set(['db:read:packing']), router);
  return { activeMembers, canAccessTrip, listItems, host };
}

describe('PLUG-SEC — actor and packing privacy through PackingRpc', () => {
  it('PLUGSEC-002 refuses a userless read before touching the service', async () => {
    const fixture = securityFixture();
    const result = await fixture.host.dispatch(req('packing.list', { tripId: 1 }), undefined);

    expect(errorOf(result).code).toBe('RESOURCE_FORBIDDEN');
    expect(errorOf(result).message).toBe('trip reads require an authenticated user context');
    expect(fixture.listItems).not.toHaveBeenCalled();
  });

  it('PLUGSEC-003 refuses an actor outside the requested trip', async () => {
    const fixture = securityFixture();
    const result = await fixture.host.dispatch(req('packing.list', { tripId: 2 }), 6);

    expect(errorOf(result).code).toBe('RESOURCE_FORBIDDEN');
    expect(errorOf(result).message).toBe('no access to trip 2');
    expect(fixture.listItems).not.toHaveBeenCalled();
  });

  it('PLUGSEC-004 a member removed after a prior read is denied on the next request', async () => {
    const fixture = securityFixture();
    expect((await fixture.host.dispatch(req('packing.list', { tripId: 1 }), 6)).ok).toBe(true);
    fixture.activeMembers.delete(6);

    const result = await fixture.host.dispatch(req('packing.list', { tripId: 1 }), 6);
    expect(errorOf(result).code).toBe('RESOURCE_FORBIDDEN');
    expect(errorOf(result).message).toBe('no access to trip 1');
    expect(fixture.listItems).toHaveBeenCalledTimes(1);
  });

  it('PLUGSEC-005 delivers a private item to its recipient but not another trip member', async () => {
    const fixture = securityFixture();
    const recipient = await fixture.host.dispatch(req('packing.list', { tripId: 1 }), 7);
    const otherMember = await fixture.host.dispatch(req('packing.list', { tripId: 1 }), 6);

    expect((recipient as RpcResponse).result).toEqual([
      { id: 1, name: 'Shared charger', is_private: 0 },
      { id: 2, name: 'Owner gift', is_private: 1, owner_id: 5, recipients: [{ user_id: 7 }] },
    ]);
    expect((otherMember as RpcResponse).result).toEqual([
      { id: 1, name: 'Shared charger', is_private: 0 },
    ]);
    expect(fixture.listItems).toHaveBeenNthCalledWith(1, 1, 7);
    expect(fixture.listItems).toHaveBeenNthCalledWith(2, 1, 6);
  });

  it('PLUGSEC-006 a non-member cannot probe the private recipient item', async () => {
    const fixture = securityFixture();
    const result = await fixture.host.dispatch(req('packing.list', { tripId: 1 }), 9);

    expect(errorOf(result).code).toBe('RESOURCE_FORBIDDEN');
    expect(fixture.listItems).not.toHaveBeenCalled();
  });
});
