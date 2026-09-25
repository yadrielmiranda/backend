-- Configuración independiente de precios, cuotas y registro público.
ALTER TABLE `User`
  ADD COLUMN `dealerEarningsType` ENUM('FULL_MARKUP', 'EXPECTED_PROFIT_PERCENT', 'REAL_PROFIT_PERCENT') NOT NULL DEFAULT 'FULL_MARKUP',
  ADD COLUMN `dealerEarningsPercent` DECIMAL(7, 4) NULL;

ALTER TABLE `Estimate` ADD COLUMN `dealerEarningsPlanSnapshot` JSON NULL;

-- Las operaciones existentes conservan el margen completo que mostraban antes.
UPDATE `Estimate`
SET `dealerEarningsPlanSnapshot` = JSON_OBJECT('version', 1, 'type', 'FULL_MARKUP', 'percent', NULL)
WHERE `dealerModeSnapshot` = 'INTERNAL';
