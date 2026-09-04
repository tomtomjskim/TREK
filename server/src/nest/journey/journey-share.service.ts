import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { DatabaseService } from '../database/database.service';
import { JourneyDomainService } from './journey-domain.service';

interface JourneySharePermissions {
  share_timeline?: boolean;
  share_gallery?: boolean;
  share_map?: boolean;
  /** Read the journey newest-first, like a blog, rather than in trip order. */
  newest_first?: boolean;
}

interface JourneyShareTokenInfo {
  token: string;
  created_at: string;
  share_timeline: boolean;
  share_gallery: boolean;
  share_map: boolean;
  newest_first: boolean;
}

// A gallery photo is public when it is either an explicit gallery-only item or
// is attached to at least one entry the owner marked shared/public. A photo that
// is attached exclusively to private entries must not escape through the
// gallery JSON or either byte proxy. `journey_photos.shared` is intentionally
// not used here: direct/provider uploads write 0 and the public gallery toggle
// is `journey_share_tokens.share_gallery`.
const PUBLIC_GALLERY_PHOTO_SCOPE = `
  AND (
    NOT EXISTS (
      SELECT 1 FROM journey_entry_photos any_link
      WHERE any_link.journey_photo_id = gp.id
    )
    OR EXISTS (
      SELECT 1
      FROM journey_entry_photos public_link
      JOIN journey_entries public_entry ON public_entry.id = public_link.entry_id
      WHERE public_link.journey_photo_id = gp.id
        AND public_entry.journey_id = gp.journey_id
        AND public_entry.type != 'skeleton'
        AND public_entry.visibility IN ('shared', 'public')
    )
  )
`;

/**
 * Public share links for a journey: minting the token, validating it for a
 * photo or a provider asset, and the read-only public view.
 *
 * Folded 1:1 from services/journeyShareService.ts. It injects
 * JourneyDomainService for the owner check — the two files could never be split
 * because that check lives there.
 */
@Injectable()
export class JourneyShareService {
  constructor(
    private readonly db: DatabaseService,
    private readonly journey: JourneyDomainService,
  ) {}

  createOrUpdateJourneyShareLink(
    journeyId: number,
    createdBy: number,
    permissions: JourneySharePermissions
  ): { token: string; created: boolean } | null {
    // Public sharing is an owner-only action — editors/viewers must not be
    // able to publish the journey or change which screens are shared.
    if (!this.journey.isOwner(journeyId, createdBy)) return null;

    const existing = this.db.prepare('SELECT token, share_timeline, share_gallery, share_map, newest_first FROM journey_share_tokens WHERE journey_id = ?')
      .get(journeyId) as { token: string; share_timeline: number; share_gallery: number; share_map: number; newest_first: number } | undefined;

    if (existing) {
      // An update only changes the flags it was actually given. Falling back to
      // the create-time defaults here would silently re-publish a gallery or map
      // the owner had switched off, at the unchanged token.
      const share_timeline = permissions.share_timeline ?? !!existing.share_timeline;
      const share_gallery = permissions.share_gallery ?? !!existing.share_gallery;
      const share_map = permissions.share_map ?? !!existing.share_map;
      const newest_first = permissions.newest_first ?? !!existing.newest_first;
      this.db.prepare('UPDATE journey_share_tokens SET share_timeline = ?, share_gallery = ?, share_map = ?, newest_first = ? WHERE journey_id = ?')
        .run(share_timeline ? 1 : 0, share_gallery ? 1 : 0, share_map ? 1 : 0, newest_first ? 1 : 0, journeyId);
      return { token: existing.token, created: false };
    }

    const {
      share_timeline = true,
      share_gallery = true,
      share_map = true,
      newest_first = false,
    } = permissions;

    const token = crypto.randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO journey_share_tokens (journey_id, token, created_by, share_timeline, share_gallery, share_map, newest_first) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(journeyId, token, createdBy, share_timeline ? 1 : 0, share_gallery ? 1 : 0, share_map ? 1 : 0, newest_first ? 1 : 0);
    return { token, created: true };
  }

  /**
   * Read the link on behalf of a user. Owner only, the same check create and
   * delete take: the token is the whole credential and it keeps working after a
   * contributor is removed, so handing it out is handing out the journey.
   *
   * The refusal is its own answer rather than a null link, because those two
   * mean opposite things to the caller — a published journey that reads as
   * unpublished puts a "create link" button in front of somebody it will then
   * refuse. Both the REST route and the MCP tool read the link through here.
   */
  readJourneyShareLink(
    journeyId: number,
    userId: number,
  ): { allowed: false } | { allowed: true; link: JourneyShareTokenInfo | null } {
    if (!this.journey.isOwner(journeyId, userId)) return { allowed: false };
    return { allowed: true, link: this.getJourneyShareLink(journeyId) };
  }

