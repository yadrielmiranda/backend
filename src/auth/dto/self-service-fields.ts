// Lista explícita: agregar un campo administrativo nunca amplía el perfil público.
export const PROFILE_FIELDS = [
  'username', 'firstName', 'lastName', 'email', 'phone',
  'street', 'city', 'state', 'postalCode',
] as const;

export function pickProfileFields<T extends object>(value: T) {
  return Object.fromEntries(
    PROFILE_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(value, key))
      .map((key) => [key, value[key as keyof T]]),
  ) as Pick<T, Extract<keyof T, (typeof PROFILE_FIELDS)[number]>>;
}
