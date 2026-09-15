import { BadRequestException } from '@nestjs/common';
import type { Estimate, User } from '@prisma/client';

const customerFields = [
  ['customerFirstName', 'firstName', 'First name'],
  ['customerLastName', 'lastName', 'Last name'],
  ['customerEmail', 'email', 'Email'],
  ['customerPhone', 'phone', 'Phone'],
  ['customerStreet', 'street', 'Street address'],
  ['customerCity', 'city', 'City'],
  ['customerState', 'state', 'State'],
  ['customerPostalCode', 'postalCode', 'ZIP code'],
] as const;

type EstimateWithCustomer = Pick<
  Estimate,
  (typeof customerFields)[number][0]
> & {
  user: Pick<User, (typeof customerFields)[number][1]> & {
    role: { name: string };
  };
};

// Cotizar no requiere contacto. Se exige antes de comprometer el proyecto.
export function assertCompleteEstimateCustomer(
  estimate: EstimateWithCustomer,
  purpose: 'contract' | 'deposit' | 'dealer-measurements' | 'installation-payment',
) {
  const useEstimateCustomer = estimate.user.role.name === 'dealer';
  const missing = customerFields
    .filter(([estimateKey, userKey]) => {
      const value = useEstimateCustomer
        ? estimate[estimateKey]
        : estimate.user[userKey];
      return !value?.trim();
    })
    .map(([, , label]) => label);
  if (!missing.length) return;

  const source = useEstimateCustomer
    ? 'the customer details in the estimate'
    : 'your profile details';
  const action =
    purpose === 'contract'
      ? 'sharing with a contract'
      : purpose === 'dealer-measurements'
        ? 'accepting dealer measurements'
        : purpose === 'installation-payment'
          ? 'paying for this installation project'
        : 'paying the installation deposit';
  throw new BadRequestException(
    `Complete ${source} before ${action}. Missing: ${missing.join(', ')}.`,
  );
}