  getJourneyShareLink(journeyId: number): JourneyShareTokenInfo | null {
    const row = this.db.prepare('SELECT * FROM journey_share_tokens WHERE journey_id = ?').get(journeyId) as any;
    if (!row) return null;
    return {
      token: row.token,
      created_at: row.created_at,
      share_timeline: !!row.share_timeline,
      share_gallery: !!row.share_gallery,
      share_map: !!row.share_map,
      newest_first: !!row.newest_first,
    };
  }

  deleteJourneyShareLink(journeyId: number, userId: number): boolean {
    if (!this.journey.isOwner(journeyId, userId)) return false;
    this.db.prepare('DELETE FROM journey_share_tokens WHERE journey_id = ?').run(journeyId);
    return true;
  }

  validateShareTokenForPhoto(token: string, photoId: number): { journeyId: number; ownerId: number } | null {
    const row = this.db.prepare('SELECT journey_id, share_gallery FROM journey_share_tokens WHERE token = ?').get(token) as any;
    if (!row) return null;
    // Photos only ever surface (inline or in the gallery) when share_gallery is on,
    // so the byte proxy must honour the flag server-side too — the JSON payload
    // already strips photos when it is off. Enumerable photo ids otherwise stay
    // fetchable after the owner disables the gallery.
    if (!row.share_gallery) return null;
    const photo = this.db.prepare(`
      SELECT gp.photo_id, tkp.owner_id, gp.journey_id
      FROM journey_photos gp
      JOIN trek_photos tkp ON tkp.id = gp.photo_id
      WHERE gp.photo_id = ? AND gp.journey_id = ?
      ${PUBLIC_GALLERY_PHOTO_SCOPE}
    `).get(photoId, row.journey_id) as any;
    if (!photo) return null;
    const journey = this.db.prepare('SELECT user_id FROM journeys WHERE id = ?').get(row.journey_id) as any;
    return journey ? { journeyId: row.journey_id, ownerId: photo.owner_id || journey.user_id } : null;
  }

  validateShareTokenForAsset(token: string, provider: string, assetId: string): { ownerId: number } | null {
    const row = this.db.prepare('SELECT journey_id, share_gallery FROM journey_share_tokens WHERE token = ?').get(token) as any;
    if (!row) return null;
    // Same as the unified photo proxy: no asset bytes leave the host unless the
    // owner shared the gallery.
    if (!row.share_gallery) return null;
    const photo = this.db.prepare(`
      SELECT tkp.owner_id, j.user_id AS journey_owner_id
      FROM journey_photos gp
      JOIN trek_photos tkp ON tkp.id = gp.photo_id
      JOIN journeys j ON j.id = gp.journey_id
      WHERE tkp.provider = ? AND tkp.asset_id = ? AND gp.journey_id = ?
      ${PUBLIC_GALLERY_PHOTO_SCOPE}
    `).get(provider, assetId, row.journey_id) as any;
    // Only resolve assets that actually belong to this shared journey.
    if (!photo) return null;
    // trek_photos.owner_id can be NULL. The journey's owner is the fallback, the
    // same one the photo proxy uses. Whose provider credentials get tried must
    // never come from a number an anonymous caller put in the URL.
    return { ownerId: photo.owner_id || photo.journey_owner_id };
  }

