-- Add an optional rule without changing any existing estimate or payment.
ALTER TABLE `GlobalParameter`
  MODIFY `key` ENUM(
    'SALES_TAX',
    'ESTIMATE_VALID_DAYS',
    'INSTALLATION_DEPOSIT',
    'INSTALLATION_PERMIT_FEE',
    'CARD_SURCHARGE_PERCENT',
    'DELIVERY_BASE_PRICE',
    'DELIVERY_INCLUDED_MILES',
    'DELIVERY_ADDITIONAL_MILE_PRICE',
    'MATERIAL_ONLY_UPFRONT_THRESHOLD'
  ) NOT NULL;

INSERT INTO `GlobalParameter` (`key`, `value`, `description`, `unit`, `updatedAt`)
SELECT 'MATERIAL_ONLY_UPFRONT_THRESHOLD', 0,
  'Material-only upfront payment limit',
  'USD', CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (
  SELECT 1 FROM `GlobalParameter` WHERE `key` = 'MATERIAL_ONLY_UPFRONT_THRESHOLD'
);
