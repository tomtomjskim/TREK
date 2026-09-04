/**
 * Shared types + pure helpers for the public (read-only) journey share page.
 * No React, no side effects — safe to import from both the data hook and the
 * presentational page.
 */

export interface PublicEntry {
  id: number
  type?: string | null
  title?: string | null
  story?: string | null
  entry_date: string
  entry_time?: string | null
  location_name?: string | null
  location_lat?: number | null
  location_lng?: number | null
  mood?: string | null
  weather?: string | null
  tags?: string[]
  pros_cons?: { pros: string[]; cons: string[] } | null
  /** Omitted by the server's deliberately minimal map-only projection. */
  photos?: PublicPhoto[]
}

export interface PublicPhoto {
  id: number
  entry_id: number
  photo_id: number
  caption?: string | null
  // 'image' (default) or 'video' (#823)
  media_type?: string | null
  duration_ms?: number | null
  taken_at?: string | null
  lat?: number | null
  lng?: number | null
}

export interface PublicGalleryPhoto {
  id: number
  photo_id: number
  caption?: string | null
  // 'image' (default) or 'video' (#823)
  media_type?: string | null
  duration_ms?: number | null
  /** Where and when the picture was taken (#1614). Absent for most photos, and the
   *  coordinates are withheld entirely unless the owner shared the map. */
  taken_at?: string | null
  lat?: number | null
  lng?: number | null
}

export function groupByDate(entries: PublicEntry[]): Map<string, PublicEntry[]> {
  const groups = new Map<string, PublicEntry[]>()
  for (const e of entries) {
    const d = e.entry_date
    if (!groups.has(d)) groups.set(d, [])
    groups.get(d)!.push(e)
  }
  return groups
}
