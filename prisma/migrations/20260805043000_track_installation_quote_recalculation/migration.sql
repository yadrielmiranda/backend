ALTER TABLE `installation_quotes`
  ADD COLUMN `needsRecalculation` BOOLEAN NOT NULL DEFAULT false AFTER `total`;
