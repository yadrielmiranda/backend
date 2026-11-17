import type { ConfigService } from '@nestjs/config';

/** Local/test servers must never deliver mail, even with copied production credentials. */
export function isEmailDeliveryEnabled(config: Pick<ConfigService, 'get'>): boolean {
  if (config.get<string>('NODE_ENV') !== 'production') return false;
  const enabled = config.get<string>('EMAIL_DELIVERY_ENABLED');
  return enabled === undefined || enabled === 'true';
}
