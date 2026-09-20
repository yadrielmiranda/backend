import { GlobalParameterKey } from '@prisma/client';

// Se conservan las claves existentes como única fuente de las tarifas.
export const DELIVERY_PARAMETER_KEYS: GlobalParameterKey[] = [
  GlobalParameterKey.DELIVERY_BASE_PRICE,
  GlobalParameterKey.DELIVERY_INCLUDED_MILES,
  GlobalParameterKey.DELIVERY_ADDITIONAL_MILE_PRICE,
];
