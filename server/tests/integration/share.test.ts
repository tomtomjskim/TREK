/**
 * Share link integration tests.
 * Covers SHARE-001 to SHARE-009.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import type { INestApplication } from '@nestjs/common';

const { testDb, dbMock } = vi.hoisted(() => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const mock = {
    db,
    closeDb: () => {},
    reinitialize: () => {},
    getPlaceWithTags: (placeId: number) => {
      const place: any = db.prepare(`SELECT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon FROM places p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ?`).get(placeId);
      if (!place) return null;
      const tags = db.prepare(`SELECT t.* FROM tags t JOIN place_tags pt ON t.id = pt.tag_id WHERE pt.place_id = ?`).all(placeId);
      return { ...place, category: place.category_id ? { id: place.category_id, name: place.category_name, color: place.category_color, icon: place.category_icon } : null, tags };
    },
    canAccessTrip: (tripId: any, userId: number) =>
      db.prepare(`SELECT t.id, t.user_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ? AND (t.user_id = ? OR m.user_id IS NOT NULL)`).get(userId, tripId, userId),
    isOwner: (tripId: any, userId: number) =>
      !!db.prepare('SELECT id FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId),
  };
  return { testDb: db, dbMock: mock };
});

vi.mock('../../src/db/database', () => dbMock);
vi.mock('../../src/config', () => ({
  JWT_SECRET: 'test-jwt-secret-for-trek-testing-only',
  ENCRYPTION_KEY: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
  updateJwtSecret: () => {},
  SESSION_DURATION: '24h',
  SESSION_DURATION_MS: 86400000,
  SESSION_DURATION_SECONDS: 86400,
  DEFAULT_LANGUAGE: 'en',
}));
vi.mock('../../src/websocket', () => ({ broadcast: vi.fn(), broadcastToUser: vi.fn() }));

import { buildApp } from '../../src/bootstrap';
import { createTables } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrationRunner';
import { resetTestDb, resetRateLimits } from '../helpers/test-db';
import { createUser, createTrip, addTripMember, createDay, createPlace, createDayAssignment, createDayNote } from '../helpers/factories';
import { authCookie } from '../helpers/auth';
import { PlacePhotoCacheService } from '../../src/nest/place-photos/place-photo-cache.service';
import { DatabaseService } from '../../src/nest/database/database.service';
import { db as sharedDb } from '../../src/db/database';
import { LocalDriver } from '../../src/nest/storage/drivers/local.driver';
import { StorageService } from '../../src/nest/storage/storage.service';
import type { StorageRegistryService, ResolvedCategory } from '../../src/nest/storage/storage-registry.service';
import { DEFAULT_UPLOADS_ROOT, GLOBAL_TEMP_DIR } from '../../src/nest/storage/storage-paths';

// A real instance over the same connection the app uses — these cases write a
// cache entry and then read it back through the HTTP route, so the stub
// storage must be rooted where the app's registry serves 'photos-google'
// from (mode A: uploads/photos/google).
const uploadsDriver = new LocalDriver({ id: 'share-test-local', root: DEFAULT_UPLOADS_ROOT });
uploadsDriver.init({ ensurePrefixes: ['photos/google/'], cleanSpool: false });
const testStorage = new StorageService({
  resolve: (): ResolvedCategory => ({ driver: uploadsDriver, keyPrefix: 'photos/google/', backendName: 'share-test-local' }),
  tempDir: () => GLOBAL_TEMP_DIR,
  replicaFailures: () => [],
} as unknown as StorageRegistryService);
const placePhotoCache = new PlacePhotoCacheService(new DatabaseService(sharedDb), testStorage);
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let nestApp: INestApplication;
let app: Application;

beforeAll(async () => {
  createTables(testDb);
  runMigrations(testDb);
  nestApp = await buildApp();
  app = nestApp.getHttpAdapter().getInstance();
});

beforeEach(() => {
  resetTestDb(testDb);
  resetRateLimits(nestApp);
});

afterAll(async () => {
  await nestApp.close();
  testDb.close();
});

describe('Share link CRUD', () => {
  it('SHARE-001 — POST creates share link with default permissions', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(typeof res.body.token).toBe('string');
  });

  it('SHARE-002 — POST creates share link with custom permissions', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: false, share_packing: true });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
  });

  it('SHARE-003 — POST again updates share link permissions', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const first = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: true });

    const second = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: false });
    // Same token (update, not create)
    expect(second.body.token).toBe(first.body.token);
  });

  it('SHARE-004 — GET returns share link status', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});

    const res = await request(app)
      .get(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  it('SHARE-004 — GET returns null token when no share link exists', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const res = await request(app)
      .get(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id));
    expect(res.status).toBe(200);
    expect(res.body.token).toBeNull();
  });

  it('SHARE-005 — DELETE removes share link', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});

    const del = await request(app)
      .delete(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id));
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const status = await request(app)
      .get(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id));
    expect(status.body.token).toBeNull();
  });
});

describe('Shared trip access', () => {
  it('SHARE-006 — GET /shared/:token returns trip data with all sections', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Paris Adventure' });

    const create = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: true, share_packing: true });
    const token = create.body.token;

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.trip).toBeDefined();
    expect(res.body.trip.title).toBe('Paris Adventure');
  });

  it('SHARE-031 — HTTP response uses the exact reviewed key set for every enabled section', async () => {
    const keys = (value: Record<string, unknown>) => Object.keys(value).sort();
    const { user } = createUser(testDb, { username: 'public-owner' });
    const trip = createTrip(testDb, user.id, {
      title: 'Exact public contract',
      description: 'Public description',
      start_date: '2026-09-01',
      end_date: '2026-09-01',
    });
    testDb.prepare('UPDATE trips SET cover_image = ?, currency = ? WHERE id = ?')
      .run('/uploads/public-cover.jpg', 'KRW', trip.id);
    const day = testDb.prepare('SELECT id, day_number FROM days WHERE trip_id = ?').get(trip.id) as { id: number; day_number: number };
    testDb.prepare('UPDATE days SET title = ?, notes = ? WHERE id = ?')
      .run('Public day', 'FORBIDDEN_DAY_ROW_SENTINEL', day.id);
    const categoryResult = testDb.prepare(
      "INSERT INTO categories (name, color, icon, user_id) VALUES ('Museum', '#112233', 'Landmark', ?)"
    ).run(user.id);
    const categoryId = Number(categoryResult.lastInsertRowid);
    const place = createPlace(testDb, trip.id, { name: 'Public place', category_id: categoryId });
    testDb.prepare(`
      UPDATE places SET description = ?, address = ?, place_time = ?, end_time = ?, image_url = ?, notes = ?,
        google_place_id = ?, website = ?, reservation_notes = ? WHERE id = ?
    `).run(
      'Public place description', 'Public address', '09:00', '10:00', '/uploads/public-place.jpg',
      'PLACE_SHARED_SENTINEL', 'FORBIDDEN_PROVIDER_SENTINEL', 'FORBIDDEN_WEBSITE_SENTINEL',
      'FORBIDDEN_PLACE_BOOKING_SENTINEL', place.id,
    );
    const assignment = createDayAssignment(testDb, day.id, place.id, { notes: 'FORBIDDEN_ASSIGNMENT_SENTINEL' });
    createDayNote(testDb, day.id, trip.id, { text: 'Public timeline note', time: '08:30' });

    const reservationResult = testDb.prepare(`
      INSERT INTO reservations (
        trip_id, day_id, end_day_id, assignment_id, title, type, status, reservation_time,
        reservation_end_time, location, confirmation_number, notes, metadata, day_plan_position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trip.id, day.id, day.id, assignment.id, 'Public flight', 'flight', 'confirmed',
      '2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z', 'Public terminal',
      'FORBIDDEN_CONFIRMATION_SENTINEL', 'FORBIDDEN_RESERVATION_NOTE_SENTINEL',
      JSON.stringify({
        airline: 'Safe Air',
        flight_number: 'SA100',
        provider_id: 'FORBIDDEN_METADATA_SENTINEL',
        legs: [{
          from: 'ICN', to: 'NRT', dep_day_id: day.id, dep_time: '11:00', arr_day_id: day.id,
          arr_time: '13:00', day_positions: { [day.id]: 1, ignored: 'FORBIDDEN_POSITION_SENTINEL' },
          secret: 'FORBIDDEN_LEG_SENTINEL',
        }],
      }),
      2,
    );
    const reservationId = Number(reservationResult.lastInsertRowid);
    testDb.prepare('INSERT INTO reservation_day_positions (reservation_id, day_id, position) VALUES (?, ?, ?)')
      .run(reservationId, day.id, 1.5);
    testDb.prepare(`
      INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id, confirmation, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(trip.id, place.id, day.id, day.id, 'FORBIDDEN_STAY_CONFIRMATION', 'FORBIDDEN_STAY_NOTE');
    testDb.prepare(`
      INSERT INTO packing_items (trip_id, name, category, checked, is_private, owner_id)
      VALUES (?, 'Public passport', 'Documents', 0, 0, ?)
    `).run(trip.id, user.id);
    testDb.prepare(`
      INSERT INTO packing_items (trip_id, name, category, checked, is_private, owner_id)
      VALUES (?, 'FORBIDDEN_PRIVATE_PACKING_SENTINEL', 'Private', 0, 1, ?)
    `).run(trip.id, user.id);
    testDb.prepare(`
      INSERT INTO budget_items (trip_id, category, name, total_price, currency, note)
      VALUES (?, 'Transport', 'Public fare', 12000, 'KRW', 'FORBIDDEN_BUDGET_NOTE_SENTINEL')
    `).run(trip.id);
    testDb.prepare(`
      INSERT INTO collab_messages (trip_id, user_id, text, deleted)
      VALUES (?, ?, 'Public chat message', 0)
    `).run(trip.id, user.id);

    const created = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({
        share_map: true,
        share_bookings: true,
        share_packing: true,
        share_budget: true,
        share_collab: true,
      });
    const res = await request(app).get(`/api/shared/${created.body.token}`);

    expect(res.status).toBe(200);
    expect(keys(res.body)).toEqual([
      'accommodations', 'assignments', 'baseCurrency', 'budget', 'cartoApiKey', 'categories', 'collab',
      'dayNotes', 'days', 'packing', 'permissions', 'places', 'reservations', 'trip',
    ].sort());
    expect(keys(res.body.trip)).toEqual(['cover_image', 'currency', 'description', 'end_date', 'start_date', 'title']);
    expect(keys(res.body.permissions)).toEqual([
      'share_bookings', 'share_budget', 'share_collab', 'share_map', 'share_packing',
    ]);
    expect(keys(res.body.days[0])).toEqual(['date', 'day_number', 'id', 'title']);
    expect(keys(res.body.assignments[day.id][0])).toEqual(['id', 'order_index', 'place']);
    expect(keys(res.body.assignments[day.id][0].place)).toEqual([
      'address', 'category', 'category_id', 'description', 'end_time', 'id', 'image_url', 'lat', 'lng',
      'name', 'notes', 'place_time',
    ]);
    expect(keys(res.body.assignments[day.id][0].place.category)).toEqual(['color', 'icon']);
    expect(keys(res.body.places[0])).toEqual([
      'category_color', 'category_icon', 'id', 'lat', 'lng', 'name', 'notes',
    ]);
    expect(keys(res.body.categories[0])).toEqual(['color', 'id']);
    expect(keys(res.body.dayNotes[day.id][0])).toEqual(['id', 'sort_order', 'text', 'time']);
    expect(keys(res.body.reservations[0])).toEqual([
      'assignment_id', 'day_id', 'day_plan_position', 'day_positions', 'end_day_id', 'id', 'location',
      'metadata', 'reservation_end_time', 'reservation_time', 'status', 'title', 'type',
    ]);
    expect(keys(res.body.reservations[0].metadata)).toEqual(['airline', 'flight_number', 'legs']);
    expect(keys(res.body.reservations[0].metadata.legs[0])).toEqual([
      'arr_day_id', 'arr_time', 'day_positions', 'dep_day_id', 'dep_time', 'from', 'to',
    ]);
    expect(keys(res.body.reservations[0].metadata.legs[0].day_positions)).toEqual([String(day.id)]);
    expect(keys(res.body.accommodations[0])).toEqual(['end_day_id', 'id', 'place_name', 'start_day_id']);
    expect(keys(res.body.packing[0])).toEqual(['category', 'checked', 'id', 'name']);
    expect(keys(res.body.budget[0])).toEqual(['category', 'currency', 'id', 'name', 'total_price']);
    expect(keys(res.body.collab[0])).toEqual(['avatar', 'created_at', 'id', 'text', 'username']);
    expect(res.body.assignments[day.id][0].place.notes).toBe('PLACE_SHARED_SENTINEL');
    expect(res.body.places[0].notes).toBe('PLACE_SHARED_SENTINEL');

    const serialized = JSON.stringify(res.body);
    for (const forbidden of [
      'FORBIDDEN_DAY_ROW_SENTINEL', 'FORBIDDEN_PROVIDER_SENTINEL', 'FORBIDDEN_WEBSITE_SENTINEL',
      'FORBIDDEN_PLACE_BOOKING_SENTINEL', 'FORBIDDEN_ASSIGNMENT_SENTINEL',
      'FORBIDDEN_CONFIRMATION_SENTINEL', 'FORBIDDEN_RESERVATION_NOTE_SENTINEL',
      'FORBIDDEN_METADATA_SENTINEL', 'FORBIDDEN_POSITION_SENTINEL', 'FORBIDDEN_LEG_SENTINEL',
      'FORBIDDEN_STAY_CONFIRMATION', 'FORBIDDEN_STAY_NOTE', 'FORBIDDEN_PRIVATE_PACKING_SENTINEL',
      'FORBIDDEN_BUDGET_NOTE_SENTINEL',
    ]) expect(serialized).not.toContain(forbidden);
  });

  it('SHARE-031b — disabled flags keep empty shapes and issue no section query', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);
    const place = createPlace(testDb, trip.id, { name: 'NO_QUERY_PLACE_SENTINEL' });
    createDayAssignment(testDb, day.id, place.id);
    testDb.prepare("UPDATE places SET notes = 'NO_QUERY_NOTE_SENTINEL' WHERE id = ?").run(place.id);
    testDb.prepare("INSERT INTO reservations (trip_id, title) VALUES (?, 'NO_QUERY_BOOKING_SENTINEL')").run(trip.id);
    testDb.prepare("INSERT INTO packing_items (trip_id, name) VALUES (?, 'NO_QUERY_PACKING_SENTINEL')").run(trip.id);
    testDb.prepare("INSERT INTO budget_items (trip_id, name) VALUES (?, 'NO_QUERY_BUDGET_SENTINEL')").run(trip.id);
    testDb.prepare("INSERT INTO collab_messages (trip_id, user_id, text, deleted) VALUES (?, ?, 'NO_QUERY_COLLAB_SENTINEL', 0)")
      .run(trip.id, user.id);
    const created = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({
        share_map: false,
        share_bookings: false,
        share_packing: false,
        share_budget: false,
        share_collab: false,
      });

    const allSpy = vi.spyOn(DatabaseService.prototype, 'all');
    const getSpy = vi.spyOn(DatabaseService.prototype, 'get');
    try {
      const res = await request(app).get(`/api/shared/${created.body.token}`);
      expect(res.status).toBe(200);
      expect(res.body.days).toEqual([]);
      expect(res.body.assignments).toEqual({});
      expect(res.body.dayNotes).toEqual({});
      expect(res.body.places).toEqual([]);
      expect(res.body.categories).toEqual([]);
      expect(res.body.reservations).toEqual([]);
      expect(res.body.accommodations).toEqual([]);
      expect(res.body.packing).toEqual([]);
      expect(res.body.budget).toEqual([]);
      expect(res.body.collab).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain('NO_QUERY_');

      const allSql = allSpy.mock.calls.map(([sql]) => String(sql)).join('\n').toLowerCase();
      const getSql = getSpy.mock.calls.map(([sql]) => String(sql)).join('\n').toLowerCase();
      for (const table of [
        'days', 'day_assignments', 'day_notes', 'places', 'categories', 'reservations',
        'day_accommodations', 'packing_items', 'budget_items', 'collab_messages',
      ]) expect(allSql).not.toContain(table);
      expect(getSql).not.toContain('settings');
      expect(getSql).not.toContain('app_settings');
    } finally {
      allSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  it('SHARE-031c — malformed booking metadata and cross-trip place links fail closed over HTTP', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const otherTrip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id);
    const foreignPlace = createPlace(testDb, otherTrip.id, { name: 'FOREIGN_PLACE_SENTINEL' });
    testDb.prepare("UPDATE places SET notes = 'FOREIGN_NOTE_SENTINEL' WHERE id = ?").run(foreignPlace.id);
    createDayAssignment(testDb, day.id, foreignPlace.id, { notes: 'FOREIGN_ASSIGNMENT_SENTINEL' });
    testDb.prepare(`
      INSERT INTO day_accommodations (trip_id, place_id, start_day_id, end_day_id)
      VALUES (?, ?, ?, ?)
    `).run(trip.id, foreignPlace.id, day.id, day.id);
    testDb.prepare(`
      INSERT INTO reservations (trip_id, title, metadata)
      VALUES (?, 'Malformed metadata booking', '{not-json')
    `).run(trip.id);

    const created = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_map: true, share_bookings: true });
    const res = await request(app).get(`/api/shared/${created.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.assignments).toEqual({});
    expect(res.body.accommodations).toEqual([]);
    expect(res.body.reservations).toHaveLength(1);
    expect(res.body.reservations[0].metadata).toEqual({});
    expect(JSON.stringify(res.body)).not.toContain('FOREIGN_');
  });

  it('SHARE-007 — GET /shared/:token hides budget when share_budget=false', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: false });
    const token = create.body.token;

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    // Budget should be an empty array when share_budget is false
    expect(Array.isArray(res.body.budget)).toBe(true);
    expect(res.body.budget).toHaveLength(0);
  });

  // Regression: a co-member's private packing item (#858) must never reach a public share.
  it('SHARE-026 — hides private packing items from the public payload', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    testDb.prepare("INSERT INTO packing_items (trip_id, name, category, checked, is_private, owner_id) VALUES (?, 'Private thing', 'Misc', 0, 1, ?)").run(trip.id, user.id);
    testDb.prepare("INSERT INTO packing_items (trip_id, name, category, checked, is_private, owner_id) VALUES (?, 'Common thing', 'Misc', 0, 0, ?)").run(trip.id, user.id);
    const create = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_packing: true });
    const res = await request(app).get(`/api/shared/${create.body.token}`);
    expect(res.status).toBe(200);
    const names = (res.body.packing || []).map((p: any) => p.name);
    expect(names).toContain('Common thing');
    expect(names).not.toContain('Private thing');
  });

  // Regression — GHSA-9hc8-p7gm-p7mx: share_map must be enforced server-side, not
  // just hidden in the client. When the owner disables the map, the itinerary and
  // every place (with coordinates) must be withheld from the public payload.
  it('SHARE-024 — hides itinerary and places when share_map=false', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Secret Route' });
    const day = createDay(testDb, trip.id, { date: '2025-06-01' });
    const place = createPlace(testDb, trip.id, { name: 'Safehouse', lat: 12.3456, lng: 65.4321 });
    createDayAssignment(testDb, day.id, place.id);
    createDayNote(testDb, day.id, trip.id, { text: 'Do not share' });

    const create = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_map: false, share_packing: true });
    const token = create.body.token;

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.permissions.share_map).toBe(false);
    // Itinerary + place data withheld…
    expect(res.body.days).toHaveLength(0);
    expect(res.body.places).toHaveLength(0);
    expect(res.body.assignments).toEqual({});
    expect(res.body.dayNotes).toEqual({});
    // …and the coordinates never appear anywhere in the response.
    expect(JSON.stringify(res.body)).not.toContain('12.3456');
    expect(JSON.stringify(res.body)).not.toContain('65.4321');
  });

  it('SHARE-008 — GET /shared/:invalid-token returns 404', async () => {
    const res = await request(app).get('/api/shared/invalid-token-xyz');
    expect(res.status).toBe(404);
  });

  it('SHARE-009 — non-member cannot create share link', async () => {
    const { user: owner } = createUser(testDb);
    const { user: other } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);

    const res = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(other.id))
      .send({});
    expect(res.status).toBe(404);
  });

  it('SHARE-026 — a plain member cannot read the share token', async () => {
    // Reading the link hands out the credential for the anonymous /api/shared
    // page, which outlives the membership that was used to fetch it. Under the
    // default policy share_manage stays with the owner.
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    await request(app).post(`/api/trips/${trip.id}/share-link`).set('Cookie', authCookie(owner.id)).send({});

    const res = await request(app).get(`/api/trips/${trip.id}/share-link`).set('Cookie', authCookie(member.id));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'No permission' });
  });

  it('SHARE-027 — the owner still reads it, and a non-member still gets 404 rather than 403', async () => {
    const { user: owner } = createUser(testDb);
    const { user: stranger } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    await request(app).post(`/api/trips/${trip.id}/share-link`).set('Cookie', authCookie(owner.id)).send({});

    const mine = await request(app).get(`/api/trips/${trip.id}/share-link`).set('Cookie', authCookie(owner.id));
    expect(mine.status).toBe(200);
    expect(mine.body.token).toBeTruthy();

    // 404, not 403: a stranger must not learn that the trip id exists.
    const theirs = await request(app).get(`/api/trips/${trip.id}/share-link`).set('Cookie', authCookie(stranger.id));
    expect(theirs.status).toBe(404);
  });

  it('SHARE-028 — a member may read it once the instance lowers share_manage to trip_member', async () => {
    const { user: owner } = createUser(testDb);
    const { user: member } = createUser(testDb);
    const trip = createTrip(testDb, owner.id);
    addTripMember(testDb, trip.id, member.id);
    await request(app).post(`/api/trips/${trip.id}/share-link`).set('Cookie', authCookie(owner.id)).send({});

    const { invalidatePermissionsCache } = await import('../../src/nest/permissions/permissions-cache');
    testDb.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('perm_share_manage', 'trip_member')").run();
    invalidatePermissionsCache();
    try {
      const res = await request(app).get(`/api/trips/${trip.id}/share-link`).set('Cookie', authCookie(member.id));
      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
    } finally {
      // Module-scoped cache: leaving it set would decide the next file's tests.
      testDb.prepare("DELETE FROM app_settings WHERE key = 'perm_share_manage'").run();
      invalidatePermissionsCache();
    }
  });
});

describe('Shared trip — day assignments and notes', () => {
  it('SHARE-010 — shared trip with days and assignments includes place data in assignments', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Rome Trip' });
    const day = createDay(testDb, trip.id, { date: '2025-06-01' });
    const place = createPlace(testDb, trip.id, { name: 'Colosseum', lat: 41.89, lng: 12.49 });
    createDayAssignment(testDb, day.id, place.id, { notes: 'Amazing site' });
    testDb.prepare('UPDATE places SET notes = ? WHERE id = ?').run('PLACE_SHARED_SENTINEL', place.id);

    const create = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});
    const token = create.body.token;

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(1);
    const dayAssignments = res.body.assignments[day.id];
    expect(Array.isArray(dayAssignments)).toBe(true);
    expect(dayAssignments).toHaveLength(1);
    expect(dayAssignments[0].place.name).toBe('Colosseum');
    expect(dayAssignments[0].place.lat).toBe(41.89);
    expect(dayAssignments[0].place.notes).toBe('PLACE_SHARED_SENTINEL');
    expect(res.body.places.find((entry: any) => entry.id === place.id).notes).toBe('PLACE_SHARED_SENTINEL');
    expect(JSON.stringify(res.body)).not.toContain('Amazing site');
  });

  it('SHARE-011 — shared trip with day notes includes notes in response', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id, { title: 'Notes Trip' });
    const day = createDay(testDb, trip.id, { date: '2025-07-01' });
    createDayNote(testDb, day.id, trip.id, { text: 'Meet at the station' });

    const create = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});
    const token = create.body.token;

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    const dayNotes = res.body.dayNotes[day.id];
    expect(Array.isArray(dayNotes)).toBe(true);
    expect(dayNotes).toHaveLength(1);
    expect(dayNotes[0].text).toBe('Meet at the station');
  });

  it('SHARE-012 — share_collab=true includes collab messages in response', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    testDb.prepare('INSERT INTO collab_messages (trip_id, user_id, text, deleted) VALUES (?, ?, ?, 0)').run(trip.id, user.id, 'Hello team!');

    const create = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_collab: true });
    const token = create.body.token;

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.collab)).toBe(true);
    expect(res.body.collab).toHaveLength(1);
    expect(res.body.collab[0].text).toBe('Hello team!');
  });

  it('SHARE-013 — assignments empty when days have no assignments', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    createDay(testDb, trip.id, { date: '2025-08-01' });

    const create = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});
    const token = create.body.token;

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.assignments).toEqual({});
  });
});

describe('Shared trip — ordering parity (issue #981)', () => {
  it('SHARE-014 — assignments with same order_index are ordered by created_at (tiebreaker)', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id, { date: '2025-09-01' });
    const place1 = createPlace(testDb, trip.id, { name: 'First Created' });
    const place2 = createPlace(testDb, trip.id, { name: 'Second Created' });

    // Both with order_index = 0 (schema default) but different created_at
    testDb.prepare(
      "INSERT INTO day_assignments (day_id, place_id, order_index, created_at) VALUES (?, ?, 0, '2025-01-01T10:00:00')"
    ).run(day.id, place1.id);
    testDb.prepare(
      "INSERT INTO day_assignments (day_id, place_id, order_index, created_at) VALUES (?, ?, 0, '2025-01-01T11:00:00')"
    ).run(day.id, place2.id);

    const { body: { token } } = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    const assignments = res.body.assignments[day.id];
    expect(assignments).toHaveLength(2);
    expect(assignments[0].place.name).toBe('First Created');
    expect(assignments[1].place.name).toBe('Second Created');
  });

  it('SHARE-015 — reservations include day_positions map from reservation_day_positions table', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id, { date: '2025-09-01' });

    const res1 = testDb.prepare(
      "INSERT INTO reservations (trip_id, title, type, day_id, reservation_time) VALUES (?, ?, ?, ?, ?)"
    ).run(trip.id, 'Test Flight', 'flight', day.id, '2025-09-01T09:00:00');
    const reservationId = Number(res1.lastInsertRowid);

    // Insert a per-day position
    testDb.prepare(
      'INSERT INTO reservation_day_positions (reservation_id, day_id, position) VALUES (?, ?, ?)'
    ).run(reservationId, day.id, 1.5);

    const { body: { token } } = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_bookings: true });

    const shareRes = await request(app).get(`/api/shared/${token}`);
    expect(shareRes.status).toBe(200);
    const reservation = shareRes.body.reservations.find((r: any) => r.id === reservationId);
    expect(reservation).toBeDefined();
    expect(reservation.day_positions).toBeDefined();
    expect(reservation.day_positions[day.id]).toBe(1.5);
  });
});

describe('Shared trip — display currency (issue #1361)', () => {
  it('SHARE-021 — baseCurrency resolves from the share owner\'s default_currency setting', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    // Trip keeps the EUR default; the owner's Costs display currency is CAD.
    testDb.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, 'default_currency', ?)")
      .run(user.id, JSON.stringify('CAD'));

    const { body: { token } } = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: true });

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.baseCurrency).toBe('CAD');
  });

  it('SHARE-022 — baseCurrency falls back to the trip currency when the owner has no setting', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    testDb.prepare('UPDATE trips SET currency = ? WHERE id = ?').run('GBP', trip.id);

    const { body: { token } } = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: true });

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.baseCurrency).toBe('GBP');
  });

  it('SHARE-023 — baseCurrency uses the admin instance default when the owner has no per-user setting', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id); // EUR trip default, no user setting
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('default_user_setting_default_currency', ?)")
      .run(JSON.stringify('USD'));

    const { body: { token } } = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_budget: true });

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.baseCurrency).toBe('USD');
  });
});

describe('Shared trip: CARTO tile key privacy', () => {
  it('SHARE-029: the payload never carries an owner or instance CARTO key', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    testDb.prepare("INSERT INTO app_settings (key, value) VALUES ('default_user_setting_carto_api_key', 'instance-key')").run();

    const { body: { token } } = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_map: true });

    const inherited = await request(app).get(`/api/shared/${token}`);
    expect(inherited.status).toBe(200);
    expect(inherited.body.cartoApiKey).toBe('');

    testDb.prepare("INSERT INTO settings (user_id, key, value) VALUES (?, 'carto_api_key', 'owner-key')").run(user.id);
    const own = await request(app).get(`/api/shared/${token}`);
    expect(own.body.cartoApiKey).toBe('');
  });
});

describe('Shared trip — place photos in shared links (issue #1100)', () => {
  const PLACE_ID = 'ChIJsharedPhoto1100';
  const PROXY_URL = `/api/maps/place-photo/${encodeURIComponent(PLACE_ID)}/bytes`;
  const photoBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  let cachedFilePath: string;

  afterAll(() => { try { if (cachedFilePath) fs.unlinkSync(cachedFilePath); } catch { /* ignore */ } });

  async function setupSharedPlaceWithPhoto() {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const place = createPlace(testDb, trip.id, { name: 'Photo Place' });
    testDb.prepare('UPDATE places SET image_url = ?, google_place_id = ? WHERE id = ?').run(PROXY_URL, PLACE_ID, place.id);

    const { body: { token } } = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});
    return { token, place, trip, user };
  }

  it('SHARE-016 — compact top-level map places omit image_url', async () => {
    const { token } = await setupSharedPlaceWithPhoto();
    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.places).toHaveLength(1);
    expect(res.body.places[0]).not.toHaveProperty('image_url');
  });

  it('SHARE-017 — shared payload rewrites assignment place image_url too', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const day = createDay(testDb, trip.id, { date: '2025-10-01' });
    const place = createPlace(testDb, trip.id, { name: 'Assigned Photo Place' });
    testDb.prepare('UPDATE places SET image_url = ? WHERE id = ?').run(PROXY_URL, place.id);
    createDayAssignment(testDb, day.id, place.id, {});

    const { body: { token } } = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});

    const res = await request(app).get(`/api/shared/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.assignments[day.id][0].place.image_url)
      .toBe(`/api/shared/${token}/place-photo/${encodeURIComponent(PLACE_ID)}/bytes`);
  });

  it('SHARE-018 — public proxy streams cached bytes for a valid token + place (no cookie)', async () => {
    const { token } = await setupSharedPlaceWithPhoto();
    await placePhotoCache.put(PLACE_ID, photoBytes, null);
    cachedFilePath = path.join(DEFAULT_UPLOADS_ROOT, 'photos/google', `${crypto.createHash('sha1').update(PLACE_ID).digest('hex')}.jpg`);

    const res = await request(app).get(`/api/shared/${token}/place-photo/${encodeURIComponent(PLACE_ID)}/bytes`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(res.body)).toEqual(photoBytes);
  });

  // Every miss shape answers the same empty 204 (fix: mirrors the maps proxy,
  // #1727 extended to shared pages). The service still collapses "not in
  // trip" / "bad token" / "map disabled" into one indistinguishable null, so
  // no authorization detail leaks through the status change.
  it('SHARE-019 — public proxy answers an empty 204 for a placeId not in the shared trip', async () => {
    const { token } = await setupSharedPlaceWithPhoto();
    const res = await request(app).get(`/api/shared/${token}/place-photo/ChIJnotInTrip/bytes`);
    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text ?? '').toBe('');
  });

  it('SHARE-020 — public proxy answers an empty 204 for an invalid token', async () => {
    await setupSharedPlaceWithPhoto();
    const res = await request(app).get(`/api/shared/bad-token/place-photo/${encodeURIComponent(PLACE_ID)}/bytes`);
    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text ?? '').toBe('');
  });

  it('SHARE-020b — an expired token returns payload 404 and photo 204 with no-store', async () => {
    const { token, trip } = await setupSharedPlaceWithPhoto();
    await placePhotoCache.put(PLACE_ID, photoBytes, null);
    cachedFilePath = path.join(DEFAULT_UPLOADS_ROOT, 'photos/google', `${crypto.createHash('sha1').update(PLACE_ID).digest('hex')}.jpg`);
    expect((await request(app).get(`/api/shared/${token}`)).status).toBe(200);
    expect((await request(app).get(`/api/shared/${token}/place-photo/${encodeURIComponent(PLACE_ID)}/bytes`)).status).toBe(200);

    testDb.prepare('UPDATE share_tokens SET expires_at = ? WHERE trip_id = ?')
      .run('2020-01-01T00:00:00.000Z', trip.id);

    expect((await request(app).get(`/api/shared/${token}`)).status).toBe(404);
    const expiredPhoto = await request(app).get(`/api/shared/${token}/place-photo/${encodeURIComponent(PLACE_ID)}/bytes`);
    expect(expiredPhoto.status).toBe(204);
    expect(expiredPhoto.headers['cache-control']).toBe('no-store');
  });

  // Regression — GHSA-9hc8 sibling: place photos are part of the map/itinerary,
  // so the proxy must stream nothing when the owner disabled the map, even
  // with a valid token + cached bytes.
  it('SHARE-025 — public place-photo proxy streams nothing when share_map=false', async () => {
    const { user } = createUser(testDb);
    const trip = createTrip(testDb, user.id);
    const place = createPlace(testDb, trip.id, { name: 'Hidden Photo Place' });
    testDb.prepare('UPDATE places SET image_url = ?, google_place_id = ? WHERE id = ?').run(PROXY_URL, PLACE_ID, place.id);
    const { body: { token } } = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({ share_map: false });
    await placePhotoCache.put(PLACE_ID, photoBytes, null);
    cachedFilePath = path.join(DEFAULT_UPLOADS_ROOT, 'photos/google', `${crypto.createHash('sha1').update(PLACE_ID).digest('hex')}.jpg`);

    const res = await request(app).get(`/api/shared/${token}/place-photo/${encodeURIComponent(PLACE_ID)}/bytes`);
    expect(res.status).toBe(204);
    expect(res.text ?? '').toBe('');
  });

  it('SHARE-032 — revocation closes payload/photo access and reissue uses a different token', async () => {
    const { token, trip, user } = await setupSharedPlaceWithPhoto();
    await placePhotoCache.put(PLACE_ID, photoBytes, null);
    cachedFilePath = path.join(DEFAULT_UPLOADS_ROOT, 'photos/google', `${crypto.createHash('sha1').update(PLACE_ID).digest('hex')}.jpg`);

    expect((await request(app).get(`/api/shared/${token}`)).status).toBe(200);
    expect((await request(app).get(`/api/shared/${token}/place-photo/${encodeURIComponent(PLACE_ID)}/bytes`)).status).toBe(200);

    const revoked = await request(app)
      .delete(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id));
    expect(revoked.status).toBe(200);

    expect((await request(app).get(`/api/shared/${token}`)).status).toBe(404);
    const revokedPhoto = await request(app).get(`/api/shared/${token}/place-photo/${encodeURIComponent(PLACE_ID)}/bytes`);
    expect(revokedPhoto.status).toBe(204);
    expect(revokedPhoto.headers['cache-control']).toBe('no-store');

    const reissued = await request(app)
      .post(`/api/trips/${trip.id}/share-link`)
      .set('Cookie', authCookie(user.id))
      .send({});
    expect(reissued.status).toBe(201);
    expect(reissued.body.token).not.toBe(token);
    expect(reissued.body.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect((await request(app).get(`/api/shared/${reissued.body.token}`)).status).toBe(200);
    expect((await request(app).get(`/api/shared/${reissued.body.token}/place-photo/${encodeURIComponent(PLACE_ID)}/bytes`)).status).toBe(200);
  });
});
