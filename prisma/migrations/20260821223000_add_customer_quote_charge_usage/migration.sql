ALTER TABLE `estimate_customer_charges`
  MODIFY `pricingMode` ENUM('SAME', 'PERCENTAGE', 'AMOUNT', 'FINAL') NOT NULL,
  ADD COLUMN `usedInCustomerQuote` BOOLEAN NOT NULL DEFAULT true AFTER `pricingValue`;
