export type ConfirmedAddressLocation = { lat: number; lng: number };

export function isConfirmedAddressLocation(value: unknown): value is ConfirmedAddressLocation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return typeof point.lat === 'number' && Number.isFinite(point.lat) &&
    point.lat >= -90 && point.lat <= 90 &&
    typeof point.lng === 'number' && Number.isFinite(point.lng) &&
    point.lng >= -180 && point.lng <= 180;
}
