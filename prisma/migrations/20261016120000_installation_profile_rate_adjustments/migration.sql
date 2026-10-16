-- Provider tariffs and existing quote/line amounts remain unchanged.
CREATE TABLE `installation_profile_rate_adjustments` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `profileId` INTEGER NOT NULL,
  `serviceId` INTEGER NOT NULL,
  `ruleId` INTEGER NULL,
  `targetKey` VARCHAR(50) NOT NULL,
  `type` ENUM('AMOUNT', 'PERCENT') NOT NULL,
  `value` DECIMAL(12,4) NOT NULL,
  `legacyLineRounding` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `installation_profile_rate_adjustments_profileId_targetKey_key` (`profileId`, `targetKey`),
  INDEX `installation_profile_rate_adjustments_serviceId_idx` (`serviceId`),
  INDEX `installation_profile_rate_adjustments_ruleId_idx` (`ruleId`),
  CONSTRAINT `installation_profile_rate_adjustments_profileId_fkey` FOREIGN KEY (`profileId`) REFERENCES `installation_price_profiles` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `installation_profile_rate_adjustments_serviceId_fkey` FOREIGN KEY (`serviceId`) REFERENCES `installation_services` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `installation_profile_rate_adjustments_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `installation_service_rules` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `installation_quotes`
  ADD COLUMN `profileRateAdjustmentsSnapshot` JSON NULL,
  ADD COLUMN `providerCostSnapshot` JSON NULL;

ALTER TABLE `installation_quote_lines`
  ADD COLUMN `saleRate` DECIMAL(18,4) NULL,
  ADD COLUMN `rateAdjustmentSnapshot` JSON NULL;

-- Expand every nonzero legacy profile percentage to independent service AND
-- rule entries, including inactive rows and negative legacy adjustments.
-- A selected rule uses only its own entry, never its service entry.
INSERT INTO `installation_profile_rate_adjustments`
  (`profileId`, `serviceId`, `ruleId`, `targetKey`, `type`, `value`, `legacyLineRounding`, `createdAt`, `updatedAt`)
SELECT p.`id`, s.`id`, NULL, CONCAT('SERVICE:', s.`id`), 'PERCENT', p.`adjustmentPercent`, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `installation_price_profiles` p CROSS JOIN `installation_services` s
WHERE p.`adjustmentPercent` <> 0;

INSERT INTO `installation_profile_rate_adjustments`
  (`profileId`, `serviceId`, `ruleId`, `targetKey`, `type`, `value`, `legacyLineRounding`, `createdAt`, `updatedAt`)
SELECT p.`id`, r.`serviceId`, r.`id`, CONCAT('RULE:', r.`id`), 'PERCENT', p.`adjustmentPercent`, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `installation_price_profiles` p CROSS JOIN `installation_service_rules` r
WHERE p.`adjustmentPercent` <> 0;

-- Historical quotes still have their original profileAdjustmentPercent and a
-- NULL rate-adjustments snapshot; their calculation stays on the legacy path.
UPDATE `installation_price_profiles` SET `adjustmentPercent` = 0;
