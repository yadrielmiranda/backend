export type InstallationAddress = {
  street: string;
  city: string;
  state: string;
  postalCode: string;
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
  return Object.fromEntries(
    keys.map((key) => [key, String(source[key]).trim()]),
  ) as InstallationAddress;
}
