import { isConfirmedAddressLocation, type ConfirmedAddressLocation } from '@/common/address-location';

export type InstallationAddress = {
  street: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  confirmedLocation?: ConfirmedAddressLocation;
};

// Únicamente la dirección de obra es pública; nunca la de salida ni los datos de ruta.
export function installationAddress(
  value: unknown,
): InstallationAddress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const keys = ['street', 'city', 'state', 'postalCode'] as const;
  if (
    keys.some(
      (key) => typeof source[key] !== 'string' || !String(source[key]).trim(),
    )
  )
    return null;
  // Older snapshots have no second line. Keep their shape unchanged.
  const detail = source.addressLine2;
  if (detail !== undefined && detail !== null &&
      (typeof detail !== 'string' || detail.trim().length > 150)) return null;
  const location = isConfirmedAddressLocation(source.confirmedLocation) ? source.confirmedLocation : undefined;
  if (source.confirmedLocation !== undefined && !location) return null;
  return {
    street: String(source.street).trim(),
    ...(detail !== undefined ? { addressLine2: typeof detail === 'string' ? detail.trim() || null : null } : {}),
    city: String(source.city).trim(),
    state: String(source.state).trim(),
    postalCode: String(source.postalCode).trim(),
    ...(location !== undefined ? { confirmedLocation: { lat: location.lat, lng: location.lng } } : {}),
  };
}
