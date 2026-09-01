/**
 * The deliberately small, anonymous response contract for GET /api/shared/:token.
 * These types are not reused by authenticated trip APIs: adding a field here is a
 * privacy review decision, not a convenience projection.
 */
export interface PublicSharedTrip {
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  cover_image: string | null;
  currency: string | null;
}

export interface PublicSharePermissions {
  share_map: boolean;
  share_bookings: boolean;
  share_packing: boolean;
  share_budget: boolean;
  share_collab: boolean;
}

export interface PublicSharedDay {
  id: number;
  day_number: number;
  title: string | null;
  date: string | null;
}

export interface PublicSharedCategory {
  id: number;
  color: string | null;
}

export interface PublicSharedPlaceCategory {
  color: string | null;
  icon: string | null;
}

/** `notes` is required-nullable: it is a trip-shared place field. */
export interface PublicSharedAssignedPlace {
  id: number;
  name: string;
  description: string | null;
  lat: number | null;
  lng: number | null;
  address: string | null;
  category_id: number | null;
  place_time: string | null;
  end_time: string | null;
  image_url: string | null;
  notes: string | null;
  category: PublicSharedPlaceCategory | null;
}

export interface PublicSharedAssignment {
  id: number;
  order_index: number;
  place: PublicSharedAssignedPlace;
}

export interface PublicSharedMapPlace {
  id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  category_color: string | null;
  category_icon: string | null;
  notes: string | null;
}

export interface PublicSharedDayNote {
  id: number;
  sort_order: number;
  text: string;
  time: string | null;
}

type PublicMetadataScalar = string | number | boolean | null;
export interface PublicSharedReservationMetadata {
  airline?: PublicMetadataScalar;
  flight_number?: PublicMetadataScalar;
  departure_airport?: PublicMetadataScalar;
  arrival_airport?: PublicMetadataScalar;
  train_number?: PublicMetadataScalar;
  platform?: PublicMetadataScalar;
  legs?: Array<{
    from?: PublicMetadataScalar;
    to?: PublicMetadataScalar;
    airline?: PublicMetadataScalar;
    flight_number?: PublicMetadataScalar;
    train_number?: PublicMetadataScalar;
    platform?: PublicMetadataScalar;
    dep_day_id?: PublicMetadataScalar;
    dep_time?: PublicMetadataScalar;
    arr_day_id?: PublicMetadataScalar;
    arr_time?: PublicMetadataScalar;
    day_positions?: Record<string, number>;
  }>;
}

export interface PublicSharedReservation {
  id: number;
  type: string | null;
  title: string;
  status: string | null;
  reservation_time: string | null;
  reservation_end_time: string | null;
  location: string | null;
  metadata: PublicSharedReservationMetadata;
  assignment_id: number | null;
  day_id: number | null;
  end_day_id: number | null;
  day_positions: Record<number, number> | null;
  day_plan_position: number | null;
}

export interface PublicSharedAccommodation {
  id: number;
  start_day_id: number;
  end_day_id: number;
  place_name: string | null;
}

export interface PublicSharedPackingItem {
  id: number;
  category: string | null;
  name: string;
  checked: number | boolean;
}

export interface PublicSharedBudgetItem {
  id: number;
  category: string;
  name: string;
  total_price: number;
  currency: string | null;
}

export interface PublicSharedCollabMessage {
  id: number;
  username: string | null;
  avatar: string | null;
  created_at: string | null;
  text: string;
}

export interface PublicSharedTripData {
  trip: PublicSharedTrip;
  baseCurrency: string;
  /** Compatibility root key. Anonymous shares never receive an owner credential. */
  cartoApiKey: '';
  categories: PublicSharedCategory[];
  permissions: PublicSharePermissions;
  days: PublicSharedDay[];
  assignments: Record<number, PublicSharedAssignment[]>;
  dayNotes: Record<number, PublicSharedDayNote[]>;
  places: PublicSharedMapPlace[];
  reservations: PublicSharedReservation[];
  accommodations: PublicSharedAccommodation[];
  packing: PublicSharedPackingItem[];
  budget: PublicSharedBudgetItem[];
  collab: PublicSharedCollabMessage[];
}
