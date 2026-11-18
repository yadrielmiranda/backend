import type { ConfigService } from '@nestjs/config';

/** Restored production data and credentials must never send SMS from development/test. */
export function isSmsDeliveryEnabled(config: Pick<ConfigService, 'get'>): boolean {
  if (config.get<string>('NODE_ENV') !== 'production') return false;
  const enabled = config.get<string>('SMS_DELIVERY_ENABLED');
  return enabled === undefined || enabled === 'true';
}