  getPublicJourney(token: string) {
    const row = this.db.prepare(`
      SELECT journey_id, share_timeline, share_gallery, share_map, newest_first
      FROM journey_share_tokens
      WHERE token = ?
    `).get(token) as any;
    if (!row) return null;

    const journey = this.db.prepare(`
      SELECT title, subtitle, cover_image, status
      FROM journeys
      WHERE id = ?
    `).get(row.journey_id) as any;
    if (!journey) return null;

    const shareTimeline = !!row.share_timeline;
    const shareGallery = !!row.share_gallery;
    const shareMap = !!row.share_map;

    // Only load the sections that can be returned. Besides avoiding needless
    // work, this keeps a disabled flag from touching private provider metadata.
    const entries = shareTimeline || shareMap
      ? this.db.prepare(`
          SELECT je.id, je.type, je.title, je.story, je.entry_date, je.entry_time,
                 je.location_name, je.location_lat, je.location_lng, je.mood,
                 je.weather, je.tags, je.pros_cons
          FROM journey_entries je
          WHERE je.journey_id = ? AND je.type != 'skeleton'
            AND je.visibility IN ('shared', 'public')
          ORDER BY je.entry_date, je.sort_order
        `).all(row.journey_id) as any[]
      : [];

    const photos = shareTimeline && shareGallery
      ? this.db.prepare(`
          SELECT gp.id, jep.entry_id, gp.photo_id, gp.caption,
                 tkp.media_type, tkp.duration_ms, tkp.taken_at, tkp.lat, tkp.lng
          FROM journey_entry_photos jep
          JOIN journey_photos gp ON gp.id = jep.journey_photo_id
          JOIN trek_photos tkp ON tkp.id = gp.photo_id
          JOIN journey_entries je ON je.id = jep.entry_id
          WHERE gp.journey_id = ?
            AND je.journey_id = gp.journey_id
            AND je.type != 'skeleton'
            AND je.visibility IN ('shared', 'public')
          ${PUBLIC_GALLERY_PHOTO_SCOPE}
          ORDER BY jep.sort_order
        `).all(row.journey_id) as any[]
      : [];

    const photosByEntry: Record<number, any[]> = {};
    for (const p of photos) {
      (photosByEntry[p.entry_id] ||= []).push(projectPublicPhoto(p));
    }

    const gallery = shareGallery
      ? this.db.prepare(`
          SELECT gp.id, gp.photo_id, gp.caption,
                 tkp.media_type, tkp.duration_ms, tkp.taken_at, tkp.lat, tkp.lng
          FROM journey_photos gp
          JOIN trek_photos tkp ON tkp.id = gp.photo_id
          WHERE gp.journey_id = ?
          ${PUBLIC_GALLERY_PHOTO_SCOPE}
          ORDER BY gp.sort_order
        `).all(row.journey_id) as any[]
      : [];

    const enrichedEntries = entries.map(e => ({
      ...projectPublicEntry(e),
      photos: photosByEntry[e.id] || [],
    }));

    const stats = {
      entries: shareTimeline ? enrichedEntries.length : 0,
      photos: shareGallery ? gallery.length : 0,
      places: shareMap ? new Set(entries.filter(e => e.location_name).map(e => e.location_name)).size : 0,
    };

    // Honour the share flags server-side so the API only returns the sections the
    // owner enabled (the client gates these too, but it must not rely on that).
    let publicEntries: Record<string, unknown>[] = [];
    if (shareTimeline) {
      // Include the full entry, but drop GPS unless the map is shared and inline
      // photos unless the gallery is shared.
      publicEntries = enrichedEntries.map(e => {
        const projected: Record<string, unknown> = { ...e };
        if (!shareMap) { projected.location_lat = null; projected.location_lng = null; }
        if (!shareGallery) projected.photos = [];
        else if (!shareMap) projected.photos = stripPhotoGps(e.photos);
        return projected;
      });
    } else if (shareMap) {
      // Map-only share: just enough to plot markers, no story/photos/mood.
      publicEntries = entries.map(e => ({
        id: e.id,
        type: e.type,
        entry_date: e.entry_date,
        title: e.title,
        location_name: e.location_name,
        location_lat: e.location_lat,
        location_lng: e.location_lng,
      }));
    }

    return {
      journey: {
        title: journey.title,
        subtitle: journey.subtitle,
        cover_image: journey.cover_image,
        status: journey.status,
      },
      entries: publicEntries,
      // A photo now carries the coordinates it was taken at, which is a location the
      // owner never typed and may not expect to publish. It follows share_map, the
      // same switch the entry coordinates follow — otherwise a gallery-only share
      // would hand out places the map was deliberately turned off for.
      gallery: shareGallery
        ? (shareMap
          ? gallery.map(projectPublicGalleryPhoto)
          : stripPhotoGps(gallery.map(projectPublicGalleryPhoto)))
        : [],
      stats,
      // Kept as an empty compatibility field. Anonymous viewers use the
      // keyless OpenFreeMap fallback and never receive an operator credential.
      cartoApiKey: '',
      permissions: {
        share_timeline: shareTimeline,
        share_gallery: shareGallery,
        share_map: shareMap,
        newest_first: !!row.newest_first,
      },
    };
  }
}

function projectPublicEntry(entry: any): Record<string, unknown> {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    story: entry.story,
    entry_date: entry.entry_date,
    entry_time: entry.entry_time,
    location_name: entry.location_name,
    location_lat: entry.location_lat,
    location_lng: entry.location_lng,
    mood: entry.mood,
    weather: entry.weather,
    tags: entry.tags ? JSON.parse(entry.tags) : [],
    pros_cons: entry.pros_cons ? JSON.parse(entry.pros_cons) : null,
  };
}

function projectPublicPhoto(photo: any): Record<string, unknown> {
  return {
    id: photo.id,
    entry_id: photo.entry_id,
    photo_id: photo.photo_id,
    caption: photo.caption,
    media_type: photo.media_type,
    duration_ms: photo.duration_ms,
    taken_at: photo.taken_at,
    lat: photo.lat,
    lng: photo.lng,
  };
}

function projectPublicGalleryPhoto(photo: any): Record<string, unknown> {
  return {
    id: photo.id,
    photo_id: photo.photo_id,
    caption: photo.caption,
    media_type: photo.media_type,
    duration_ms: photo.duration_ms,
    taken_at: photo.taken_at,
    lat: photo.lat,
    lng: photo.lng,
  };
}

/** Drop capture coordinates from a photo list, keeping everything else. */
function stripPhotoGps<T>(photos: T[] | undefined | null): T[] {
  return (photos ?? []).map(p => ({ ...(p as Record<string, unknown>), lat: null, lng: null })) as T[];
}
